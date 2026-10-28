#!/usr/bin/env python3
"""Test candidate fixes for the empty middle of the heatmap.

The coarse pass is meant to say how much attention each band of the page
deserves, but measured on a real page it was nearly dead in the middle and
bright at exactly the first and last band. That pattern is the shape of the
model's own border bias: the outermost cells of the image get extra
attention, and for a tall strip the outermost cells are the top and the
bottom of the page.

The fix should remove that bias without losing the content signal. Running
the model on a blank image of the same shape and subtracting its log density
does exactly that: what is left is the part the content is responsible for.

This script scores each candidate on two things:

* how many bands of the final heatmap have a visible hotspot;
* how the attention is shared between the bands.

Usage:
    python scripts/experiment-fix-profile.py [--page /tmp/page.png]
"""

from __future__ import annotations

import argparse
import pickle
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

TILE_CACHE = Path("/tmp/lookatify-tile-logits.pkl")
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


def score(name: str, combined: np.ndarray) -> dict:
    """Score a combined map and print its band profile."""
    stretched = normalise_for_display(combined)
    rows = band_rows(stretched)
    dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
    shares = [share for share, _, _ in rows]

    print(f"\n  {name}")
    print(f"    {'band':>4}  {'share%':>8}  {'mean':>9}  {'max':>9}  {'hot':>5}")
    for index, (share, mean, maximum) in enumerate(rows):
        hot = "yes" if maximum > 0.5 else "NO"
        print(
            f"    {index:>4}  {share:>7.2f}%  {mean:>9.5f}  {maximum:>9.5f}  {hot:>5}"
        )

    top_share = sum(shares[:3])
    middle_share = sum(shares[3:7])
    print(
        f"    -> dead bands: {dead}/{BANDS}   top third: {top_share:.1f}%   "
        f"middle: {middle_share:.1f}%   bottom third: {sum(shares[7:]):.1f}%"
    )
    return {
        "name": name,
        "dead": dead,
        "top_share": top_share,
        "middle_share": middle_share,
        "evenness": max(shares) - min(shares),
    }


def bounded_profile(profile: np.ndarray, floor: float) -> np.ndarray:
    """Rescale a profile so no band falls below ``floor`` of the strongest.

    The profile decides how much attention a band deserves. It must not be
    able to switch a band off completely, or the content inside it is lost
    even when the content is strong.
    """
    height = profile.shape[0]
    band_height = max(1, height // BANDS)
    weights = np.ones(height, dtype=np.float64)

    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        if top >= bottom:
            continue
        weights[top:bottom] = float(profile[top:bottom].mean())

    maximum = float(weights.max()) or 1.0
    weights = weights / maximum
    return np.maximum(weights, floor)[:, None]


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
    height, width = image.shape[:2]
    print(f"page: {width} x {height}")

    tiles, tile_images, scale = pipeline._plan_tiles(image)

    if TILE_CACHE.exists():
        with TILE_CACHE.open("rb") as handle:
            tile_logits = pickle.load(handle)
        print(f"loaded {len(tile_logits)} cached tile logits")
    else:
        tile_logits = [pipeline._infer_tile(tile_image) for tile_image in tile_images]
        with TILE_CACHE.open("wb") as handle:
            pickle.dump(tile_logits, handle)
        print(f"computed and cached {len(tile_logits)} tile logits")

    detail = pipeline._blend_tiles(tile_logits, tiles, (width, height), scale)

    # ------------------------------------------------------------------
    # the coarse pass, and the blank reference of the same shape
    # ------------------------------------------------------------------
    side = int(settings.coarse_inference_side)
    long_side = max(height, width)
    coarse_scale = side / long_side
    small = pipeline._resize(image, coarse_scale)
    blank = np.full(small.shape, 128, dtype=np.uint8)
    print(f"coarse strip: {small.shape[1]}x{small.shape[0]}")

    page_logits = pipeline._infer_tile(small)
    blank_logits = pipeline._infer_tile(blank)

    page_density = normalise_to_probability(page_logits)
    blank_density = normalise_to_probability(blank_logits)

    # The bias-corrected profile: the log density of the content minus the
    # log density of a blank page of the same shape.
    corrected = np.exp(page_logits - blank_logits)
    corrected = corrected / (float(corrected.sum()) or 1.0)
    corrected_map = pipeline._resize_float(corrected, (height, width))

    raw_profile = pipeline._coarse_profile(image)

    print("\n=== the profile as it is today ===")
    print_profile = normalise_for_display(raw_profile)
    for index, (share, mean, maximum) in enumerate(band_rows(print_profile)):
        print(f"  band {index}: mean={mean:.5f} max={maximum:.5f}")

    print("\n=== the bias-corrected profile ===")
    corrected_display = normalise_for_display(corrected_map)
    for index, (share, mean, maximum) in enumerate(band_rows(corrected_display)):
        print(f"  band {index}: mean={mean:.5f} max={maximum:.5f}")

    # ------------------------------------------------------------------
    # candidates
    # ------------------------------------------------------------------
    results = []

    results.append(score("A. today: detail * coarse profile", detail * raw_profile))

    for floor in (0.25, 0.4, 0.55):
        bounded = bounded_profile(raw_profile, floor)
        results.append(
            score(
                f"B. detail * bounded coarse profile (floor {floor})",
                detail * bounded,
            )
        )

    for floor in (0.25, 0.4, 0.55):
        bounded = bounded_profile(corrected_map, floor)
        results.append(
            score(
                f"C. detail * bounded corrected profile (floor {floor})",
                detail * bounded,
            )
        )

    results.append(score("D. no profile: the detail alone", detail))

    print("\n=== summary ===")
    print(f"  {'candidate':>56}  {'dead':>5}  {'top%':>7}  {'evenness':>9}")
    for result in results:
        print(
            f"  {result['name']:>56}  {result['dead']:>5}  {result['top_share']:>6.1f}%  "
            f"{result['evenness']:>8.1f}"
        )


if __name__ == "__main__":
    main()
