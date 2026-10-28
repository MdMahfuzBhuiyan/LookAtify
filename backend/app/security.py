"""Security helpers: token auth, upload validation and rate limiting.

Uploads are validated on three axes — declared content type, magic bytes and
decoded dimensions — so a renamed executable or a decompression bomb cannot
reach the model.
"""

from __future__ import annotations

import io
import time
from collections import defaultdict, deque
from collections.abc import Iterable

from fastapi import HTTPException, Request

from .config import Settings

#: Leading bytes of the image formats we accept.
_IMAGE_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
)

_ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/webp",
    "application/octet-stream",
}


def detect_image_type(data: bytes) -> str | None:
    """Return the detected image MIME type, or ``None`` when unrecognised."""
    for magic, mime in _IMAGE_MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def enforce_token(request: Request, expected_token: str) -> None:
    """Require ``Authorization: Bearer <token>`` when a token is configured.

    When no token is configured the endpoint stays open, which is convenient
    for local development but must not be used in production.
    """
    if not expected_token:
        return

    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "missing_token",
                "message": "Missing API token. Send 'Authorization: Bearer <token>'.",
            },
        )
    if header[7:].strip() != expected_token:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "invalid_token",
                "message": "The API token was rejected.",
            },
        )


def client_identity(request: Request) -> str:
    """Identify the caller for rate limiting (token first, then client host)."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return f"token:{header[7:].strip()}"
    return f"host:{request.client.host if request.client else 'unknown'}"


def validate_upload(
    data: bytes,
    content_type: str | None,
    settings: Settings,
) -> None:
    """Validate the uploaded bytes, raising ``ValueError`` with a clear reason."""
    if not data:
        raise ValueError("The uploaded image is empty.")

    if len(data) > settings.max_upload_bytes:
        limit_mb = settings.max_upload_bytes / (1024 * 1024)
        raise ValueError(f"The image is larger than the {limit_mb:.0f} MB limit.")

    if content_type:
        normalised = content_type.split(";")[0].strip().lower()
        if normalised not in _ALLOWED_CONTENT_TYPES:
            raise ValueError(
                f"Unsupported content type '{normalised}'. Send a PNG, JPEG, WebP or TIFF image."
            )

    detected = detect_image_type(data)
    if detected is None:
        raise ValueError("The uploaded file is not a readable image.")

    if content_type:
        normalised = content_type.split(";")[0].strip().lower()
        if normalised not in {"application/octet-stream", detected}:
            raise ValueError(
                "The file content does not match its declared content type."
            )

    width, height = _probe_dimensions(data)
    if width <= 0 or height <= 0:
        raise ValueError("The uploaded image has invalid dimensions.")
    if width * height > settings.max_image_pixels:
        raise ValueError(
            f"The image resolution ({width}x{height}) is too large to analyse safely."
        )


def _probe_dimensions(data: bytes) -> tuple[int, int]:
    """Read image dimensions from the header without decoding pixel data."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            return int(image.width), int(image.height)
    except Exception:
        return 0, 0


class RateLimiter:
    """Sliding-window rate limiter keyed by client identity."""

    def __init__(self, limit: int = 30, window_seconds: float = 60.0) -> None:
        self.limit = max(1, limit)
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        """Record a hit for ``key`` and report whether it is within the limit."""
        now = time.monotonic()
        hits = self._hits[key]
        cutoff = now - self.window_seconds
        while hits and hits[0] < cutoff:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        return True

    def reset(self, keys: Iterable[str] | None = None) -> None:
        """Clear counters for the given keys (or all keys when omitted)."""
        if keys is None:
            self._hits.clear()
        else:
            for key in keys:
                self._hits.pop(key, None)
