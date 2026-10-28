#!/usr/bin/env python3
"""Compare the display stretch on top of the fixed profile.

The profile fix stops the middle of a long page from being crushed. The
remaining bands sit just below the yellow part of the colormap: they are
painted, but only in green, so they still read as "no hotspot".

The stretch decides how much of the colormap the page uses. This measures
the candidates on three things:

* how many bands have a hotspot that reaches yellow;
* how much of the page reaches red, so the hotspots stand out;
* how much of the page is a flat green wash, which was the first bug.

Usage:
    python scripts/experiment-stretch-final.py
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
from app.pipeline import PROFILE_STEEPNESS_LIMIT, AnalysisPipeline  # noqa: E402

BANDS = 10
CACHE_DIR = Path(".tmp-logs")
YELLOW = 0.55
RED = 0.8


def stretch_percentile(values: np.ndarray, low: float, high: float, steepness: float) -> np.ndarray:
    """Stretch a map with the given percentiles and curve."""
    values = np.asarray(values, dtype=np.float32)
    low_value = float(np.percentile(values, low))
    high_value = float(np.percentile(values, high))
    span = high_value - low_value
    if span < 1e-12:
        return np.full_like(values, 0.5)
    scaled = (values - low_value) / span
    softened = np.log1p(np.exp(np.clip(scaled * steepness, -30.0, 30.0))) / steepness
    return np.clip(softened, 0.0, 1.0).astype(np.float32)


def stretch_log(values: np.ndarray, low: float, high: float) -> np.ndarray:
    """Stretch a map on a logarithmic scale.

    A saliency map spans several orders of magnitude, so the low end holds
    many more pixels than the high end. A logarithmic scale gives the low
    end more room, which is what a long page needs.
    """
    values = np.asarray(values, dtype=np.float64)
    positive = np.maximum(values, 1e-12)
    logged = np.log(positive)
    low_value = float(np.percentile(logged, low))
    high_value = float(np.percentile(logged, high))
    span = high_value - low_value
    if span < 1e-12:
        return np.full(values.shape, 0.5, dtype=np.float32)
    scaled = np.clip((logged - low_value) / span, 0.0, 1.0)
    # A gentle curve so the very bottom stays continuous.
    softened = np.log1p(np.exp(np.clip(scaled * 6.0, -30.0, 30.0))) / 6.0
    return np.clip(softened, 0.0, 1.0).astype(np.float32)


def report(name: str, display: np.ndarray) -> dict:
    """Report the hotspots of a display map."""
    height = display.shape[0]
    band_height = max(1, height // BANDS)
    maxima = []
    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        if top >= bottom:
            break
        maxima.append(float(display[top:bottom].max()))

    dead = sum(1 for value in maxima if value <= YELLOW)
    yellow = float((display > YELLOW).mean() * 100.0)
    red = float((display > RED).mean() * 100.0)

    print(
        f"    {name:>40}  dead {dead:>2}/{BANDS}  yellow {yellow:>5.2f}%  "
        f"red {red:>5.2f}%  band max: "
        + " ".join(f"{value:>5.2f}" for value in maxima)
    )
    return {"name": name, "dead": dead, "yellow": yellow, "red": red}


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
        else:
            tile_logits = [pipeline._infer_tile(t) for t in tile_images]
            with cache_file.open("wb") as handle:
                pickle.dump(tile_logits, handle)

        detail = pipeline._blend_tiles(tile_logits, tiles, (width, height), scale)
        profile = pipeline._coarse_profile(image)

        display_intensity = detail
        if profile is not None:
            compressed = pipeline._compress_profile(profile, PROFILE_STEEPNESS_LIMIT)
            display_intensity = pipeline._apply_global_profile(detail, compressed)

        print("\n  the stretch")
        report("today (p10-p99.5, softplus 12)", normalise_for_display(display_intensity))
        report("p10-p99 (softplus 12)", stretch_percentile(display_intensity, 10.0, 99.0, 12.0))
        report("p10-p99.5 (softplus 6)", stretch_percentile(display_intensity, 10.0, 99.5, 6.0))
        report("p10-p99.5 (softplus 4)", stretch_percentile(display_intensity, 10.0, 99.5, 4.0))
        report("p25-p99.5 (softplus 8)", stretch_percentile(display_intensity, 25.0, 99.5, 8.0))
        report("log p50-p99.9", stretch_log(display_intensity, 50.0, 99.9))
        report("log p25-p99.9", stretch_log(display_intensity, 25.0, 99.9))
        report("log p10-p99.9", stretch_log(display_intensity, 10.0, 99.9))


if __name__ == "__main__":
    main()
