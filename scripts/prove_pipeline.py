"""Step 2 proof: run DeepGaze on a real image and write the heatmap to disk.

Usage:
    python3 scripts/prove_pipeline.py [path/to/image.png]

With no argument the script generates a synthetic web-page-like test image so
it runs on a clean checkout.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.analytics import compute_stats, find_peaks  # noqa: E402
from app.config import settings  # noqa: E402
from app.heatmap import (  # noqa: E402
    blur,
    colormap_with_alpha,
    composite,
    normalise,
    normalise_to_probability,
    to_png_bytes,
)
from app.model import SaliencyModel  # noqa: E402

OUT_DIR = ROOT / "assets" / "proof"


def make_test_page(width: int = 1440, height: int = 2400) -> Image.Image:
    """Draw a synthetic marketing page with a clear hierarchy."""
    image = Image.new("RGB", (width, height), "#ffffff")
    draw = ImageDraw.Draw(image)

    draw.rectangle([0, 0, width, 90], fill="#1b1b2f")
    draw.text((40, 40), "ACME  nav  pricing  docs  sign in", fill="#dddddd")

    draw.text((80, 220), "Ship faster with LookAtify", fill="#111111")
    draw.text((80, 300), "Visual attention analysis for modern web teams.", fill="#555555")
    draw.rounded_rectangle([80, 380, 380, 440], radius=8, fill="#c2703d")
    draw.text((140, 402), "Get started", fill="#ffffff")
    draw.rounded_rectangle([410, 380, 660, 440], radius=8, fill="#e4e4e4")
    draw.text((460, 402), "Read the docs", fill="#333333")

    # A large hero image block, the most attention-grabbing element.
    draw.rectangle([80, 520, width - 80, 1100], fill="#d7e3f0")
    draw.ellipse([300, 600, 700, 1000], fill="#7fa8d0")

    for index, y in enumerate(range(1180, height - 200, 260)):
        draw.rectangle([80, y, 520, y + 180], fill="#efefef")
        draw.text((100, y + 20), f"Feature {index + 1}", fill="#444444")
        draw.text((100, y + 60), "Short supporting copy that is easy to skip.", fill="#777777")
        draw.text((600, y + 40), "Learn more", fill="#c2703d")

    draw.rectangle([0, height - 120, width, height], fill="#1b1b2f")
    draw.text((80, height - 70), "footer links", fill="#999999")
    return image


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if len(sys.argv) > 1:
        source = Image.open(sys.argv[1]).convert("RGB")
        print(f"Loaded test image: {source.size}")
    else:
        source = make_test_page()
        print(f"Generated test image: {source.size}")

    array = np.array(source)

    print("Loading model (this downloads weights on first run)...")
    model = SaliencyModel(settings)
    model.load()
    print(f"  device={model.device} version={model.model_version}")

    from app.pipeline import AnalysisPipeline

    pipeline = AnalysisPipeline(model, settings)
    from app.schemas import AnalyzeOptions

    options = AnalyzeOptions(colormap="jet", blur_sigma=0.0, opacity=0.55, top_n=5)

    print("Running pipeline...")
    started = time.perf_counter()
    result = pipeline.analyze(to_png_bytes(array), options)
    elapsed = time.perf_counter() - started

    saliency = np.array(Image.open(__import__("io").BytesIO(
        __import__("base64").b64decode(result.saliency_png_base64)
    )))
    heatmap = np.array(Image.open(__import__("io").BytesIO(
        __import__("base64").b64decode(result.heatmap_png_base64)
    )))

    blended = composite(array, heatmap, options.opacity)

    (OUT_DIR / "proof-original.png").write_bytes(to_png_bytes(array))
    (OUT_DIR / "proof-saliency.png").write_bytes(to_png_bytes(saliency))
    (OUT_DIR / "proof-heatmap.png").write_bytes(to_png_bytes(heatmap))
    (OUT_DIR / "proof-blended.png").write_bytes(to_png_bytes(blended))

    print()
    print(f"analysis_id  : {result.analysis_id}")
    print(f"size         : {result.width}x{result.height}")
    print(f"timing_ms    : {result.timing_ms.model_dump()}")
    print(f"wall clock   : {elapsed:.2f}s")
    print(f"top points   : {[(p.rank, p.x, p.y, round(p.score, 4)) for p in result.top_points]}")
    print(f"stats        : {result.stats.model_dump()}")
    print(f"warnings     : {result.warnings}")
    print(f"outputs      : {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
