#!/usr/bin/env python3
"""Compare ways of stretching the saliency map for display.

The viewer paints the heatmap with an alpha that follows the intensity, so a
band of the page that sits low in the stretched range is invisible. On a
very long page the middle of the page ends up in that state: the attention
is there, but the stretch puts it below the visible part of the colormap.

This script measures the stretch on real pages and reports, for each band of
the page, how much of it would actually be painted.

Usage:
    python scripts/experiment-display-stretch.py [--page FILE ...]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from app.config import Settings  # noqa: E402
from app.heatmap import normalise_for_display  # noqa: E402
from app.model import SaliencyModel  # noqa: E402
from app.pipeline import AnalysisPipeline  # noqa: E402

BANDS = 10


def visible_report(name: str, display: np.ndarray) -> dict:
    """Report how much of each band of the page would be painted."""
    height = display.shape[0]
    band_height = max(1, height // BANDS)
    dead = 0
    shares = []
    print(f"\n  {name}")
    print(f"    {'band':>4}  {'mean':>8}  {'max':>8}  {'>0.5':>7}  {'>0.35':>7}")
    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        band = display[top:bottom]
        above = float((band > 0.5).mean() * 100.0)
        visible = float((band > 0.35).mean() * 100.0)
        if band.max() <= 0.5:
            dead += 1
        print(
            f"    {index:>4}  {band.mean():>8.4f}  {band.max():>8.4f}  {above:>6.2f}%  "
            f"{visible:>6.2f}%"
        )
    return {"name": name, "dead": dead}


def stretch_percentile(values: np.ndarray, low: float, high: float, steepness: float) -> np.ndarray:
    """The current stretch, with the percentiles and the curve as arguments."""
    values = np.asarray(values, dtype=np.float32)
    low_value = float(np.percentile(values, low))
    high_value = float(np.percentile(values, high))
    span = high_value - low_value
    if span < 1e-12:
        return np.full_like(values, 0.5)
    scaled = (values - low_value) / span
    softened = np.log1p(np.exp(np.clip(scaled * steepness, -30.0, 30.0))) / steepness
    return np.clip(softened, 0.0, 1.0).astype(np.float32)


def stretch_histogram(values: np.ndarray, bins: int = 256) -> np.ndarray:
    """Equalise the histogram, then smooth the result.

    Equalising gives every intensity the same number of pixels, so a small
    but sharp hotspot is as visible as a large but weak one. The result is
    smoothed so the equalisation does not show up as blotches.
    """
    from scipy.ndimage import gaussian_filter

    values = np.asarray(values, dtype=np.float32)
    flat = values.ravel()
    # The rank of every pixel among all pixels.
    order = flat.argsort()
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(len(flat), dtype=np.float64)
    equalised = (ranks / max(len(flat) - 1, 1)).astype(np.float32).reshape(values.shape)
    return gaussian_filter(equalised, sigma=2.0, mode="nearest")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--page",
        action="append",
        default=["/tmp/page.png", "/tmp/page-642d2d.png", "/tmp/page-7a5547.png"],
    )
    arguments = parser.parse_args()

    settings = Settings()
    model = SaliencyModel(settings)
    model.load()
    pipeline = AnalysisPipeline(model, settings)

    for page_path in arguments.page:
        path = Path(page_path)
        if not path.exists():
            continue

        with Image.open(path) as source:
            image = np.array(source.convert("RGB"))
        height, width = image.shape[:2]
        print(f"\n\n========== {path.name} ({width} x {height}) ==========")

        tiles, tile_images, scale = pipeline._plan_tiles(image)
        tile_logits = [pipeline._infer_tile(tile_image) for tile_image in tile_images]
        detail = pipeline._blend_tiles(tile_logits, tiles, (width, height), scale)
        profile = pipeline._coarse_profile(image)
        combined = pipeline._apply_global_profile(detail, profile) if profile is not None else detail

        results = []

        results.append(visible_report("A. today (p10-p99.5, softplus 12)", normalise_for_display(combined)))

        results.append(
            visible_report("B. p1-p99 (softplus 12)", stretch_percentile(combined, 1.0, 99.0, 12.0))
        )
        results.append(
            visible_report("C. p5-p99 (softplus 12)", stretch_percentile(combined, 5.0, 99.0, 12.0))
        )
        results.append(
            visible_report("D. p10-p99 (softplus 12)", stretch_percentile(combined, 10.0, 99.0, 12.0))
        )
        results.append(
            visible_report("E. p10-p99.9 (softplus 12)", stretch_percentile(combined, 10.0, 99.9, 12.0))
        )
        results.append(visible_report("F. histogram equalised", stretch_histogram(combined)))

        # A rank based stretch with a gentler curve.
        for steepness in (4.0, 6.0):
            results.append(
                visible_report(
                    f"G. p10-p99 (softplus {steepness})",
                    stretch_percentile(combined, 10.0, 99.0, steepness),
                )
            )

        print("\n=== summary (dead = bands with no visible hotspot) ===")
        for result in results:
            print(f"  {result['name']:>44}  dead {result['dead']:>2}/{BANDS}")


if __name__ == "__main__":
    main()
