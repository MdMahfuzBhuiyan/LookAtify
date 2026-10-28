"""Tests for the heatmap helpers."""

from __future__ import annotations

import base64
import io

import numpy as np
import pytest
from PIL import Image

from app.heatmap import (
    available_colormaps,
    blur,
    colormap,
    colormap_with_alpha,
    composite,
    normalise,
    normalise_to_probability,
    to_base64_png,
    to_png_bytes,
)


def test_normalise_scales_to_zero_one() -> None:
    values = np.array([[0.0, 5.0], [10.0, 2.5]], dtype=np.float32)
    result = normalise(values)

    assert result.min() == pytest.approx(0.0)
    assert result.max() == pytest.approx(1.0)
    assert result[1, 0] == pytest.approx(1.0)


def test_normalise_handles_constant_array() -> None:
    """A constant map has no structure; it becomes uniform mid-grey."""
    result = normalise(np.full((4, 4), 7.0, dtype=np.float32))

    assert result.shape == (4, 4)
    assert np.all(result == 0.5)


def test_normalise_to_probability_sums_to_one() -> None:
    logits = np.linspace(-20.0, 0.0, 100).reshape(10, 10)
    probability = normalise_to_probability(logits)

    assert probability.sum() == pytest.approx(1.0)
    assert probability.min() >= 0.0
    assert probability.max() <= 1.0


def test_normalise_to_probability_survives_large_dynamic_range() -> None:
    """A single extreme logit must not underflow every other pixel to zero."""
    logits = np.zeros((10, 10), dtype=np.float64)
    logits[5, 5] = 500.0
    logits[0, 0] = -500.0

    probability = normalise_to_probability(logits)

    assert probability.sum() == pytest.approx(1.0)
    # The neighbouring pixels must retain a measurable share.
    assert probability[5, 4] > 0.0
    assert probability[5, 6] > 0.0


def test_colormap_produces_rgb_uint8() -> None:
    values = np.linspace(0.0, 1.0, 12).reshape(3, 4)
    rgb = colormap(values, "jet")

    assert rgb.shape == (3, 4, 3)
    assert rgb.dtype == np.uint8
    # Low attention is green, high attention is red in the Jet ramp.
    assert rgb[0, 0, 1] > rgb[0, 0, 0]
    assert rgb[-1, -1, 0] > rgb[-1, -1, 1]


def test_colormap_with_alpha_ramps_with_intensity() -> None:
    values = np.array([[0.0, 1.0]], dtype=np.float32)
    rgba = colormap_with_alpha(values, "viridis")

    assert rgba.shape == (1, 2, 4)
    assert rgba[0, 0, 3] == 0
    assert rgba[0, 1, 3] == 255


def test_blur_is_identity_for_zero_sigma() -> None:
    values = np.random.default_rng(0).random((16, 16)).astype(np.float32)
    assert np.array_equal(blur(values, 0), values)


def test_blur_spreads_a_spike() -> None:
    values = np.zeros((21, 21), dtype=np.float32)
    values[10, 10] = 1.0

    blurred = blur(values, 2.0)

    assert blurred[10, 10] < 1.0
    assert blurred[10, 11] > 0.0


def test_composite_blends_heatmap_over_original() -> None:
    original = np.zeros((4, 4, 3), dtype=np.uint8)
    heatmap = np.zeros((4, 4, 4), dtype=np.uint8)
    heatmap[..., 0] = 255  # pure red
    heatmap[..., 3] = 255  # fully opaque

    blended = composite(original, heatmap, opacity=1.0)

    assert blended[0, 0, 0] == 255
    assert blended[0, 0, 1] == 0


def test_composite_respects_opacity() -> None:
    original = np.zeros((4, 4, 3), dtype=np.uint8)
    heatmap = np.zeros((4, 4, 4), dtype=np.uint8)
    heatmap[..., 0] = 255
    heatmap[..., 3] = 255

    blended = composite(original, heatmap, opacity=0.5)

    assert blended[0, 0, 0] == pytest.approx(128, abs=2)


def test_to_png_bytes_encodes_grayscale_and_rgb() -> None:
    gray = np.zeros((8, 8), dtype=np.uint8)
    rgb = np.zeros((8, 8, 3), dtype=np.uint8)

    for payload in (to_png_bytes(gray), to_png_bytes(rgb)):
        with Image.open(io.BytesIO(payload)) as image:
            assert image.width == 8
            assert image.height == 8


def test_to_base64_png_is_decodable() -> None:
    array = np.full((4, 4, 3), 128, dtype=np.uint8)

    encoded = to_base64_png(array)

    with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
        assert image.size == (4, 4)


def test_to_png_bytes_rejects_invalid_shapes() -> None:
    with pytest.raises(ValueError):
        to_png_bytes(np.zeros((4, 4, 5), dtype=np.uint8))


def test_all_documented_colormaps_are_available() -> None:
    names = available_colormaps()

    for expected in ("jet", "turbo", "viridis", "hot", "colorblind"):
        assert expected in names
