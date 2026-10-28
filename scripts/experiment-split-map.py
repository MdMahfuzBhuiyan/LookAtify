#!/usr/bin/env python3
"""Test the split design for the saliency map.

The per-tile detail and the whole-page profile do two different jobs, and
forcing one map to do both is what made the middle of a long page invisible:

* the *probability* map answers "where does the attention go", so it needs
  the whole-page profile and keeps the global ranking;
* the *display* map answers "where is the hotspot I can see", so it must
  not let the profile erase a band that has real content.

This script measures the split design on real pages: how many bands have a
visible hotspot, how much of the page is washed out, and how the attention
is shared.

Usage:
    python scripts/experiment-split-map.py [--page FILE ...]
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


def band_rows(values: np.ndarray) -> list[tuple[float, float, float]]:
    """Return (share%, mean, max) for each horizontal band of a map."""
    height = values.shape[0]
    band_height = max(1, height // BANDS)
    total = float(values.sum()) or 1.0
    rows = []
    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        band = values[top:bottom]
        rows.append(
            (float(band.sum()) / total * 100.0, float(band.mean()), float(band.max()))
        )
    return rows


def report(name: str, display: np.ndarray, probability: np.ndarray) -> dict:
    """Report the visible bands of a display map and the shares of the probability."""
    rows = band_rows(display)
    dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
    shares = [share for share, _, _ in band_rows(probability)]
    washed = float((display > 0.5).mean() * 100.0)

    print(f"\n  {name}")
    print(f"    {'band':>4}  {'max':>8}  {'hot':>5}  {'share%':>8}")
    for index, (_, _, maximum) in enumerate(rows):
        hot = "yes" if maximum > 0.5 else "NO"
        print(f"    {index:>4}  {maximum:>8.4f}  {hot:>5}  {shares[index]:>7.2f}%")
    print(
        f"    -> dead {dead}/{BANDS}  washed {washed:.1f}%  "
        f"top {sum(shares[:3]):.1f}%  mid {sum(shares[3:7]):.1f}%  "
        f"bottom {sum(shares[7:]):.1f}%  spread {max(shares) - min(shares):.1f}"
    )
    return {
        "name": name,
        "dead": dead,
        "washed": washed,
        "spread": max(shares) - min(shares),
        "top": sum(shares[:3]),
    }


def smooth_bound(profile: np.ndarray, floor: float) -> np.ndarray:
    """Bound a profile so it can never erase a band, without a hard edge.

    The bound is applied to the profile itself and the result is smoothed,
    so the transition between the bands is gradual. A hard step would show up
    in the heatmap as a horizontal line.
    """
    from scipy.ndimage import gaussian_filter

    values = np.asarray(profile, dtype=np.float64)
    maximum = float(values.max()) or 1.0
    scaled = values / maximum

    # The vertical profile of the page: one weight per row.
    column = scaled.mean(axis=1)
    column = gaussian_filter(column, sigma=max(2.0, len(column) / 200.0), mode="nearest")

    minimum = float(column.min())
    maximum = float(column.max()) or 1.0
    if maximum - minimum < 1e-12:
        return np.ones_like(values)

    normalised = (column - minimum) / (maximum - minimum)
    bounded = floor + (1.0 - floor) * normalised
    return np.repeat(bounded[:, None], values.shape[1], axis=1)


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

        # The probability map keeps the whole-page profile, so the statistics
        # and the peaks keep the global ranking.
        probability = (
            pipeline._apply_global_profile(detail, profile) if profile is not None else detail
        )
        probability_total = float(probability.sum()) or 1.0
        probability = probability / probability_total

        # The display map bounds the profile, so no band can be erased.
        for floor in (0.3, 0.45, 0.6):
            bounded = smooth_bound(profile, floor)
            display = normalise_for_display(detail * bounded)
            report(f"display: bounded profile, floor {floor}", display, probability)

        # Today: one map for both.
        combined = detail * profile
        display = normalise_for_display(combined)
        report("today: detail * raw profile", display, combined / (float(combined.sum()) or 1.0))


if __name__ == "__main__":
    main()
