#!/usr/bin/env python3
"""Measure the backend's attention output for a real captured page.

This is the regression check for the five reported bugs. It runs the real
pipeline over a page screenshot and prints the numbers the viewer shows, so
a change to the normalisation can be judged against the report:

* the heatmap must have visible hotspots, not a pale wash
* the attention must not be spread evenly over the page
* the top peaks must sit where the content is, not in the footer
* the analysis time must be non-zero

Usage:
    python scripts/check-attention.py [--page /tmp/bbc-real.png] [--url URL]
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import urllib.request

import numpy as np
from PIL import Image

#: The jet anchors, the same ones the server and the viewer use.
JET = [
    (0, 104, 55),
    (40, 190, 90),
    (220, 220, 40),
    (240, 150, 30),
    (220, 40, 30),
]


def jet_colour(position: float) -> tuple[int, int, int]:
    """The colour the viewer shows at a given 0..1 intensity."""
    anchors = np.array(JET, dtype=np.float64)
    positions = np.linspace(0.0, 1.0, len(anchors))
    channels = [np.interp(position, positions, anchors[:, index]) for index in range(3)]
    return tuple(int(round(channel)) for channel in channels)


def analyse(url: str, payload: bytes) -> tuple[dict, np.ndarray]:
    """Send the page to the backend and return the answer and the saliency."""
    boundary = "----lookatify"
    body = b""
    for name, value in [
        ("file", ("page.png", payload, "image/png")),
        ("colormap", "jet"),
        ("blur_sigma", "0"),
        ("opacity", "1.0"),
        ("top_n", "5"),
    ]:
        body += f"--{boundary}\r\n".encode()
        if isinstance(value, tuple):
            body += (
                f'Content-Disposition: form-data; name="{name}"; filename="{value[0]}"\r\n'
            ).encode()
            body += f"Content-Type: {value[2]}\r\n\r\n".encode() + value[1] + b"\r\n"
        else:
            body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            body += value.encode() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    request = urllib.request.Request(
        f"{url}/analyze",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    data = json.loads(urllib.request.urlopen(request, timeout=1800).read())
    saliency = np.array(
        Image.open(io.BytesIO(base64.b64decode(data["saliency_png_base64"])))
    ).astype(np.float64)
    return data, saliency


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--page", default="/tmp/bbc-real.png")
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    args = parser.parse_args()

    with open(args.page, "rb") as handle:
        payload = handle.read()
    image = Image.open(io.BytesIO(payload))
    print(f"page: {image.width} x {image.height}")

    data, saliency = analyse(args.url, payload)
    stats = data["stats"]
    height = saliency.shape[0]

    print("\n--- what the viewer reports ---")
    for warning in data["warnings"]:
        print(f"  warning: {warning}")
    print(f"  above fold:   {stats['above_fold_pct']}%")
    print(
        f"  thirds:       top {stats['thirds_pct']['top']}%  "
        f"middle {stats['thirds_pct']['middle']}%  bottom {stats['thirds_pct']['bottom']}%"
    )
    print(f"  left/right:   {stats['left_right_pct']['left']}% / {stats['left_right_pct']['right']}%")
    print(f"  timing_ms:    {data['timing_ms']}")
    for point in data["top_points"]:
        print(f"    #{point['rank']}  x={point['x']:<5} y={point['y']:<6} score={point['score']}")

    print("\n--- the heatmap the viewer paints (bug 1) ---")
    for percentile in (50, 75, 90, 95, 99, 99.9, 100):
        value = float(np.percentile(saliency, percentile)) / 255.0
        print(f"  p{percentile:<6} = {value:5.3f}  ->  jet {jet_colour(value)}")

    warm = float((saliency > 160).mean() * 100)
    hot = float((saliency > 210).mean() * 100)
    print(f"\n  pixels above the yellow band (>160): {warm:.3f}%")
    print(f"  pixels in the red band     (>210): {hot:.3f}%")

    print("\n--- attention by band (bugs 2 and 3) ---")
    probability = saliency / max(saliency.sum(), 1e-9)
    for name, top, bottom in [
        ("hero (0-900)", 0, 900),
        ("headline (900-1400)", 900, 1400),
        ("upper half (0-h/2)", 0, height // 2),
        ("lower half (h/2-h)", height // 2, height),
        ("footer (last 1200)", height - 1200, height),
    ]:
        band = saliency[top:bottom]
        print(
            f"  {name:<24} share {probability[top:bottom].sum() * 100:5.1f}%  "
            f"mean {band.mean():6.2f}  max {band.max():6.2f}"
        )

    third = height / 3
    print(
        f"\n  thirds: top {probability[: int(third)].sum() * 100:.1f}%  "
        f"middle {probability[int(third) : int(2 * third)].sum() * 100:.1f}%  "
        f"bottom {probability[int(2 * third) :].sum() * 100:.1f}%"
    )
    print(f"  above fold (800px): {probability[:800].sum() * 100:.1f}%")


if __name__ == "__main__":
    main()
