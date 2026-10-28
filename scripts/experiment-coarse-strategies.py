#!/usr/bin/env python3
"""Compare ways of computing the global attention profile.

The coarse pass scales the page so its longest side is the inference size.
For a very long page that produces a very tall, very narrow strip — a
1:10 image, far outside what the model was trained on — and the profile it
returns is then useless: it barely moves over the middle of the page, so the
detail map gets multiplied by almost nothing there and the heatmap is empty
in the middle.

This script measures the alternatives on real pages:

    longest   the current behaviour: scale the longest side
    square    reshape the page to a square, so the model sees an ordinary
              image, and take the vertical profile from it
    windows   run the model on square windows and compare the windows

Usage:
    python scripts/experiment-coarse-strategies.py [--page FILE ...]
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


def report(name: str, combined: np.ndarray) -> dict:
    """Print and return the band profile of a combined map."""
    stretched = normalise_for_display(combined)
    rows = band_rows(stretched)
    dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
    shares = [share for share, _, _ in rows]
    print(f"\n  {name}")
    print(f"    {'band':>4}  {'share%':>8}  {'max':>9}  {'hot':>5}")
    for index, (share, _, maximum) in enumerate(rows):
        hot = "yes" if maximum > 0.5 else "NO"
        print(f"    {index:>4}  {share:>7.2f}%  {maximum:>9.5f}  {hot:>5}")
    print(
        f"    -> dead {dead}/{BANDS}  top {sum(shares[:3]):.1f}%  "
        f"mid {sum(shares[3:7]):.1f}%  bottom {sum(shares[7:]):.1f}%  "
        f"spread {max(shares) - min(shares):.1f}"
    )
    return {"name": name, "dead": dead, "spread": max(shares) - min(shares)}


def profile_longest(pipeline, image, side):
    """The current strategy: scale the longest side."""
    return pipeline._coarse_profile(image)


def profile_square(pipeline, image, side):
    """Reshape the page to a square and take its vertical profile.

    The model sees an ordinary image, so its output is meaningful. The
    output is then stretched back to the page's height, which turns it into
    a profile of the page from top to bottom.
    """
    height, width = image.shape[:2]
    with Image.fromarray(image, mode="RGB") as source:
        square = np.array(source.resize((side, side), Image.LANCZOS))
    logits = pipeline._infer_tile(square)
    probability = normalise_to_probability(logits)
    # The vertical profile of the square, spread over the page's height.
    column = probability.mean(axis=1)
    column = column / (float(column.sum()) or 1.0)
    profile = np.repeat(column[:, None], width, axis=1)
    return pipeline._resize_float(profile, (height, width))


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

        results = []

        longest = profile_longest(pipeline, image, settings.coarse_inference_side)
        results.append(report("A. longest side (today)", detail * longest))

        for side in (512, 768, 1024):
            square = profile_square(pipeline, image, side)
            results.append(report(f"B. square reshape at {side}", detail * square))
            # The same profile, but bounded so it can never erase a band.
            bounded = 0.35 + 0.65 * (square / (float(square.max()) or 1.0))
            results.append(
                report(f"C. square reshape at {side}, bounded", detail * bounded)
            )

        print("\n=== summary ===")
        for result in results:
            print(
                f"  {result['name']:>40}  dead {result['dead']:>2}  "
                f"spread {result['spread']:>5.1f}"
            )


if __name__ == "__main__":
    main()
