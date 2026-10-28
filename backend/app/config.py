"""Environment-driven settings for the LookAtify backend.

Every value can be overridden with an environment variable (or a ``.env``
file). Defaults are chosen so ``uvicorn app.main:app`` works out of the box
on a laptop, with no configuration.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:  # python-dotenv is optional; the service also works with real env vars.
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - optional dependency
    pass

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_WEIGHTS_DIR = BACKEND_DIR / "weights"


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:
    """Runtime configuration for the LookAtify backend."""

    # --- model -----------------------------------------------------------
    model_name: str = field(default_factory=lambda: _env_str("MODEL_NAME", "deepgaze2e"))
    model_weights_dir: Path = field(
        default_factory=lambda: Path(_env_str("MODEL_WEIGHTS_DIR", str(DEFAULT_WEIGHTS_DIR)))
    )
    device: str = field(default_factory=lambda: _env_str("DEVICE", "auto"))
    #: Longest side, in pixels, of an image fed to the model in one piece.
    max_inference_side: int = field(default_factory=lambda: _env_int("MAX_INFERENCE_SIDE", 1024))
    #: Tile geometry for long pages.
    tile_height: int = field(default_factory=lambda: _env_int("TILE_HEIGHT", 640))
    tile_width: int = field(default_factory=lambda: _env_int("TILE_WIDTH", 1024))
    tile_overlap: int = field(default_factory=lambda: _env_int("TILE_OVERLAP", 96))
    #: ``tile`` splits long pages into overlapping tiles; ``downscale`` shrinks
    #: the whole page to ``max_inference_side`` instead.
    long_page_strategy: str = field(
        default_factory=lambda: _env_str("LONG_PAGE_STRATEGY", "tile")
    )
    #: Longest side, in pixels, of the coarse whole-page pass.
    #:
    #: The model normalises every tile it sees to sum to one, so a per-tile
    #: pass cannot say "this band of the page gets more attention than that
    #: band". A second, cheap pass over the whole page at a much lower
    #: resolution restores the global profile, and the per-tile pass
    #: contributes the detail. Set to 0 to disable the coarse pass.
    coarse_inference_side: int = field(
        default_factory=lambda: _env_int("COARSE_INFERENCE_SIDE", 1024)
    )
    #: Centre bias prior: ``uniform`` (default for web pages) or ``mit1003``.
    center_bias: str = field(default_factory=lambda: _env_str("CENTER_BIAS", "uniform"))
    use_center_bias: bool = field(default_factory=lambda: _env_bool("USE_CENTER_BIAS", False))

    # --- outputs ---------------------------------------------------------
    default_colormap: str = field(default_factory=lambda: _env_str("DEFAULT_COLORMAP", "jet"))
    default_blur_sigma: float = field(default_factory=lambda: _env_float("DEFAULT_BLUR_SIGMA", 0.0))
    default_opacity: float = field(default_factory=lambda: _env_float("DEFAULT_OPACITY", 0.55))
    default_top_n: int = field(default_factory=lambda: _env_int("DEFAULT_TOP_N", 5))
    #: Fold height in pixels, used for the "above the fold" statistic.
    fold_height: int = field(default_factory=lambda: _env_int("FOLD_HEIGHT", 800))

    # --- security --------------------------------------------------------
    api_token: str = field(default_factory=lambda: _env_str("API_TOKEN", ""))
    max_upload_bytes: int = field(default_factory=lambda: _env_int("MAX_UPLOAD_BYTES", 25 * 1024 * 1024))
    max_image_pixels: int = field(default_factory=lambda: _env_int("MAX_IMAGE_PIXELS", 60_000_000))
    rate_limit_per_minute: int = field(default_factory=lambda: _env_int("RATE_LIMIT_PER_MINUTE", 30))
    #: Allowed browser origins. A wildcard such as ``chrome-extension://*``
    #: does **not** work: the CORS layer matches origins literally, so a
    #: pattern has to be a regular expression instead. The defaults accept
    #: any Chrome or Firefox extension origin plus the local dev hosts.
    cors_origins: list[str] = field(
        default_factory=lambda: _env_list(
            "CORS_ORIGINS",
            [
                r"chrome-extension://[a-p]{32}",
                r"moz-extension://[0-9a-f\-]{36}",
                "http://127.0.0.1:8001",
                "http://localhost:8001",
            ],
        )
    )

    # --- service ---------------------------------------------------------
    host: str = field(default_factory=lambda: _env_str("HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("PORT", 8001))
    log_level: str = field(default_factory=lambda: _env_str("LOG_LEVEL", "INFO"))
    #: Keep the last N analyses in memory so the client can score a region
    #: against a previous result without re-running inference.
    analysis_cache_size: int = field(default_factory=lambda: _env_int("ANALYSIS_CACHE_SIZE", 8))


settings = Settings()
