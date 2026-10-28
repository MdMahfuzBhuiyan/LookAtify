"""Extract LookAtify brand assets from the supplied logo image.

The source image is the master artwork the brand owner provided. This script
traces it into crisp vector assets and renders the extension icon set so the
extension and the docs stay pixel-consistent with the original design.

Outputs (all paths relative to the repository root):

    assets/brand/lookatify-logo-source.png   (untouched copy of the master)
    assets/brand/lookatify-wordmark.svg       (vector trace, full wordmark)
    assets/brand/lookatify-monogram.svg       (vector trace, stylized "A")
    assets/brand/lookatify-logo.png           (cropped raster, transparent)
    assets/brand/brand-palette.json           (colours sampled from the master)
    extension/icons/icon-{16,32,48,128}.png   (monogram in brand colour)

Usage:  python3 scripts/extract_brand.py
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND_DIR = ROOT / "assets" / "brand"
ICON_DIR = ROOT / "extension" / "icons"

SOURCE = BRAND_DIR / "lookatify-logo-source.png"
ALPHA_THRESHOLD = 128

# Monogram = the stylized "A" of "LookAtify" (two diagonals + crossbar),
# isolated from the wordmark by its column range in the master artwork.
MONOGRAM_BOX = (520, 295, 650, 435)

# Extension toolbar icons are drawn small, so the monogram is scaled up inside
# the icon box with a small transparent padding.
ICON_PADDING = 0.12


def load_mask() -> tuple[np.ndarray, np.ndarray]:
    """Return the RGBA source array and the boolean glyph mask."""
    image = Image.open(SOURCE).convert("RGBA")
    rgba = np.array(image)
    mask = rgba[:, :, 3] > ALPHA_THRESHOLD
    return rgba, mask


def trace_to_svg_path(mask: np.ndarray, offset: tuple[int, int] = (0, 0)) -> str:
    """Trace a binary mask into SVG path data using contour approximation."""
    contours, hierarchy = cv2.findContours(
        mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE
    )
    if hierarchy is None:
        raise RuntimeError("no contours found in mask")

    hierarchy = hierarchy[0]
    paths: list[str] = []
    for index, contour in enumerate(contours):
        # Drop contours that are too small to be meaningful at icon size.
        if cv2.contourArea(contour) < 4:
            continue
        epsilon = 0.0015 * cv2.arcLength(contour, True)
        simplified = cv2.approxPolyDP(contour, epsilon, True)
        points = simplified.reshape(-1, 2)
        if len(points) < 3:
            continue

        is_hole = hierarchy[index][3] != -1
        if is_hole:
            # Holes are cut out with the even-odd fill rule, so their winding
            # direction does not matter.
            points = points[::-1]

        x_offset, y_offset = offset
        commands = [f"M {points[0][0] + x_offset:.1f} {points[0][1] + y_offset:.1f}"]
        for x, y in points[1:]:
            commands.append(f"L {x + x_offset:.1f} {y + y_offset:.1f}")
        commands.append("Z")
        paths.append(" ".join(commands))

    return " ".join(paths)


def write_svg(path: Path, path_data: str, width: int, height: int, color: str) -> None:
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="LookAtify">
  <title>LookAtify</title>
  <path fill="{color}" fill-rule="evenodd" d="{path_data}"/>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def render_icon(monogram_mask: np.ndarray, size: int, color: tuple[int, int, int]) -> Image.Image:
    """Render the monogram into a square RGBA icon of the requested size."""
    ys, xs = np.nonzero(monogram_mask)
    crop = monogram_mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    glyph_h, glyph_w = crop.shape

    inner = int(size * (1 - 2 * ICON_PADDING))
    scale = min(inner / glyph_w, inner / glyph_h)
    new_w = max(1, int(round(glyph_w * scale)))
    new_h = max(1, int(round(glyph_h * scale)))

    resized = cv2.resize(crop.astype(np.uint8), (new_w, new_h), interpolation=cv2.INTER_AREA)
    resized = (resized > 0).astype(np.uint8)

    # Build an alpha canvas at icon size and paste the scaled glyph into it.
    alpha = Image.new("L", (size, size), 0)
    glyph_alpha = Image.fromarray((resized * 255).astype(np.uint8), mode="L")
    x_offset = (size - new_w) // 2
    y_offset = (size - new_h) // 2
    alpha.paste(glyph_alpha, (x_offset, y_offset))

    icon = Image.new("RGBA", (size, size), color + (0,))
    icon.putalpha(alpha)
    return icon


def main() -> None:
    BRAND_DIR.mkdir(parents=True, exist_ok=True)
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    rgba, mask = load_mask()
    ys, xs = np.nonzero(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())

    # Brand colour: the most common opaque pixel in the artwork.
    pixels = rgba[mask]
    colours, counts = np.unique(pixels[:, :3], axis=0, return_counts=True)
    dominant = colours[int(np.argmax(counts))]
    brand_rgb = tuple(int(channel) for channel in dominant)
    brand_hex = "#{:02x}{:02x}{:02x}".format(*brand_rgb)

    # Wordmark vector.
    wordmark_mask = mask[y0 : y1 + 1, x0 : x1 + 1]
    wordmark_path = trace_to_svg_path(wordmark_mask)
    write_svg(
        BRAND_DIR / "lookatify-wordmark.svg",
        wordmark_path,
        wordmark_mask.shape[1],
        wordmark_mask.shape[0],
        brand_hex,
    )

    # Monogram vector.
    mx0, my0, mx1, my1 = MONOGRAM_BOX
    monogram_mask = mask[my0 : my1 + 1, mx0 : mx1 + 1]
    monogram_path = trace_to_svg_path(monogram_mask)
    write_svg(
        BRAND_DIR / "lookatify-monogram.svg",
        monogram_path,
        monogram_mask.shape[1],
        monogram_mask.shape[0],
        brand_hex,
    )

    # Cropped raster logo with transparency.
    cropped = Image.open(SOURCE).convert("RGBA").crop((x0, y0, x1 + 1, y1 + 1))
    cropped.save(BRAND_DIR / "lookatify-logo.png")

    # Palette metadata.
    palette = {
        "brand": {
            "primary": brand_hex,
            "primary_rgb": list(brand_rgb),
            "description": "Muted plum-grey sampled from the supplied LookAtify wordmark.",
        },
        "usage": {
            "logo_source": "assets/brand/lookatify-logo-source.png",
            "wordmark_svg": "assets/brand/lookatify-wordmark.svg",
            "monogram_svg": "assets/brand/lookatify-monogram.svg",
            "logo_png": "assets/brand/lookatify-logo.png",
        },
    }
    (BRAND_DIR / "brand-palette.json").write_text(
        json.dumps(palette, indent=2) + "\n", encoding="utf-8"
    )

    # Extension icons.
    for size in (16, 32, 48, 128):
        render_icon(monogram_mask, size, brand_rgb).save(ICON_DIR / f"icon-{size}.png")

    print(f"brand colour: {brand_hex}")
    print(f"wordmark bbox: {wordmark_mask.shape[1]}x{wordmark_mask.shape[0]}")
    print(f"monogram bbox: {monogram_mask.shape[1]}x{monogram_mask.shape[0]}")
    print("icons written: 16, 32, 48, 128")


if __name__ == "__main__":
    main()
