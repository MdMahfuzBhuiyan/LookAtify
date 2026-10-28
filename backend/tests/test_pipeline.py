"""Tests for the tiling pipeline and the upload/security helpers."""

from __future__ import annotations

import itertools

import numpy as np
import pytest

from app.config import Settings
from app.pipeline import MODEL_STRIDE, AnalysisPipeline
from app.security import RateLimiter, detect_image_type, validate_upload


# ----------------------------------------------------------------------
# tiling
# ----------------------------------------------------------------------
def test_single_tile_for_a_short_page() -> None:
    pipeline = AnalysisPipeline(None, Settings())
    image = np.zeros((500, 800, 3), dtype=np.uint8)

    tiles, tile_images, scale = pipeline._plan_tiles(image)

    assert len(tiles) == 1
    assert scale == pytest.approx(1.0)
    assert tile_images[0].shape == (500, 800, 3)


def test_tiles_cover_the_full_width_and_height() -> None:
    pipeline = AnalysisPipeline(None, Settings(tile_height=640, tile_overlap=96))
    image = np.zeros((3000, 1440, 3), dtype=np.uint8)

    tiles, tile_images, scale = pipeline._plan_tiles(image)

    assert scale < 1.0  # the page is narrowed to the inference width
    assert len(tiles) > 1
    # Every tile spans the whole (scaled) width.
    assert all(tile.left == 0 for tile in tiles)
    assert all(tile.right == tiles[0].right for tile in tiles)
    # The tiles cover the page without gaps.
    for previous, current in itertools.pairwise(tiles):
        assert current.top < previous.bottom  # they overlap
    assert tiles[0].top == 0
    assert tiles[-1].bottom == max(tile.bottom for tile in tiles)


def test_downscale_strategy_produces_one_tile() -> None:
    settings = Settings(long_page_strategy="downscale", max_inference_side=512)
    pipeline = AnalysisPipeline(None, settings)
    image = np.zeros((3000, 1440, 3), dtype=np.uint8)

    tiles, tile_images, scale = pipeline._plan_tiles(image)

    assert len(tiles) == 1
    assert scale == pytest.approx(512 / 3000)
    assert max(tile_images[0].shape[:2]) == 512


def test_tiles_are_stride_aligned_after_padding() -> None:
    """Every tile must be padded to a multiple of the model stride."""
    pipeline = AnalysisPipeline(None, Settings(tile_height=640))
    image = np.zeros((2000, 1000, 3), dtype=np.uint8)

    tiles, tile_images, _ = pipeline._plan_tiles(image)

    for _tile, tile_image in zip(tiles, tile_images, strict=False):
        padded_height = int(np.ceil(tile_image.shape[0] / MODEL_STRIDE) * MODEL_STRIDE)
        assert padded_height % MODEL_STRIDE == 0


def test_blend_covers_every_pixel_of_the_original() -> None:
    pipeline = AnalysisPipeline(None, Settings())
    logits = [np.zeros((100, 200), dtype=np.float32) for _ in range(2)]
    from app.pipeline import Tile

    tiles = [
        Tile(index=0, top=0, bottom=100, left=0, right=200),
        Tile(index=1, top=80, bottom=180, left=0, right=200),
    ]

    blended = pipeline._blend_tiles(logits, tiles, (200, 180), scale=1.0)

    assert blended.shape == (180, 200)
    assert np.any(blended > 0)


def test_blend_has_no_seam_between_tiles() -> None:
    """A constant map must blend into a constant map — no visible seam."""
    pipeline = AnalysisPipeline(None, Settings())
    from app.pipeline import Tile

    constant = np.zeros((100, 200), dtype=np.float32)
    tiles = [
        Tile(index=0, top=0, bottom=100, left=0, right=200),
        Tile(index=1, top=80, bottom=180, left=0, right=200),
    ]

    blended = pipeline._blend_tiles([constant, constant], tiles, (200, 180), scale=1.0)

    # A seam would show up as a row that differs strongly from its neighbours.
    row_means = blended.mean(axis=1)
    assert float(row_means.std()) < 1e-6


# ----------------------------------------------------------------------
# security
# ----------------------------------------------------------------------
def test_detect_image_type_recognises_png() -> None:
    assert detect_image_type(b"\x89PNG\r\n\x1a\n" + b"0" * 20) == "image/png"


def test_detect_image_type_rejects_non_images() -> None:
    assert detect_image_type(b"MZ\x90\x00") is None


def test_validate_upload_accepts_a_png(sample_png: bytes) -> None:
    validate_upload(sample_png, "image/png", Settings())


def test_validate_upload_rejects_oversized_files(sample_png: bytes) -> None:
    settings = Settings(max_upload_bytes=10)

    with pytest.raises(ValueError, match="larger than"):
        validate_upload(sample_png, "image/png", settings)


def test_validate_upload_rejects_wrong_content_type(sample_png: bytes) -> None:
    with pytest.raises(ValueError, match="Unsupported content type"):
        validate_upload(sample_png, "text/html", Settings())


def test_validate_upload_rejects_mismatched_magic_bytes(sample_png: bytes) -> None:
    with pytest.raises(ValueError, match="does not match"):
        validate_upload(sample_png, "image/jpeg", Settings())


def test_validate_upload_rejects_empty_payload() -> None:
    with pytest.raises(ValueError, match="empty"):
        validate_upload(b"", "image/png", Settings())


def test_validate_upload_rejects_excessive_resolution(sample_png: bytes) -> None:
    settings = Settings(max_image_pixels=10)

    with pytest.raises(ValueError, match="too large"):
        validate_upload(sample_png, "image/png", settings)


# ----------------------------------------------------------------------
# rate limiting
# ----------------------------------------------------------------------
def test_rate_limiter_allows_up_to_the_limit() -> None:
    limiter = RateLimiter(limit=3, window_seconds=60)

    assert limiter.allow("client") is True
    assert limiter.allow("client") is True
    assert limiter.allow("client") is True
    assert limiter.allow("client") is False


def test_rate_limiter_tracks_clients_separately() -> None:
    limiter = RateLimiter(limit=1, window_seconds=60)

    assert limiter.allow("a") is True
    assert limiter.allow("b") is True
    assert limiter.allow("a") is False


def test_rate_limiter_reset_clears_counters() -> None:
    limiter = RateLimiter(limit=1, window_seconds=60)
    limiter.allow("a")

    limiter.reset(["a"])

    assert limiter.allow("a") is True
