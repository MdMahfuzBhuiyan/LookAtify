"""Pydantic schemas for the LookAtify API.

These models define the wire format for ``/health`` and ``/analyze``. The
response mirrors the contract in the project brief (Section 7.2) so the
extension can consume it without translation.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ColormapName = Literal["jet", "turbo", "viridis", "hot", "colorblind"]


class LookAtifyModel(BaseModel):
    """Base model for the API schemas.

    The ``model_`` field prefix is part of the documented wire format
    (``model_loaded``, ``model_name``, ``model_version``). Pydantic reserves
    that prefix for its own namespace, so the reservation is cleared here
    instead of renaming the fields, which would break the extension contract.
    """

    model_config = {"protected_namespaces": ()}


class HealthResponse(LookAtifyModel):
    """Payload of ``GET /health``."""

    status: Literal["ok", "unavailable", "error"] = "ok"
    model_loaded: bool = False
    device: str = "unavailable"
    model_name: str = "deepgaze2e"
    model_version: str = ""
    version: str = "0.1.0"
    warm: bool = False


class AnalyzeOptions(BaseModel):
    """Optional tuning parameters accepted by ``POST /analyze``."""

    colormap: ColormapName = "jet"
    blur_sigma: float = Field(default=0.0, ge=0.0, le=100.0)
    opacity: float = Field(default=0.55, ge=0.0, le=1.0)
    return_composite: bool = False
    viewport_only: bool = False
    top_n: int = Field(default=5, ge=1, le=50)


class TopPoint(BaseModel):
    """One predicted fixation peak."""

    rank: int
    x: int
    y: int
    score: float


class ThirdsPercentages(BaseModel):
    """Share of total attention in each vertical third of the page."""

    top: float
    middle: float
    bottom: float


class LeftRightPercentages(BaseModel):
    """Share of total attention on each half of the page."""

    left: float
    right: float


class AttentionStats(BaseModel):
    """Aggregated attention statistics for the analysed page."""

    above_fold_pct: float
    thirds_pct: ThirdsPercentages
    left_right_pct: LeftRightPercentages
    peak_score: float = 0.0
    mean_intensity: float = 0.0


class TimingMs(BaseModel):
    """Per-stage timings in milliseconds."""

    preprocess: int = 0
    inference: int = 0
    postprocess: int = 0
    total: int = 0


class AnalyzeResponse(BaseModel):
    """Payload of ``POST /analyze``."""

    analysis_id: str
    width: int
    height: int
    saliency_png_base64: str = Field(
        description="8-bit grayscale saliency map, normalized, at original resolution."
    )
    heatmap_png_base64: str = Field(
        description="RGBA colored heatmap with an alpha ramp, at original resolution."
    )
    composite_png_base64: str | None = Field(
        default=None, description="Screenshot with the heatmap burned in (optional)."
    )
    top_points: list[TopPoint] = Field(default_factory=list)
    stats: AttentionStats
    timing_ms: TimingMs
    warnings: list[str] = Field(default_factory=list)
