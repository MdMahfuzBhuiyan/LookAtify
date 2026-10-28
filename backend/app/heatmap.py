"""Heatmap rendering: normalization, blur, colormaps and overlay compositing.

Colormaps are implemented directly on numpy so the server and the browser
viewer can share the same colour vocabulary (Jet, Turbo, Viridis, Hot and a
colour-blind-safe option) without shipping a large lookup table.
"""

from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image

#: Anchor colours for each colormap, from low attention to high attention.
#: Each anchor is (red, green, blue) in 0..255.
_COLORMAP_ANCHORS: dict[str, list[tuple[int, int, int]]] = {
    # Green -> yellow -> red (the default "Jet-like" look from the brief).
    "jet": [
        (0, 104, 55),
        (40, 190, 90),
        (220, 220, 40),
        (240, 150, 30),
        (220, 40, 30),
    ],
    # Modern perceptually ordered Turbo ramp.
    "turbo": [
        (48, 18, 59),
        (70, 107, 227),
        (42, 199, 196),
        (151, 224, 58),
        (250, 166, 30),
        (190, 30, 45),
    ],
    # Viridis: dark blue -> teal -> green -> yellow.
    "viridis": [
        (68, 1, 84),
        (59, 82, 139),
        (33, 145, 140),
        (94, 201, 98),
        (253, 231, 37),
    ],
    # Hot: black -> red -> yellow -> white.
    "hot": [
        (0, 0, 0),
        (140, 0, 0),
        (220, 70, 0),
        (255, 170, 0),
        (255, 255, 210),
    ],
    # Colour-blind-safe: blue -> teal -> yellow (avoids red/green confusion).
    "colorblind": [
        (12, 44, 92),
        (24, 110, 145),
        (60, 170, 160),
        (215, 205, 90),
        (250, 245, 175),
    ],
}

DEFAULT_COLORMAP = "jet"


def normalise(values: np.ndarray) -> np.ndarray:
    """Scale an array to 0..1.

    A constant array has no structure to show, but it does carry information:
    the attention is spread evenly. Such a map is returned as a uniform
    mid-grey rather than as zeros, which would mean "no attention at all".
    """
    values = np.asarray(values, dtype=np.float32)
    minimum = float(values.min())
    maximum = float(values.max())
    if maximum - minimum < 1e-12:
        return np.full_like(values, 0.5, dtype=np.float32)
    return ((values - minimum) / (maximum - minimum)).astype(np.float32)


def normalise_to_probability(values: np.ndarray) -> np.ndarray:
    """Convert a log-density map into a probability distribution that sums to 1.

    The normaliser is the full ``logsumexp`` of the map, not the maximum
    value. Subtracting only the maximum underflows every other pixel to zero
    when the map has a large dynamic range, which silently destroys the
    saliency signal.
    """
    values = np.asarray(values, dtype=np.float64)
    maximum = float(values.max())
    exponentials = np.exp(values - maximum)
    total = float(exponentials.sum())
    if total <= 0 or not np.isfinite(total):
        return np.full(values.shape, 1.0 / values.size, dtype=np.float64)
    # logsumexp(values) = maximum + log(sum(exp(values - maximum)))
    log_normaliser = maximum + float(np.log(total))
    return np.exp(values - log_normaliser).astype(np.float64)


def normalise_for_display(values: np.ndarray) -> np.ndarray:
    """Stretch a saliency map onto 0..1 for display.

    A min-max stretch is the wrong tool here. A saliency map is very
    peaked: almost every pixel sits near the bottom of the range and only a
    handful reach the top. Scaling those few pixels over the whole range
    leaves the rest of the page at a near-zero value, which the viewer
    paints as a faint, almost transparent wash because its alpha follows
    the intensity.

    A percentile stretch instead maps the bulk of the map onto the visible
    part of the colormap and reserves the top of the range for the genuine
    hotspots.

    The high percentile is 99 rather than 99.5. The top half percent of a
    long page holds a handful of pixels, and one of them can be an
    artefact; with 99.5 the whole page was scaled down so far that the
    hotspots of several bands of the page stayed below the yellow part of
    the colormap, and those bands looked empty.

    The low end is *not* hard-clipped to zero. Clipping draws a contour
    where the intensity crosses the percentile, and that contour shows up in
    the viewer as a faint horizontal band across the page. A soft curve
    keeps the transition smooth, so no row jumps.
    """
    values = np.asarray(values, dtype=np.float32)
    if values.size == 0:
        return values

    low = float(np.percentile(values, 10.0))
    high = float(np.percentile(values, 99.0))
    span = high - low
    if span < 1e-12:
        # A flat map has no structure to show, but it is not "no attention".
        return np.full_like(values, 0.5, dtype=np.float32)

    scaled = (values - low) / span
    # A softplus keeps the bottom of the range continuous instead of
    # flattening it to zero, so no contour appears. The steepness decides
    # how much of the background lights up: a steeper curve leaves more of
    # it transparent while still letting the hotspots reach the top.
    softened = np.log1p(np.exp(np.clip(scaled * 12.0, -30.0, 30.0))) / 12.0
    return np.clip(softened, 0.0, 1.0).astype(np.float32)


def apply_threshold(values: np.ndarray, threshold: float) -> np.ndarray:
    """Zero out intensities below ``threshold`` (0..1)."""
    if threshold <= 0:
        return values
    return np.where(values < threshold, 0.0, values).astype(np.float32)


def blur(values: np.ndarray, sigma: float) -> np.ndarray:
    """Apply a Gaussian blur; ``sigma <= 0`` returns the input unchanged."""
    if sigma <= 0:
        return values
    from scipy.ndimage import gaussian_filter

    return gaussian_filter(values.astype(np.float32), sigma=float(sigma), mode="nearest")


def _interpolate_anchors(anchors: list[tuple[int, int, int]], positions: np.ndarray) -> np.ndarray:
    """Linearly interpolate anchor colours at the given 0..1 positions."""
    anchor_positions = np.linspace(0.0, 1.0, len(anchors))
    channels = [np.array([a[channel] for a in anchors], dtype=np.float32) for channel in range(3)]
    out = np.zeros((*positions.shape, 3), dtype=np.float32)
    for channel, values in enumerate(channels):
        out[..., channel] = np.interp(positions, anchor_positions, values)
    return out


def colormap(values: np.ndarray, name: str = DEFAULT_COLORMAP) -> np.ndarray:
    """Map 0..1 intensities to RGB.

    :param values: array of intensities in 0..1.
    :param name: one of jet, turbo, viridis, hot, colorblind.
    :returns: uint8 array shaped ``values.shape + (3,)``.
    """
    anchors = _COLORMAP_ANCHORS.get((name or DEFAULT_COLORMAP).lower(), _COLORMAP_ANCHORS[DEFAULT_COLORMAP])
    positions = np.clip(np.asarray(values, dtype=np.float32), 0.0, 1.0)
    return _interpolate_anchors(anchors, positions).astype(np.uint8)


def colormap_with_alpha(values: np.ndarray, name: str = DEFAULT_COLORMAP) -> np.ndarray:
    """Map intensities to RGBA with an alpha ramp so low attention fades out.

    :param values: array of intensities in 0..1.
    :param name: colormap name.
    :returns: uint8 RGBA array shaped ``values.shape + (4,)``.
    """
    positions = np.clip(np.asarray(values, dtype=np.float32), 0.0, 1.0)
    rgb = colormap(positions, name)
    # Alpha follows the intensity: fully transparent at 0, fully opaque at 1.
    alpha = np.clip(positions * 255.0, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])
    return rgba


def composite(
    original: np.ndarray,
    heatmap_rgba: np.ndarray,
    opacity: float = 0.55,
) -> np.ndarray:
    """Blend the heatmap over the original screenshot.

    :param original: RGB uint8 array.
    :param heatmap_rgba: RGBA uint8 array of the same height and width.
    :param opacity: global multiplier in 0..1 applied to the heatmap alpha.
    :returns: RGB uint8 array.
    """
    if original.shape[:2] != heatmap_rgba.shape[:2]:
        raise ValueError("original and heatmap must have the same dimensions")

    opacity = float(np.clip(opacity, 0.0, 1.0))
    heatmap_rgb = heatmap_rgba[:, :, :3].astype(np.float32)
    alpha = heatmap_rgba[:, :, 3].astype(np.float32) / 255.0 * opacity
    base = original[:, :, :3].astype(np.float32)

    blended = base * (1.0 - alpha[..., None]) + heatmap_rgb * alpha[..., None]
    return np.clip(blended, 0, 255).astype(np.uint8)


def to_png_bytes(array: np.ndarray) -> bytes:
    """Encode an array as PNG bytes.

    Accepts ``(H, W)`` grayscale, ``(H, W, 3)`` RGB or ``(H, W, 4)`` RGBA.
    """
    if array.ndim == 2:
        image = Image.fromarray(array.astype(np.uint8), mode="L")
    elif array.ndim == 3 and array.shape[2] in (3, 4):
        mode = "RGB" if array.shape[2] == 3 else "RGBA"
        image = Image.fromarray(array.astype(np.uint8), mode=mode)
    else:
        raise ValueError("array must be shaped (H, W), (H, W, 3) or (H, W, 4)")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def to_base64_png(array: np.ndarray) -> str:
    """Encode an RGB/RGBA uint8 array as a base64 PNG string."""
    return base64.b64encode(to_png_bytes(array)).decode("ascii")


def available_colormaps() -> list[str]:
    """List the supported colormap names."""
    return list(_COLORMAP_ANCHORS.keys())
