"""The analysis pipeline: preprocess → infer → postprocess.

A full-page screenshot can be 6,000+ pixels tall, which is far beyond what a
saliency model can consume in one pass. The pipeline therefore:

1. scales the page down so its width fits the inference width,
2. splits it into overlapping vertical tiles,
3. runs inference per tile,
4. blends the overlaps with feathered weights in probability space,
5. rescales the result back to the exact original screenshot dimensions so the
   overlay lines up pixel-perfectly.
"""

from __future__ import annotations

import io
import logging
import time
import uuid
from dataclasses import dataclass

import numpy as np
from PIL import Image

from .analytics import compute_stats, find_peaks
from .config import Settings
from .heatmap import (
    blur,
    colormap_with_alpha,
    composite,
    normalise_for_display,
    normalise_to_probability,
    to_base64_png,
)
from .model import ModelUnavailableError, SaliencyModel
from .schemas import AnalyzeOptions, AnalyzeResponse, TimingMs

logger = logging.getLogger("lookatify.pipeline")

#: The DeepGaze readout grid advances in steps of 32 pixels: the model
#: downsamples the input by 2 and the backbones downsample by 16 more. A tile
#: whose size is not a multiple of 32 leaves a partially covered feature cell
#: at the border, which shows up as a bright line along the tile edge. Tile
#: dimensions are padded to this stride and the padding is cropped away again.
MODEL_STRIDE = 32

#: The model is trained on short, wide images, so a very long page is fed to
#: it as a tall, very narrow strip. On such a strip the response over the
#: middle of the page collapses, and the profile built from it is far
#: steeper than the page really is.
#:
#: The profile is flattened when it is steeper than this, so that the middle
#: of a long page keeps its hotspots.
PROFILE_STEEPNESS_LIMIT = 1.6

#: The number of horizontal bands the profile's steepness is measured over.
PROFILE_BANDS = 10


def _align_up(value: int, multiple: int) -> int:
    """Round ``value`` up to the next multiple of ``multiple``."""
    return int(np.ceil(value / multiple) * multiple)


@dataclass
class Tile:
    """One tile of a page, in working-image pixel coordinates."""

    index: int
    top: int
    bottom: int
    left: int
    right: int

    @property
    def height(self) -> int:
        return self.bottom - self.top

    @property
    def width(self) -> int:
        return self.right - self.left


class AnalysisPipeline:
    """Turns an uploaded screenshot into saliency, heatmap and statistics."""

    def __init__(self, model: SaliencyModel | None, settings: Settings) -> None:
        self.model = model
        self.settings = settings

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    def analyze(self, image_bytes: bytes, options: AnalyzeOptions) -> AnalyzeResponse:
        """Run the full pipeline for one uploaded screenshot."""
        if self.model is None or self.model.model is None:
            raise ModelUnavailableError("The saliency model is not loaded.")

        started = time.perf_counter()

        image, original_size = self._decode(image_bytes)
        preprocessed = time.perf_counter()

        tiles, tile_images, scale = self._plan_tiles(image)
        inference_started = time.perf_counter()
        tile_probabilities = [self._infer_tile(tile_image) for tile_image in tile_images]
        # A second, cheap pass over the whole page. The model normalises
        # every image it sees to sum to one, so the tiles on their own cannot
        # say which part of the page attracts more attention. The coarse pass
        # sees the page as one image and supplies that global profile.
        coarse_profile = self._coarse_profile(image)
        inference_done = time.perf_counter()

        detail = self._blend_tiles(tile_probabilities, tiles, original_size, scale)

        # The statistics keep the whole-page profile, so the ranking of the
        # bands describes the real distribution of attention.
        intensity = detail
        if coarse_profile is not None:
            intensity = self._apply_global_profile(intensity, coarse_profile)

        # The display map flattens the profile when it is far too steep. On a
        # very long page the coarse pass sees a tall, narrow strip, which the
        # model handles badly: the profile it returns is much steeper than
        # the page really is, and multiplying the detail with it crushes every
        # hotspot in the middle of the page below the visible part of the
        # colormap. The flattening is monotone, so the bands keep their
        # ranking and the statistics stay the same.
        display_intensity = intensity
        if coarse_profile is not None:
            display_profile = self._compress_profile(
                coarse_profile, PROFILE_STEEPNESS_LIMIT
            )
            display_intensity = self._apply_global_profile(detail, display_profile)

        heatmap_rgba, probability, display = self._render(
            intensity, options, display_saliency=display_intensity
        )

        top_points = find_peaks(probability, top_n=options.top_n)
        stats = compute_stats(probability, fold_height=self.settings.fold_height)

        composite_b64: str | None = None
        if options.return_composite:
            composite_b64 = to_base64_png(composite(image, heatmap_rgba, options.opacity))

        finished = time.perf_counter()
        timing = TimingMs(
            preprocess=int((preprocessed - started) * 1000),
            inference=int((inference_done - inference_started) * 1000),
            postprocess=int((finished - inference_done) * 1000),
            total=int((finished - started) * 1000),
        )

        warnings: list[str] = []
        if scale < 1.0:
            warnings.append(
                f"The page was scaled to {scale:.0%} for inference, so very small "
                "details may be smoothed out."
            )
        if len(tiles) > 1:
            warnings.append(
                f"This page was analysed as {len(tiles)} tiles. The global attention "
                "profile comes from a separate pass over the whole page, so the shares "
                "below compare regions of the page, not tiles."
            )

        return AnalyzeResponse(
            analysis_id=uuid.uuid4().hex,
            width=original_size[0],
            height=original_size[1],
            # The viewer re-colours this grayscale map itself and takes the
            # alpha from the intensity, so it has to carry the stretched
            # values. The raw probabilities would paint as a pale wash.
            saliency_png_base64=to_base64_png((display * 255).astype(np.uint8)),
            heatmap_png_base64=to_base64_png(heatmap_rgba),
            composite_png_base64=composite_b64,
            top_points=top_points,
            stats=stats,
            timing_ms=timing,
            warnings=warnings,
        )

    # ------------------------------------------------------------------
    # preprocessing
    # ------------------------------------------------------------------
    def _decode(self, image_bytes: bytes) -> tuple[np.ndarray, tuple[int, int]]:
        """Decode the upload into an RGB array plus its original size."""
        try:
            with Image.open(io.BytesIO(image_bytes)) as image:
                image = image.convert("RGB")
                original_size = (int(image.width), int(image.height))
                array = np.array(image)
        except Exception as exc:
            raise ValueError(f"The uploaded image could not be decoded: {exc}") from exc
        return array, original_size

    def _plan_tiles(self, image: np.ndarray) -> tuple[list[Tile], list[np.ndarray], float]:
        """Decide how to split the page and return the tiles to run.

        The page is scaled so its width fits the inference width, then sliced
        vertically with an overlap. Every tile spans the full width, so the
        blended result always covers the whole page.

        :returns: ``(tiles, tile_images, scale)``.
        """
        height, width = image.shape[:2]
        max_side = self.settings.max_inference_side
        strategy = self.settings.long_page_strategy.lower()

        if strategy == "downscale":
            longest = max(height, width)
            scale = max_side / longest if longest > max_side else 1.0
            working = self._resize(image, scale)
            tile = Tile(index=0, top=0, bottom=working.shape[0], left=0, right=working.shape[1])
            return [tile], [working], scale

        scale = 1.0
        working = image
        if width > max_side:
            scale = max_side / width
            working = self._resize(image, scale)

        working_height, working_width = working.shape[:2]
        tile_height = max(128, min(self.settings.tile_height, max_side))
        overlap = max(0, min(self.settings.tile_overlap, tile_height // 2))
        step = max(1, tile_height - overlap)

        tiles: list[Tile] = []
        index = 0
        top = 0
        while True:
            bottom = min(working_height, top + tile_height)
            tiles.append(
                Tile(index=index, top=top, bottom=bottom, left=0, right=working_width)
            )
            if bottom >= working_height:
                break
            index += 1
            top += step

        tile_images = [working[tile.top : tile.bottom, tile.left : tile.right] for tile in tiles]
        return tiles, tile_images, scale

    @staticmethod
    def _resize(image: np.ndarray, scale: float) -> np.ndarray:
        """Resize an RGB array by ``scale`` using high-quality Lanczos."""
        if abs(scale - 1.0) < 1e-6:
            return image
        height, width = image.shape[:2]
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        with Image.fromarray(image, mode="RGB") as source:
            return np.array(source.resize(new_size, Image.LANCZOS))

    # ------------------------------------------------------------------
    # inference
    # ------------------------------------------------------------------
    def _infer_tile(self, tile_image: np.ndarray) -> np.ndarray:
        """Run the model on one tile and return its log-density map.

        Two artefacts have to be handled:

        1. The readout grid advances in steps of 32 pixels, so a tile whose
           size is not a multiple of 32 leaves a partially covered feature
           cell at the border. That cell accumulates probability and shows up
           as a bright line along the tile edge.
        2. The model itself has a border bias: on a featureless image the
           outermost columns receive roughly twice the median attention.
           Reflecting the content into a border of one stride removes it.

        Both are handled by padding the tile and cropping the padding away
        again, so the result stays aligned with the original pixels.
        """
        reflected = np.pad(
            tile_image,
            ((MODEL_STRIDE, MODEL_STRIDE), (MODEL_STRIDE, MODEL_STRIDE), (0, 0)),
            mode="reflect",
        )
        padded_height = _align_up(reflected.shape[0], MODEL_STRIDE)
        padded_width = _align_up(reflected.shape[1], MODEL_STRIDE)
        padded = np.pad(
            reflected,
            (
                (0, padded_height - reflected.shape[0]),
                (0, padded_width - reflected.shape[1]),
                (0, 0),
            ),
            mode="edge",
        )
        logits = self.model.predict(padded)
        return logits[
            MODEL_STRIDE : MODEL_STRIDE + tile_image.shape[0],
            MODEL_STRIDE : MODEL_STRIDE + tile_image.shape[1],
        ]

    def _blend_tiles(
        self,
        tile_logits: list[np.ndarray],
        tiles: list[Tile],
        original_size: tuple[int, int],
        scale: float = 1.0,
    ) -> np.ndarray:
        """Blend tile outputs into one 0..1 map at the original resolution.

        Each tile's log density is converted to a probability distribution
        (so tiles are directly comparable), then overlaps are combined with a
        linear feathered weight ramp so no seam appears between tiles.

        :param scale: factor applied to the page before inference. Tile
                      coordinates are working-image pixels, so they are mapped
                      back to original-image pixels with this factor.
        """
        width, height = original_size
        scale = scale if scale > 0 else 1.0

        if len(tiles) == 1:
            probability = normalise_to_probability(tile_logits[0])
            return self._resize_float(probability, (height, width)).astype(np.float32)

        accumulated = np.zeros((height, width), dtype=np.float64)
        weights = np.zeros((height, width), dtype=np.float64)
        last_index = len(tiles) - 1

        for tile, logit in zip(tiles, tile_logits, strict=False):
            tile_probability = normalise_to_probability(logit)

            # Map the tile's working-image bounds back to original pixels.
            y0 = max(0, round(tile.top / scale))
            x0 = max(0, round(tile.left / scale))
            y1 = min(height, round(tile.bottom / scale))
            x1 = min(width, round(tile.right / scale))
            if y1 <= y0 or x1 <= x0:
                continue

            resized = self._resize_float(tile_probability, (y1 - y0, x1 - x0))
            weight = self._feather_weight(y1 - y0, x1 - x0, tile, last_index)

            accumulated[y0:y1, x0:x1] += resized[: y1 - y0, : x1 - x0] * weight[
                : y1 - y0, : x1 - x0
            ]
            weights[y0:y1, x0:x1] += weight[: y1 - y0, : x1 - x0]

        blended = np.divide(
            accumulated,
            weights,
            out=np.zeros_like(accumulated),
            where=weights > 1e-8,
        )
        # The blended map stays in probability space. Stretching it here
        # would destroy the relative weights between the tiles, which is
        # exactly what the global profile is there to restore.
        return blended.astype(np.float32)

    def _coarse_profile(self, image: np.ndarray) -> np.ndarray | None:
        """Run one cheap pass over the whole page to get the global profile.

        The saliency model normalises every image it sees so that its output
        sums to one. That is the right behaviour for a photograph, but it
        means a per-tile pass cannot say "this band of the page attracts more
        attention than that band": every tile ends up carrying exactly the
        same mass, no matter how interesting its content is. Blending those
        tiles therefore produces a page that is lit evenly from top to
        bottom, which is what made the attention statistics useless.

        A second pass over the whole page at a much lower resolution sees the
        page as one image, so its output does carry the global profile. The
        result is stretched back to the page dimensions and used to scale the
        per-tile detail.

        :param image: the original page as an RGB uint8 array.
        :returns: a 0..1 map at the page's dimensions, or ``None`` when the
            coarse pass is disabled or not worth running.
        """
        side = int(self.settings.coarse_inference_side)
        if side <= 0:
            return None

        height, width = image.shape[:2]
        long_side = max(height, width)
        if long_side <= side:
            # The page already fits in one pass; the tiles carry everything.
            return None

        scale = side / long_side
        small = self._resize(image, scale)
        logits = self._infer_tile(small)
        probability = normalise_to_probability(logits)
        return self._resize_float(probability, (height, width))

    @staticmethod
    def _apply_global_profile(intensity: np.ndarray, profile: np.ndarray) -> np.ndarray:
        """Scale the per-tile detail by the global attention profile.

        The tiles know *where* the attention is inside each band of the
        page, but not *how much* attention the band deserves. The coarse
        pass knows the second part, but not the first. Multiplying the two
        combines them: a hotspot inside a band that the coarse pass says is
        dull keeps its position but shrinks, and a band the coarse pass says
        is interesting lights up all of its own hotspots.

        The profile is used as it is for the statistics. The display map may
        use a flattened copy of it, because a profile that is far too steep
        crushes the local hotspots of the bands it judges dull. See
        :meth:`_compress_profile`.
        """
        detail = np.asarray(intensity, dtype=np.float64)
        weights = np.asarray(profile, dtype=np.float64)

        if detail.shape != weights.shape:
            return detail.astype(np.float32)

        combined = detail * np.clip(weights, 0.0, None)
        total = float(combined.sum())
        if total <= 0:
            return detail.astype(np.float32)
        return (combined / total).astype(np.float32)

    @staticmethod
    def _profile_steepness(profile: np.ndarray) -> float:
        """How much stronger the strongest band of the profile is.

        The page is split into horizontal bands and the strongest band is
        compared with the weakest one. A ratio of one means the profile
        treats every band of the page the same.
        """
        height = profile.shape[0]
        band_height = max(1, height // PROFILE_BANDS)
        maxima = []
        for index in range(PROFILE_BANDS):
            top = index * band_height
            bottom = min(height, top + band_height)
            if top >= bottom:
                break
            maxima.append(float(profile[top:bottom].max()))
        if not maxima:
            return 1.0
        low = float(min(maxima))
        if low <= 0:
            return 1.0
        return float(max(maxima)) / low

    @staticmethod
    def _compress_profile(profile: np.ndarray, limit: float) -> np.ndarray:
        """Flatten a profile that is steeper than ``limit``.

        The profile decides how much attention each band of the page
        deserves. When it is very steep, a band with real content can be
        multiplied down so far that its hotspots fall below the visible part
        of the colormap, and the middle of a long page ends up blank.

        The profile is raised to a power, which flattens it. A power is
        monotone, so the ranking of the bands does not change: the
        statistics and the top attention points still describe the same
        page. A profile that is not steeper than the limit is returned
        unchanged, so a page that already works cannot get worse.

        :param limit: the steepest profile that is left alone.
        :returns: the profile to multiply the detail with.
        """
        values = np.asarray(profile, dtype=np.float64)
        steepness = AnalysisPipeline._profile_steepness(values)

        if steepness <= limit or steepness <= 1.0:
            return values

        # The power that brings the steepness down to the limit.
        exponent = float(np.log(limit) / np.log(steepness))
        maximum = float(values.max()) or 1.0
        return (values / maximum) ** exponent

    @staticmethod
    def _feather_weight(height: int, width: int, tile: Tile, last_index: int) -> np.ndarray:
        """Linear weight ramp that fades a tile in and out at its edges.

        Only interior edges fade: the first tile has no predecessor and the
        last tile has no successor, so their outer edges keep full weight.
        """
        weight = np.ones((height, width), dtype=np.float64)
        fade = min(height // 2, 64)

        if tile.index > 0 and fade > 0:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float64)[:, None]
            weight[:fade, :] *= ramp

        if tile.index < last_index and fade > 0:
            ramp = np.linspace(1.0, 0.0, fade, dtype=np.float64)[:, None]
            weight[-fade:, :] *= ramp

        return weight

    @staticmethod
    def _resize_float(values: np.ndarray, size: tuple[int, int]) -> np.ndarray:
        """Resize a float array to ``(height, width)`` using bilinear filtering."""
        target_height, target_width = size
        if values.shape[0] == target_height and values.shape[1] == target_width:
            return values.astype(np.float64)

        with Image.fromarray(values.astype(np.float32), mode="F") as source:
            resized = source.resize((target_width, target_height), Image.BILINEAR)
        return np.array(resized, dtype=np.float64)

    # ------------------------------------------------------------------
    # rendering
    # ------------------------------------------------------------------
    def _render(self, saliency: np.ndarray, options: AnalyzeOptions, display_saliency=None):
        """Turn the saliency map into an RGBA heatmap and a probability map.

        The probability map is the same intensity renormalised to sum to 1,
        so the statistics describe exactly what the heatmap shows. The third
        return value is the display map: the viewer re-colours the saliency
        PNG itself, and its alpha follows the intensity, so that PNG has to
        carry the stretched values or the heatmap is a pale wash.

        The display map may differ from the probability map. The probability
        map keeps the whole-page profile, so the statistics describe the real
        distribution of attention. The display map may flatten that profile,
        so that a band of the page with real content keeps a visible hotspot
        instead of being multiplied down into invisibility.
        """
        blurred = blur(saliency, options.blur_sigma)

        total = float(blurred.sum())
        if total <= 0:
            probability = np.full(blurred.shape, 1.0 / blurred.size, dtype=np.float64)
        else:
            probability = (blurred / total).astype(np.float64)

        # The heatmap is painted from a stretched copy of the intensity, so
        # the colours and the alpha ramp use the whole range. The probability
        # map keeps the unstretched values, so the statistics still describe
        # the real distribution of attention.
        source = blurred if display_saliency is None else display_saliency
        display = normalise_for_display(source)
        heatmap_rgba = colormap_with_alpha(display, options.colormap)
        return heatmap_rgba, probability, display
