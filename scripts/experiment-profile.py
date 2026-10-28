#!/usr/bin/env python3
"""Compare ways of building the global attention profile.

The per-tile pass knows where the attention is inside each band of the page.
The coarse pass is supposed to say how much attention each band deserves, but
measured on a real page it was nearly dead in the middle of the page and
strong at the top and bottom, which made the combined map invisible there.

The tile logits are computed once and cached, so each candidate can be tried
in a second.

Usage:
    python scripts/experiment-profile.py [--page /tmp/page.png]
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

CACHE = Path("/tmp/lookatify-tile-logits.pkl")
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
            (
                float(band.sum()) / total * 100.0,
                float(band.mean()),
                float(band.max()),
            )
        )
    return rows


def print_profile(name: str, values: np.ndarray) -> None:
    """Print the band profile of a map."""
    rows = band_profile(values)
    print(f"\n  {name}")
    print(f"    {'band':>4}  {'share%':>8}  {'mean':>9}  {'max':>9}  {'>0.5':>7}")
    for index, (share, mean, maximum) in enumerate(rows):
        visible = "yes" if maximum > 0.5 else "NO"
        print(
            f"    {index:>4}  {share:>7.2f}%  {mean:>9.5f}  {maximum:>9.5f}  {visible:>7}"
        )


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

    # The tile logits are the slow part, so they are cached.
    if CACHE.exists():
        with CACHE.open("rb") as handle:
            tile_logits = pickle.load(handle)
        print(f"loaded {len(tile_logits)} cached tile logits")
    else:
        tile_logits = [pipeline._infer_tile(tile_image) for tile_image in tile_images]
        with CACHE.open("wb") as handle:
            pickle.dump(tile_logits, handle)
        print(f"computed and cached {len(tile_logits)} tile logits")

    detail = pipeline._blend_tiles(
        tile_logits, tiles, (image.shape[1], image.shape[0]), scale
    )
    print_profile("detail (blended tiles)", normalise_for_display(detail))

    # ------------------------------------------------------------------
    # candidate profiles
    # ------------------------------------------------------------------
    for side in (512, 768, 1024, 1536, 2048):
        settings.coarse_inference_side = side
        candidate = pipeline._coarse_profile(image)
        if candidate is None:
            print(f"\n  coarse side {side}: skipped")
            continue
        stretched = normalise_for_display(candidate)
        rows = band_profile(stretched)
        dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
        print(
            f"\n  coarse side {side}: small={candidate.shape[1]}x{candidate.shape[0]}  "
            f"bands with no visible hotspot: {dead}/{BANDS}"
        )
        print_profile(f"    profile at side {side}", stretched)

    # ------------------------------------------------------------------
    # how the profile is combined with the detail
    # ------------------------------------------------------------------
    settings.coarse_inference_side = 1024
    profile = pipeline._coarse_profile(image)
    if profile is not None:
        for name, combined in (
            ("product (current)", detail * profile),
            ("profile as a band weight", None),
        ):
            if combined is None:
                continue
            print_profile(f"combined, {name}", normalise_for_display(combined))

        # A band weight: the profile is reduced to one number per band, and
        # that number scales the detail inside the band.
        band_height = max(1, profile.shape[0] // BANDS)
        weighted = np.zeros_like(detail, dtype=np.float64)
        for index in range(BANDS):
            top = index * band_height
            bottom = min(profile.shape[0], top + band_height)
            if top >= bottom:
                continue
            band_mass = float(profile[top:bottom].sum())
            weighted[top:bottom] = detail[top:bottom] * band_mass
        print_profile("combined, band weight", normalise_for_display(weighted))

        # A gentler exponent: the product is damped so the detail survives.
        for power in (0.25, 0.5):
            combined = detail * (profile**power)
            print_profile(
                f"combined, product with profile^{power}", normalise_for_display(combined)
            )


if __name__ == "__main__":
    main()
