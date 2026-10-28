#!/usr/bin/env python3
"""Report where the attention sits in a saved stage image.

The pipeline saves one image per stage in ``/tmp/lookatify-bands``. This
prints the band profile of each of them, so the stage that loses the middle
of the page is easy to see.

Usage:
    python scripts/report-stage-bands.py [--dir /tmp/lookatify-bands]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

BANDS = 20


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="/tmp/lookatify-bands")
    arguments = parser.parse_args()

    directory = Path(arguments.dir)

    for path in sorted(directory.glob("*.png")):
        with Image.open(path) as source:
            values = np.array(source.convert("L"), dtype=np.float64) / 255.0

        height = values.shape[0]
        band_height = max(1, height // BANDS)
        print(f"\n=== {path.name} ({values.shape[1]}x{values.shape[0]}) ===")
        print(f"    {'band':>12}  {'mean':>8}  {'max':>8}  {'>0.5':>7}")
        for index in range(BANDS):
            top = index * band_height
            bottom = min(height, top + band_height)
            if top >= bottom:
                break
            band = values[top:bottom]
            visible = float((band > 0.5).mean() * 100.0)
            tag = " <-- first" if index == 0 else (" <-- last" if index == BANDS - 1 else "")
            print(
                f"    {top:>6}-{bottom:<5}  {band.mean():>8.4f}  {band.max():>8.4f}  "
                f"{visible:>6.2f}%{tag}"
            )


if __name__ == "__main__":
    main()
