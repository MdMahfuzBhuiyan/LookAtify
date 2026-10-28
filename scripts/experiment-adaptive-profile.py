#!/usr/bin/env python3
"""Test the adaptive compression of the whole-page profile.

The measurements showed that the empty middle of a long page comes from the
whole-page profile being far too steep: on a 14,000 px page the profile gives
the first band 27.7% of the attention and a band in the middle 6%, a ratio
of 7.3. Multiplied with the per-tile detail, that crushes every local
hotspot in the middle of the page below the visible part of the colormap.

A page whose profile is already reasonable — a ratio of about 1.4 — must not
be changed, because for such a page the profile is what lifts the local
hotspots above the visible threshold.

So the profile is compressed only when it is steeper than a limit. The
compression is a power, which is monotone, so the ranking of the bands does
not change, and the statistics and the top points are untouched.

Usage:
    python scripts/experiment-adaptive-profile.py
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


def profile_steepness(profile: np.ndarray) -> float:
    """How much stronger the strongest band is than the weakest one."""
    rows = band_rows(profile)
    maxima = [maximum for _, _, maximum in rows]
    low = float(min(maxima))
    high = float(max(maxima))
    if low <= 0:
        return 1.0
    return high / low


def compress_profile(profile: np.ndarray, limit: float) -> tuple[np.ndarray, float]:
    """Compress a profile when it is steeper than ``limit``.

    :returns: the compressed profile and the exponent that was used.
    """
    values = np.asarray(profile, dtype=np.float64)
    steepness = profile_steepness(values)

    if steepness <= limit or steepness <= 1.0:
        return values, 1.0

    # The power that brings the steepness down to the limit.
    exponent = float(np.log(limit) / np.log(steepness))
    maximum = float(values.max()) or 1.0
    return (values / maximum) ** exponent, exponent


def report(name: str, display_source: np.ndarray, probability: np.ndarray) -> dict:
    """Report the visible bands and the attention shares of a display map."""
    display = normalise_for_display(display_source)
    rows = band_rows(display)
    dead = sum(1 for _, _, maximum in rows if maximum <= 0.5)
    washed = float((display > 0.5).mean() * 100.0)
    shares = [share for share, _, _ in band_rows(probability)]

    print(
        f"    {name:>44}  dead {dead:>2}/{BANDS}  washed {washed:>5.1f}%  "
        f"top {sum(shares[:3]):>5.1f}%  mid {sum(shares[3:7]):>5.1f}%  "
        f"bottom {sum(shares[7:]):>5.1f}%  spread {max(shares) - min(shares):>5.1f}"
    )
    return {"name": name, "dead": dead, "washed": washed}


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

        print(f"  the steepness of the profile: {profile_steepness(profile):.2f}")

        # The statistics and the peaks keep the raw profile.
        probability = (
            pipeline._apply_global_profile(detail, profile) if profile is not None else detail
        )

        print("\n  the display map")
        report("today: detail x profile", detail * profile, probability)

        for limit in (1.5, 1.6, 2.0, 2.5):
            compressed, exponent = compress_profile(profile, limit)
            report(
                f"detail x compressed profile (limit {limit}, x^{exponent:.2f})",
                detail * compressed,
                probability,
            )


if __name__ == "__main__":
    main()
