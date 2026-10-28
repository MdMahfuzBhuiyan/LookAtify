#!/usr/bin/env python3
"""Test the final design: one map for the statistics, one for the display.

The two maps do different jobs and a single map cannot do both:

* the *probability* map answers "where does the attention go". It keeps the
  whole-page profile, so the thirds, the above-the-fold share and the top
  points keep the global ranking.
* the *display* map answers "where is the hotspot I can see". It may not let
  the profile switch a band off, or the content of that band is lost even
  when the content is strong.

The display map uses the profile raised to a power. Raising to a power is
monotone, so the ranking of the bands does not change, and it is smooth, so
no hard step appears that would show up as a horizontal line.

This script measures, for every page:

* how many bands have a visible hotspot;
* how much of the page is washed out;
* the biggest jump between neighbouring rows, so a seam would be caught;
* the attention shares, which must not change.

Usage:
    python scripts/experiment-final-design.py
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
from app.heatmap import normalise_for_display  # noqa: E402
from app.model import SaliencyModel  # noqa: E402
from app.pipeline import AnalysisPipeline  # noqa: E402

BANDS = 10
CACHE_DIR = Path(".tmp-logs")


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


def biggest_row_jump(values: np.ndarray) -> tuple[int, float]:
    """The largest jump between neighbouring rows, and where it is.

    A seam in the stitched image shows up as a row that is much brighter or
    much darker than the rows around it. The jump has to be compared with
    the typical jump, or every real edge would be reported.
    """
    rows = values.mean(axis=1)
    jumps = np.abs(np.diff(rows))
    if jumps.size == 0:
        return 0, 0.0
    typical = float(np.median(jumps)) or 1e-6
    index = int(np.argmax(jumps))
    return index, float(jumps[index] / typical)


def report(
    name: str,
    display_source: np.ndarray,
    probability: np.ndarray,
    boundaries: list[int],
) -> dict:
    """Report the visible bands, the wash and the seams of a display map."""
    display = normalise_for_display(display_source)
    rows = band_rows(display)
    dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
    washed = float((display > 0.5).mean() * 100.0)
    shares = [share for share, _, _ in band_rows(probability)]
    jump_y, jump = biggest_row_jump(display)

    seam_hits = [
        boundary for boundary in boundaries if abs(boundary - jump_y) <= 2
    ]

    print(
        f"    {name:>40}  dead {dead:>2}/{BANDS}  washed {washed:>5.1f}%  "
        f"seam {'YES' if seam_hits else 'no ':>3} (jump {jump:>5.1f}x at y={jump_y})  "
        f"top {sum(shares[:3]):>5.1f}%  mid {sum(shares[3:7]):>5.1f}%  "
        f"bottom {sum(shares[7:]):>5.1f}%"
    )
    return {
        "name": name,
        "dead": dead,
        "washed": washed,
        "seam": bool(seam_hits),
        "top": sum(shares[:3]),
        "mid": sum(shares[3:7]),
        "bottom": sum(shares[7:]),
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
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    for page_path in arguments.page:
        path = Path(page_path)
        if not path.exists():
            continue

        with Image.open(path) as source:
            image = np.array(source.convert("RGB"))
        height, width = image.shape[:2]
        print(f"\n\n========== {path.name} ({width} x {height}) ==========")

        tiles, tile_images, scale = pipeline._plan_tiles(image)

        cache_file = CACHE_DIR / f"logits-{path.name}.pkl"
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
        profile = pipeline._coarse_profile(image)

        # The boundaries between the tiles, in page pixels.
        boundaries = [
            round(tile.top / scale) for tile in tiles[1:] if tile.top / scale < height
        ]

        # The probability map: the statistics and the peaks use this one.
        probability = (
            pipeline._apply_global_profile(detail, profile) if profile is not None else detail
        )

        maximum = float(profile.max()) or 1.0
        normalised = profile / maximum

        print("\n  the display map")
        report("today: detail x profile", detail * profile, probability, boundaries)

        for gamma in (0.25, 0.35, 0.5):
            report(
                f"detail x profile^{gamma}",
                detail * (normalised**gamma),
                probability,
                boundaries,
            )

        print("\n  the display map, with the profile limited to the page's rows")
        # The profile is a map with a value for every pixel. Only its vertical
        # shape matters, so it is reduced to one weight per row first.
        from scipy.ndimage import gaussian_filter

        rows = gaussian_filter(
            profile.mean(axis=1), sigma=max(2.0, height / 200.0), mode="nearest"
        )
        row_max = float(rows.max()) or 1.0
        row_profile = (rows / row_max)[:, None]

        for gamma in (0.25, 0.35, 0.5):
            report(
                f"detail x row profile^{gamma}",
                detail * (row_profile**gamma),
                probability,
                boundaries,
            )


if __name__ == "__main__":
    main()
