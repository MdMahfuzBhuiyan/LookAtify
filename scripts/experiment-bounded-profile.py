#!/usr/bin/env python3
"""Measure the candidate fix for the empty middle of a long page.

What the measurements showed so far:

* the per-tile detail map has real hotspots everywhere, so the inference is
  fine;
* the whole-page profile is what crushes the middle: it is built from a
  strip that is far outside the model's training distribution, and on a very
  long page that strip is 1:10, so the profile is dead over the middle;
* a profile that can switch a band off completely is the wrong thing to
  multiply the detail with, because the content inside that band is then
  lost even when the content is strong.

The candidate here bounds the profile so it can never erase a band. The
bound only ever *compresses* the contrast, so it cannot make a page worse:

    bounded = floor + (1 - floor) * profile / max(profile)

It is a monotone transform of the profile, so the ranking of the bands — and
therefore the top attention points — does not change. Only the size of the
differences shrinks.

The profile itself is also measured two ways: as the tall strip it is today,
and as a square reshape of the page, which the model sees as an ordinary
image.

Usage:
    python scripts/experiment-bounded-profile.py
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
CACHE = Path(".tmp-logs/tile-logits.pkl")


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


def square_profile(pipeline, image: np.ndarray, side: int) -> np.ndarray | None:
    """A profile from the page reshaped into a square.

    The model sees an ordinary image, so its output is meaningful. The
    vertical profile of that image is then stretched over the page.
    """
    height, width = image.shape[:2]
    with Image.fromarray(image, mode="RGB") as source:
        square = np.array(source.resize((side, side), Image.LANCZOS))
    logits = pipeline._infer_tile(square)
    probability = normalise_to_probability(logits)
    column = probability.mean(axis=1)
    column = column / (float(column.sum()) or 1.0)
    profile = np.repeat(column[:, None], width, axis=1)
    return pipeline._resize_float(profile, (height, width))


def bound_profile(profile: np.ndarray, floor: float) -> np.ndarray:
    """Bound a profile so it can never switch a band off.

    Only the contrast is compressed, so the ranking of the bands stays the
    same.
    """
    values = np.asarray(profile, dtype=np.float64)
    maximum = float(values.max()) or 1.0
    return floor + (1.0 - floor) * (values / maximum)


def report(name: str, values: np.ndarray, probability: np.ndarray) -> dict:
    """Report the visible bands and the attention shares of a candidate."""
    display = normalise_for_display(values)
    rows = band_rows(display)
    dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
    shares = [share for share, _, _ in band_rows(probability)]
    total = float(probability.sum()) or 1.0
    probability = probability / total

    print(f"    {name:>44}  dead {dead:>2}/{BANDS}  ", end="")
    print(
        f"top {sum(shares[:3]):>5.1f}%  mid {sum(shares[3:7]):>5.1f}%  "
        f"bottom {sum(shares[7:]):>5.1f}%  spread {max(shares) - min(shares):>5.1f}"
    )
    return {
        "name": name,
        "dead": dead,
        "spread": max(shares) - min(shares),
        "top": sum(shares[:3]),
    }


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

    CACHE.parent.mkdir(parents=True, exist_ok=True)

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

        key = f"{path.name}-{len(tiles)}-{scale:.4f}"
        cache_file = CACHE.with_suffix(f".{key}.pkl")
        if cache_file.exists():
            with cache_file.open("rb") as handle:
                tile_logits = pickle.load(handle)
            print(f"  loaded {len(tile_logits)} cached tile logits")
        else:
            tile_logits = [pipeline._infer_tile(t) for t in tile_images]
            with cache_file.open("wb") as handle:
                pickle.dump(tile_logits, handle)
            print(f"  computed {len(tile_logits)} tile logits")

        detail = pipeline._blend_tiles(tile_logits, tiles, (width, height), scale)
        strip = pipeline._coarse_profile(image)
        square = square_profile(pipeline, image, 768)

        print("\n  the profile per band (the share of the page's attention)")
        for label, profile in (("strip (today)", strip), ("square reshape", square)):
            if profile is None:
                continue
            rows = band_rows(profile)
            print(
                f"    {label:>18}: "
                + " ".join(f"{share:>5.1f}" for share, _, _ in rows)
            )

        print("\n  the candidates")
        report("today: detail x strip", detail * strip, detail * strip)

        for floor in (0.25, 0.35, 0.5):
            report(
                f"detail x bounded strip (floor {floor})",
                detail * bound_profile(strip, floor),
                detail * bound_profile(strip, floor),
            )

        if square is not None:
            for floor in (0.25, 0.35, 0.5):
                report(
                    f"detail x bounded square (floor {floor})",
                    detail * bound_profile(square, floor),
                    detail * bound_profile(square, floor),
                )

        report("detail alone (no profile)", detail, detail)


if __name__ == "__main__":
    import pickle

    main()
