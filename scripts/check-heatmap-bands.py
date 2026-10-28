#!/usr/bin/env python3
"""Check that every band of a page keeps a visible hotspot.

This is the regression check for the report that the middle of a long page
was blank while the first and last page had a heatmap.

The check runs the real pipeline over a captured page and reports, for every
horizontal band of the page:

* the highest intensity the viewer would paint there;
* how many pixels reach the yellow part of the colormap.

A band whose highest intensity stays below the yellow band is invisible, and
that is the failure this script looks for.

Usage:
    python scripts/check-heatmap-bands.py [--page FILE ...]
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
from app.pipeline import PROFILE_STEEPNESS_LIMIT, AnalysisPipeline  # noqa: E402

BANDS = 10

#: The intensity at which the jet colormap turns yellow. Below it the
#: heatmap is only a green wash, which is not a visible hotspot.
YELLOW = 0.55


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

    failures = 0

    for page_path in arguments.page:
        path = Path(page_path)
        if not path.exists():
            print(f"\n=== {path.name}: missing ===")
            continue

        with Image.open(path) as source:
            image = np.array(source.convert("RGB"))
        height, width = image.shape[:2]
        print(f"\n\n========== {path.name} ({width} x {height}) ==========")

        tiles, tile_images, scale = pipeline._plan_tiles(image)
        tile_probabilities = [pipeline._infer_tile(t) for t in tile_images]
        detail = pipeline._blend_tiles(tile_probabilities, tiles, (width, height), scale)
        profile = pipeline._coarse_profile(image)

        intensity = detail
        if profile is not None:
            intensity = pipeline._apply_global_profile(intensity, profile)

        display_intensity = intensity
        if profile is not None:
            compressed = pipeline._compress_profile(profile, PROFILE_STEEPNESS_LIMIT)
            display_intensity = pipeline._apply_global_profile(detail, compressed)

        display = normalise_for_display(display_intensity)

        band_height = max(1, height // BANDS)
        print(f"  {'band':>12}  {'max':>8}  {'>yellow':>9}  {'visible':>8}")
        invisible = []
        for index in range(BANDS):
            top = index * band_height
            bottom = min(height, top + band_height)
            if top >= bottom:
                break
            band = display[top:bottom]
            yellow = float((band > YELLOW).mean() * 100.0)
            visible = float((band > 0.2).mean() * 100.0)
            if band.max() <= YELLOW:
                invisible.append(index)
            print(
                f"  {top:>6}-{bottom:<5}  {band.max():>8.4f}  {yellow:>8.2f}%  "
                f"{visible:>7.2f}%"
            )

        if invisible:
            failures += len(invisible)
            print(f"  FAIL: {len(invisible)} band(s) have no visible hotspot")
        else:
            print(f"  PASS: every band has a visible hotspot")

    if failures:
        print(f"\n{failures} band(s) had no visible hotspot")
        sys.exit(1)
    print("\nEVERY BAND HAS A VISIBLE HOTSPOT")


if __name__ == "__main__":
    main()
