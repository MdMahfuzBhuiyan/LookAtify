#!/usr/bin/env python3
"""Print the per-band numbers behind each candidate for the display map.

The previous experiments only showed the outcome. This one shows the inputs
as well, so it is clear *why* a candidate helps on one page and hurts on
another.

Usage:
    python scripts/experiment-display-detail.py [--page FILE ...]
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


def band_summary(values: np.ndarray, label: str) -> list[float]:
    """Print the max of every band of a map and return the maxima."""
    height = values.shape[0]
    band_height = max(1, height // BANDS)
    maxima = []
    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        band = values[top:bottom]
        maxima.append(float(band.max()))
    print(f"    {label:>28}: " + " ".join(f"{value:>7.4f}" for value in maxima))
    return maxima


def smooth_row_profile(profile: np.ndarray, sigma_rows: float) -> np.ndarray:
    """The vertical profile of a map, smoothed so it has no hard steps."""
    from scipy.ndimage import gaussian_filter

    column = np.asarray(profile, dtype=np.float64).mean(axis=1)
    return gaussian_filter(column, sigma=sigma_rows, mode="nearest")


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

        print("  the inputs")
        band_summary(detail, "detail max")
        band_summary(profile, "profile max")
        band_summary(profile / (float(profile.max()) or 1.0), "profile normalised max")

        candidates = {}

        # Today: one map for the statistics and for the display.
        candidates["today (detail x profile)"] = detail * profile

        # A bounded, smooth profile.
        row = smooth_row_profile(profile, max(2.0, height / 200.0))
        low = float(row.min())
        high = float(row.max()) or 1.0
        normalised = (row - low) / (high - low) if high - low > 1e-12 else np.zeros_like(row)
        for floor in (0.35, 0.55):
            bounded = floor + (1.0 - floor) * normalised
            candidates[f"bounded profile floor {floor}"] = detail * bounded[:, None]

        # The detail alone: every tile keeps its own scale.
        candidates["detail alone"] = detail

        # A local contrast enhancement: the detail divided by a smooth
        # envelope, so a local hotspot stands out wherever it is.
        from scipy.ndimage import gaussian_filter

        sigma = max(16.0, height / 30.0)
        envelope = gaussian_filter(detail.astype(np.float64), sigma=sigma, mode="nearest")
        interest = detail / np.maximum(envelope, 1e-12)
        candidates["local contrast alone"] = interest
        candidates["local contrast x bounded"] = interest * (
            (0.35 + 0.65 * normalised)[:, None]
        )

        print("\n  the display map (the band maxima after the stretch)")
        for name, values in candidates.items():
            display = normalise_for_display(values)
            maxima = band_summary(display, name)
            dead = sum(1 for value in maxima if value <= 0.5)
            print(f"    {'':>28}  -> dead {dead}/{BANDS}")


if __name__ == "__main__":
    main()
