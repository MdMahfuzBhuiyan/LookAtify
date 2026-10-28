#!/usr/bin/env python3
"""Look for a signal that ranks the bands of a page by attention.

The per-tile pass gives a shape inside each tile but no way to compare the
tiles. The coarse whole-page pass was meant to supply that comparison, but
it runs on a very tall strip that is far outside the model's training
distribution, so it starves the middle of the page.

This script measures several candidate signals on real pages and reports how
well each one ranks the bands. A good signal puts the attention where the
content is, without flattening the page.

Usage:
    python scripts/experiment-tile-signals.py [--page FILE ...]
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


def band_profile(values: np.ndarray) -> list[tuple[float, float, float]]:
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
    rows = band_profile(stretched)
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
            print(f"\n=== {path.name}: missing ===")
            continue

        with Image.open(path) as source:
            image = np.array(source.convert("RGB"))
        height, width = image.shape[:2]
        print(f"\n\n========== {path.name} ({width} x {height}) ==========")

        tiles, tile_images, scale = pipeline._plan_tiles(image)
        tile_logits = [pipeline._infer_tile(tile_image) for tile_image in tile_images]
        detail = pipeline._blend_tiles(tile_logits, tiles, (width, height), scale)

        # --- the signals ------------------------------------------------
        # 1. The shape of the attention inside a tile: how peaked it is.
        #    A tile with a sharp hotspot gets a high score; a tile whose
        #    attention is spread out gets a low one.
        peakiness = []
        for logit in tile_logits:
            probability = normalise_to_probability(logit)
            top = float(np.sort(probability.ravel())[-100:].sum())
            peakiness.append(top)

        # 2. The total absolute density of the tile.
        totals = []
        for logit in tile_logits:
            maximum = float(logit.max())
            totals.append(float(maximum + np.log(np.exp(logit - maximum).sum())))

        # 3. The coarse whole-page pass, as it is today.
        profile = pipeline._coarse_profile(image)

        # --- the band weight built from each signal ---------------------
        def band_weight(values: list[float]) -> np.ndarray:
            """Turn one number per tile into a per-row weight."""
            weight = np.zeros(height, dtype=np.float64)
            for tile, value in zip(tiles, values, strict=False):
                y0 = max(0, round(tile.top / scale))
                y1 = min(height, round(tile.bottom / scale))
                if y1 > y0:
                    weight[y0:y1] = value
            maximum = float(weight.max()) or 1.0
            return (weight / maximum)[:, None]

        report("A. today: detail * coarse profile", detail * profile)

        for floor in (0.3, 0.5):
            bounded = np.maximum(band_weight(peakiness), floor)
            report(
                f"B. detail * peakiness band weight (floor {floor})",
                detail * bounded,
            )

        for floor in (0.3, 0.5):
            bounded = np.maximum(band_weight(totals), floor)
            report(
                f"C. detail * absolute density band weight (floor {floor})",
                detail * bounded,
            )

        # The peakiness signal on its own, so the ranking can be judged.
        print("\n  the peakiness of each tile (higher = sharper hotspot):")
        for tile, value in zip(tiles, peakiness, strict=False):
            print(f"    tile {tile.index:>2}  rows {tile.top:>6}-{tile.bottom:<6}  {value:.6f}")


if __name__ == "__main__":
    main()
