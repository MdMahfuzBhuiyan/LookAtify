#!/usr/bin/env python3
"""Measure where the attention sits after every stage of the pipeline.

The viewer showed a heatmap at the top and the bottom of a long page but
nothing in the middle. Guessing which stage loses the middle is slow, so
this script runs the real pipeline over a captured page and reports where
the attention mass sits after each stage.

The stages are:

    tiles      the per-tile probability maps, before they are blended
    detail     the blended per-tile map
    profile    the coarse whole-page pass
    combined   detail * profile, which is what the statistics describe
    display    the stretched map the server sends to the viewer

Usage:
    python scripts/diagnose-heatmap-bands.py [--page /tmp/page.png]
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from app.config import Settings  # noqa: E402
from app.heatmap import normalise_for_display, normalise_to_probability, to_png_bytes  # noqa: E402
from app.model import SaliencyModel  # noqa: E402
from app.pipeline import AnalysisPipeline  # noqa: E402

BANDS = 20


def band_report(name: str, values: np.ndarray) -> None:
    """Print where the mass of a map sits, in horizontal bands.

    :param name: the stage name.
    :param values: a 2D map.
    """
    height = values.shape[0]
    band_height = max(1, height // BANDS)
    total = float(values.sum())

    print(f"\n  {name}: min={values.min():.6g} max={values.max():.6g} sum={total:.6g}")
    print(f"    {'band':>12}  {'share%':>8}  {'mean':>12}  {'max':>12}")

    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        if top >= bottom:
            break
        band = values[top:bottom]
        band_total = float(band.sum())
        share = (band_total / total * 100.0) if total > 0 else 0.0
        marker = " <-- first" if index == 0 else (" <-- last" if index == BANDS - 1 else "")
        print(
            f"    {top:>6}-{bottom:<5}  {share:>7.3f}%  {band.mean():>12.6g}  "
            f"{band.max():>12.6g}{marker}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--page", default="/tmp/page.png")
    parser.add_argument("--out", default="/tmp/lookatify-bands")
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

    tile_logits = [pipeline._infer_tile(tile_image) for tile_image in tile_images]
    tile_probabilities = [normalise_to_probability(logit) for logit in tile_logits]

    # Where does each tile put its own attention? The tile knows the position
    # inside itself, but not how much of the page it deserves.
    print("\n--- per-tile mass (the top third, middle third, bottom third of the tile) ---")
    for tile, probability in zip(tiles, tile_probabilities, strict=False):
        height = probability.shape[0]
        thirds = [
            probability[: height // 3].sum(),
            probability[height // 3 : 2 * height // 3].sum(),
            probability[2 * height // 3 :].sum(),
        ]
        total = sum(thirds) or 1.0
        shares = [value / total * 100.0 for value in thirds]
        print(
            f"  tile {tile.index:>2}  rows {tile.top:>6}-{tile.bottom:<6}  "
            f"top {shares[0]:>5.1f}%  mid {shares[1]:>5.1f}%  bottom {shares[2]:>5.1f}%"
        )

    detail = pipeline._blend_tiles(tile_logits, tiles, (image.shape[1], image.shape[0]), scale)
    profile = pipeline._coarse_profile(image)
    combined = (
        pipeline._apply_global_profile(detail, profile) if profile is not None else detail
    )
    display = normalise_for_display(combined)

    band_report("detail (blended tiles)", detail)
    if profile is not None:
        band_report("profile (coarse pass)", profile)
    band_report("combined (detail * profile)", combined)
    band_report("display (what the viewer gets)", display)

    # What the viewer actually paints: the alpha follows the intensity.
    print("\n--- what the viewer paints ---")
    print(f"  display at the 10th percentile: {np.percentile(display, 10):.4f}")
    print(f"  display at the 50th percentile: {np.percentile(display, 50):.4f}")
    print(f"  display at the 90th percentile: {np.percentile(display, 90):.4f}")
    print(f"  display at the 99th percentile: {np.percentile(display, 99):.4f}")
    for band in range(BANDS):
        top = band * (display.shape[0] // BANDS)
        bottom = min(display.shape[0], top + display.shape[0] // BANDS)
        chunk = display[top:bottom]
        visible = float((chunk > 0.5).mean() * 100.0)
        print(
            f"  band {band:>2} rows {top:>6}-{bottom:<6}  "
            f"mean={chunk.mean():.4f}  max={chunk.max():.4f}  "
            f"pixels above yellow={visible:>6.2f}%"
        )

    out = Path(arguments.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, values in (
        ("detail", detail),
        ("profile", profile),
        ("combined", combined),
        ("display", display),
    ):
        if values is None:
            continue
        scaled = normalise_for_display(values)
        (out / f"{name}.png").write_bytes(to_png_bytes((scaled * 255).astype(np.uint8)))
    print(f"\nwrote the stage images to {out}")


if __name__ == "__main__":
    main()
