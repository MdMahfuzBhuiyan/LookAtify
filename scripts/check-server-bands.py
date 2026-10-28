#!/usr/bin/env python3
"""Check the saliency map the server actually returns, band by band.

This is the end-to-end check of the reported failure: the first and last
band of a long page had a heatmap and everything in between was blank.

The page is sent to the running server over HTTP, and the saliency map from
the response is measured. Every band has to reach the yellow part of the
colormap, or the viewer paints it as a plain green wash with no hotspot.

Usage:
    python scripts/check-server-bands.py [--page /tmp/page.png] [--url URL]
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import urllib.request

import numpy as np
from PIL import Image

BANDS = 10

#: The intensity at which the jet colormap turns yellow. Below it the
#: heatmap is only a green wash, which is not a visible hotspot.
YELLOW = 0.55


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--page", default="/tmp/page.png")
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--token", default="")
    arguments = parser.parse_args()

    with open(arguments.page, "rb") as handle:
        image_bytes = handle.read()

    boundary = "----lookatifybandcheck"
    parts = [
        f"--{boundary}\r\n",
        'Content-Disposition: form-data; name="image"; filename="page.png"\r\n',
        "Content-Type: image/png\r\n\r\n",
    ]
    head = "".join(parts).encode("utf-8") + image_bytes + f"\r\n--{boundary}\r\n".encode("utf-8")
    tail = (
        f'Content-Disposition: form-data; name="mode"\r\n\r\nblended\r\n'
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="colormap"\r\n\r\njet\r\n'
        f"--{boundary}--\r\n"
    ).encode("utf-8")

    request = urllib.request.Request(
        f"{arguments.url}/analyze",
        data=head + tail,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            **({"Authorization": f"Bearer {arguments.token}"} if arguments.token else {}),
        },
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=600) as response:
        payload = json.loads(response.read())

    saliency = np.array(
        Image.open(io.BytesIO(base64.b64decode(payload["saliency_png_base64"]))).convert("L"),
        dtype=np.float64,
    ) / 255.0

    height = saliency.shape[0]
    print(f"the server returned a saliency map of {saliency.shape[1]} x {height}")

    band_height = max(1, height // BANDS)
    print(f"  {'band':>12}  {'max':>8}  {'>yellow':>9}")
    invisible = []
    for index in range(BANDS):
        top = index * band_height
        bottom = min(height, top + band_height)
        if top >= bottom:
            break
        band = saliency[top:bottom]
        yellow = float((band > YELLOW).mean() * 100.0)
        if band.max() <= YELLOW:
            invisible.append(index)
        print(f"  {top:>6}-{bottom:<5}  {band.max():>8.4f}  {yellow:>8.2f}%")

    stats = payload.get("stats", {})
    print("\nthe statistics the viewer shows:")
    print(f"  above the fold: {stats.get('above_fold_pct')}%")
    print(f"  thirds: {stats.get('thirds')}")
    print(f"  timing: {payload.get('timing_ms')}")

    points = payload.get("top_points", [])
    print("\nthe top attention points:")
    for point in points:
        print(f"  y={point.get('y')}  score={point.get('score')}")

    if invisible:
        print(f"\nFAIL: {len(invisible)} band(s) have no visible hotspot: {invisible}")
        raise SystemExit(1)
    print("\nPASS: every band of the page has a visible hotspot")


if __name__ == "__main__":
    main()
