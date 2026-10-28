#!/usr/bin/env python3
"""Test whether the model can compare tiles on one common scale.

The model normalises every image it sees so that its output sums to one, so
two tiles of the same page always carry the same mass and cannot be
compared. The coarse whole-page pass was meant to supply that comparison, but
it runs on a very tall, very narrow strip that is far outside the model's
training distribution, so it starves the middle of the page.

The finaliser normalises with ``out - out.logsumexp(...)``. The map *before*
that line still holds the absolute density, so the same inference can give
both the shape inside a tile and the tile's own total density. Comparing the
absolute densities is then a direct comparison between the tiles, with no
extra pass over the page.

This script measures whether the absolute density actually separates the
tiles of a real page.

Usage:
    python scripts/experiment-absolute-density.py [--page /tmp/page.png]
"""

from __future__ import annotations

import argparse
import pickle
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from app.config import Settings  # noqa: E402
from app.model import SaliencyModel  # noqa: E402
from app.pipeline import MODEL_STRIDE, AnalysisPipeline, _align_up  # noqa: E402

CACHE = Path("/tmp/lookatify-raw-tiles.pkl")
BANDS = 10


def _finalise_without_normalisation(
    finalizer,
    readout: torch.Tensor,
    centerbias_tensor: torch.Tensor,
) -> torch.Tensor:
    """Reproduce the finaliser without its last line, the normalisation.

    The finaliser ends with ``out = out - out.logsumexp(...)``. Everything
    before that line still holds the absolute density of the image.
    """
    import torch.nn.functional as F

    # The centre bias arrives as (batch, height, width); the finaliser
    # treats it as (batch, 1, height, width).
    downscaled_centerbias = F.interpolate(
        centerbias_tensor.view(
            centerbias_tensor.shape[0],
            1,
            centerbias_tensor.shape[1],
            centerbias_tensor.shape[2],
        ),
        scale_factor=1 / finalizer.saliency_map_factor,
        recompute_scale_factor=False,
    )[:, 0, :, :]

    out = F.interpolate(
        readout, size=[downscaled_centerbias.shape[1], downscaled_centerbias.shape[2]]
    )
    out = finalizer.gauss(out)
    out = out[:, 0, :, :]
    out = out + finalizer.center_bias_weight * downscaled_centerbias
    out = F.interpolate(
        out[:, np.newaxis, :, :],
        size=[centerbias_tensor.shape[1], centerbias_tensor.shape[2]],
    )[:, 0, :, :]
    return out


def _raw_density(model: SaliencyModel, tensor: torch.Tensor, centerbias_tensor: torch.Tensor):
    """Run the model and return the density before the normalisation."""
    import torch.nn.functional as F

    root = model.model
    members = getattr(root, "models", None)

    if members is not None:
        # A mixture of DeepGaze models: every member is run and the results
        # are combined with a logsumexp, exactly as MixtureModel does.
        predictions = []
        for member in members:
            predictions.append(
                _raw_density_for_member(model, member, tensor, centerbias_tensor)
            )
        combined = torch.cat(predictions, dim=1) - np.log(len(predictions))
        return combined.logsumexp(dim=1, keepdim=True)

    return _raw_density_for_member(model, root, tensor, centerbias_tensor)


def _raw_density_for_member(
    model: SaliencyModel,
    member,
    tensor: torch.Tensor,
    centerbias_tensor: torch.Tensor,
) -> torch.Tensor:
    """Run one member model and return its density before the normalisation."""
    import torch.nn.functional as F

    original_shape = tensor.shape
    x = F.interpolate(
        tensor, scale_factor=1 / member.downsample, recompute_scale_factor=False
    )
    x = member.features(x)
    readout_shape = [
        int(np.ceil(original_shape[2] / member.downsample / member.readout_factor)),
        int(np.ceil(original_shape[3] / member.downsample / member.readout_factor)),
    ]
    x = [F.interpolate(item, readout_shape) for item in x]
    x = torch.cat(x, dim=1)

    if hasattr(member, "saliency_networks"):
        # DeepGazeIIIMixture: a saliency network per backbone.
        predictions = []
        for saliency_network, finalizer in zip(
            member.saliency_networks, member.finalizers, strict=False
        ):
            saliency = saliency_network(x)
            out = _finalise_without_normalisation(finalizer, saliency, centerbias_tensor)
            predictions.append(out[:, np.newaxis, :, :])
        combined = torch.cat(predictions, dim=1) - np.log(len(predictions))
        return combined.logsumexp(dim=1, keepdim=True)

    x = member.readout_network(x)
    return _finalise_without_normalisation(member.finalizer, x, centerbias_tensor)


def raw_tile(model: SaliencyModel, tile_image: np.ndarray) -> tuple[np.ndarray, float]:
    """Run the model on a tile and return the raw density plus its total.

    The finaliser is reproduced without its last line, the ``logsumexp``
    normalisation, so the absolute density of the tile survives.

    :returns: ``(raw_density, log_total)`` where ``log_total`` is the log of
              the total density of the tile.
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

    tensor = torch.from_numpy(padded.transpose(2, 0, 1)).float().div_(255.0)
    tensor = tensor.unsqueeze(0).to(model.device)

    centerbias = model._centerbias_for(padded.shape[0], padded.shape[1])
    centerbias_tensor = torch.from_numpy(centerbias).float().unsqueeze(0).to(model.device)

    with torch.no_grad():
        raw_tensor = _raw_density(model, tensor, centerbias_tensor)
        raw = raw_tensor.detach().cpu().numpy().squeeze()

    log_total = float(np.log(np.exp(raw - raw.max()).sum()) + raw.max())
    return raw, log_total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--page", default="/tmp/page.png")
    arguments = parser.parse_args()

    settings = Settings()
    model = SaliencyModel(settings)
    model.load()
    pipeline = AnalysisPipeline(model, settings)

    with Image.open(arguments.page) as source:
        image = np.array(source.convert("RGB"))
    print(f"page: {image.shape[1]} x {image.shape[0]}")

    tiles, tile_images, scale = pipeline._plan_tiles(image)
    print(f"tiles: {len(tiles)}, scale={scale:.4f}")

    if CACHE.exists():
        with CACHE.open("rb") as handle:
            raw_data = pickle.load(handle)
        print(f"loaded {len(raw_data)} cached raw tiles")
    else:
        raw_data = []
        for index, tile_image in enumerate(tile_images):
            raw, log_total = raw_tile(model, tile_image)
            raw_data.append((raw, log_total))
            print(f"  tile {index} raw computed")
        with CACHE.open("wb") as handle:
            pickle.dump(raw_data, handle)
        print("cached the raw tiles")

    # The absolute density of each tile.
    totals = np.array([log_total for _, log_total in raw_data])
    print("\n--- the absolute density of each tile ---")
    print(f"    {'tile':>4}  {'rows':>14}  {'log total':>11}  {'relative':>9}")
    maximum = float(totals.max())
    for tile, log_total in zip(tiles, totals, strict=False):
        relative = float(np.exp(log_total - maximum))
        print(
            f"    {tile.index:>4}  {tile.top:>6}-{tile.bottom:<7}  {log_total:>11.4f}  "
            f"{relative:>9.4f}"
        )

    values = np.exp(totals - maximum)
    print(f"\n  the strongest tile is {values.max():.4f} and the weakest {values.min():.4f}")
    print(f"  the ratio between them is {values.max() / max(values.min(), 1e-12):.1f}x")

    # How does the profile built from the absolute density look?
    height, width = image.shape[:2]
    profile = np.zeros((height, width), dtype=np.float64)
    for tile, log_total in zip(tiles, totals, strict=False):
        y0 = max(0, round(tile.top / scale))
        y1 = min(height, round(tile.bottom / scale))
        if y1 <= y0:
            continue
        profile[y0:y1, :] = np.exp(log_total - maximum)

    from app.heatmap import normalise_for_display

    stretched = normalise_for_display(profile)
    band_height = max(1, height // BANDS)
    print("\n--- the profile built from the absolute density ---")
    print(f"    {'band':>4}  {'mean':>9}  {'max':>9}  {'>0.5':>7}")
    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        band = stretched[top:bottom]
        visible = "yes" if band.max() > 0.5 else "NO"
        print(
            f"    {index:>4}  {band.mean():>9.5f}  {band.max():>9.5f}  {visible:>7}"
        )

    # And the combined map.
    detail = pipeline._blend_tiles(
        [raw for raw, _ in raw_data], tiles, (width, height), scale
    )
    combined = detail * profile
    combined_stretched = normalise_for_display(combined)
    print("\n--- the combined map (detail * absolute density) ---")
    print(f"    {'band':>4}  {'mean':>9}  {'max':>9}  {'>0.5':>7}")
    dead = 0
    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        band = combined_stretched[top:bottom]
        visible = "yes" if band.max() > 0.5 else "NO"
        if band.max() <= 0.5:
            dead += 1
        print(
            f"    {index:>4}  {band.mean():>9.5f}  {band.max():>9.5f}  {visible:>7}"
        )
    print(f"\n  bands with no visible hotspot: {dead}/{BANDS}")


if __name__ == "__main__":
    main()
