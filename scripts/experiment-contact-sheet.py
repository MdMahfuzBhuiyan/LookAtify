#!/usr/bin/env python3
"""Test a contact sheet as the way to get the global attention profile.

The model normalises every image it sees to sum to one, so a per-tile pass
cannot say which part of the page deserves more attention. The coarse pass
tried to answer that with one very tall, very narrow strip, which is far
outside the model's training distribution and produced a profile that was
dead over the middle of the page.

A contact sheet avoids that: square windows down the page are arranged in a
grid, and the model sees the grid as one ordinary image. The finaliser
normalises the whole grid to sum to one, so each window's share of that
total is its share of the page's attention — a real global ranking, measured
in a single pass.

Usage:
    python scripts/experiment-contact-sheet.py [--page FILE ...]
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
from app.heatmap import normalise_for_display, normalise_to_probability  # noqa: E402
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


def contact_sheet_profile(
    pipeline, image: np.ndarray, columns: int = 4
) -> np.ndarray | None:
    """Build a profile from a grid of square windows.

    Each window is as wide as the page and as tall as the page is wide, so
    the page's proportions are kept. The windows are arranged in a grid and
    the model sees the grid as one ordinary image.

    :returns: a map at the page's dimensions, or ``None`` when the page has
              too little content for a grid.
    """
    height, width = image.shape[:2]

    # The window is square: as wide as the page, as tall as the page is wide.
    window = width
    step = max(1, height // max(1, (height + window - 1) // window))
    tops = list(range(0, height, step))
    if len(tops) < 2:
        return None

    rows = (len(tops) + columns - 1) // columns
    sheet = np.zeros((rows * window, columns * window, 3), dtype=np.uint8)
    centres = []

    for index, top in enumerate(tops):
        bottom = min(height, top + window)
        row = index // columns
        column = index % columns
        sheet[
            row * window : row * window + (bottom - top),
            column * window : column * window + width,
        ] = image[top:bottom]
        centres.append((top, bottom))

    logits = pipeline._infer_tile(sheet)
    probability = normalise_to_probability(logits)

    # The share of the grid's attention that falls in each window.
    weights = []
    for index, (top, bottom) in enumerate(centres):
        row = index // columns
        column = index % columns
        cell = probability[
            row * window : row * window + (bottom - top),
            column * window : column * window + width,
        ]
        weights.append(float(cell.sum()))

    weights = np.array(weights)
    total = float(weights.sum()) or 1.0
    weights = weights / total

    # The weights are spread over the page, one per window.
    profile = np.zeros((height, width), dtype=np.float64)
    for (top, bottom), weight in zip(centres, weights, strict=False):
        profile[top:bottom, :] = weight
    return profile


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
        raw_profile = pipeline._coarse_profile(image)

        # The contact sheet, for a few grid widths.
        profiles = {}
        for columns in (3, 4, 5, 6):
            profile = contact_sheet_profile(pipeline, image, columns)
            if profile is not None:
                profiles[f"sheet c{columns}"] = profile

        print("\n  the profile of each method (the share of the attention per band)")
        for name, profile in [("coarse strip (today)", raw_profile), *profiles.items()]:
            rows = band_rows(profile)
            print(
                f"    {name:>22}: "
                + " ".join(f"{share:>5.1f}" for share, _, _ in rows)
            )

        print("\n  the display map per method")
        for name, profile in [("coarse strip (today)", raw_profile), *profiles.items()]:
            display = normalise_for_display(detail * profile)
            rows = band_rows(display)
            dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
            print(
                f"    {name:>22}: dead {dead}/{BANDS}  "
                + " ".join(f"{maximum:>6.3f}" for _, _, maximum in rows)
            )

        # The bounded version: floor + (1 - floor) * (profile / max). This
        # only ever compresses the contrast, so it cannot make a page worse.
        print("\n  the display map with a bounded profile (floor 0.35)")
        for name, profile in [("coarse strip (today)", raw_profile), *profiles.items()]:
            bounded = 0.35 + 0.65 * (profile / (float(profile.max()) or 1.0))
            display = normalise_for_display(detail * bounded)
            rows = band_rows(display)
            dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
            print(
                f"    {name:>22}: dead {dead}/{BANDS}  "
                + " ".join(f"{maximum:>6.3f}" for _, _, maximum in rows)
            )


if __name__ == "__main__":
    main()
