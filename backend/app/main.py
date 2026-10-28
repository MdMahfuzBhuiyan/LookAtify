"""LookAtify backend — saliency analysis service for the LookAtify extension.

The service exposes:

* ``GET  /health``  → model/device/status information.
* ``POST /analyze`` → image in, saliency map + heatmap + analytics out.

Everything runs in-process: the DeepGaze model is loaded once at startup and
reused for every request. Uploaded images are never written to disk.

Module map
----------
``config``        env-driven settings
``logging_config`` structured logging with a request id
``model``         DeepGaze wrapper (load once, reuse)
``pipeline``      preprocess → infer → postprocess orchestration
``heatmap``       normalize, blur, colormap, overlay
``analytics``     top-N peaks, thirds/fold/left-right statistics
``security``      token auth, upload validation, rate limiting
``schemas``       Pydantic request/response models
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from .logging_config import RequestContextFilter, install_logging
from .model import ModelUnavailableError, SaliencyModel
from .pipeline import AnalysisPipeline
from .preflight import exit_on_port_conflict
from .schemas import AnalyzeOptions, AnalyzeResponse, HealthResponse
from .security import RateLimiter, client_identity, enforce_token, validate_upload

install_logging(settings.log_level)
logger = logging.getLogger("lookatify")

# One model + one pipeline for the whole process. The extension uploads one
# page at a time, so a single in-flight job keeps peak memory predictable.
model: SaliencyModel | None = None
pipeline: AnalysisPipeline | None = None
rate_limiter = RateLimiter(limit=settings.rate_limit_per_minute)


def _will_bind_socket() -> bool:
    """Return True when this process will open the configured TCP port.

    The port check only makes sense when a server socket is actually created.
    Starlette's test client runs the lifespan without ever binding a port, so
    the check is skipped when LOOKATIFY_SKIP_PORT_CHECK is set to 1.
    """
    return os.environ.get("LOOKATIFY_SKIP_PORT_CHECK") != "1"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load the model at startup and release it cleanly on shutdown."""
    global model, pipeline

    logger.info("LookAtify backend starting (model=%s)", settings.model_name)

    # The port is checked before the model is loaded. Uvicorn only reports the
    # conflict after the startup sequence has finished, which would waste the
    # time spent loading the weights.
    #
    # The check is skipped when the application runs without a server socket,
    # which is the case for the test client and for ASGI embedding.
    if _will_bind_socket():
        exit_on_port_conflict(settings.host, settings.port)

    model = SaliencyModel(settings)
    try:
        # Loading the weights takes a while, so it runs in a worker thread
        # and the event loop stays responsive for health checks.
        await asyncio.to_thread(model.load)
    except ModelUnavailableError as exc:
        # The service still starts so /health can report a clear error instead
        # of the API refusing every connection.
        logger.error("Model unavailable: %s", exc)
    pipeline = AnalysisPipeline(model, settings)
    logger.info("LookAtify backend ready (device=%s)", model.device if model else "unavailable")

    yield

    if model is not None:
        model.unload()
    logger.info("LookAtify backend stopped")


app = FastAPI(
    title="LookAtify API",
    version="0.1.0",
    description="DeepGaze saliency analysis for the LookAtify browser extension.",
    lifespan=lifespan,
)

# The extension calls the API from a chrome-extension:// / moz-extension://
# origin, so the browser sends an Origin header that is not a normal web
# origin. The configured origins are regular expressions, because the CORS
# layer matches origins literally and a plain wildcard would not work.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex="|".join(f"(?:{origin})" for origin in settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Request-Id"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    """Attach a request id to logs and to every response."""
    request_id = request.headers.get("X-Request-Id") or f"req-{int(time.time() * 1000)}"
    request.state.request_id = request_id
    RequestContextFilter.set_request_id(request_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        RequestContextFilter.clear_request_id()
    elapsed_ms = (time.perf_counter() - started) * 1000
    logger.info(
        "%s %s -> %s (%.1f ms)", request.method, request.url.path, response.status_code, elapsed_ms
    )
    response.headers["X-Request-Id"] = request_id
    return response


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Return a structured error body instead of an HTML stack trace."""
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "internal_error",
                "message": "The server hit an unexpected error. Please retry.",
            }
        },
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Report whether the model is loaded and which device it runs on."""
    if model is None:
        return HealthResponse(status="unavailable", model_loaded=False)
    try:
        info = model.info()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Health check failed: %s", exc)
        return HealthResponse(status="error", model_loaded=False)
    return HealthResponse(
        status="ok",
        model_loaded=info["model_loaded"],
        device=info["device"],
        model_name=info["model_name"],
        model_version=info["model_version"],
        version=app.version,
        warm=info["warm"],
    )


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(request: Request) -> JSONResponse:
    """Analyze an uploaded screenshot and return saliency, heatmap and stats."""
    if model is None or pipeline is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "model_unavailable",
                "message": "The saliency model is not loaded. Check the backend logs.",
            },
        )

    enforce_token(request, settings.api_token)

    if not rate_limiter.allow(client_identity(request)):
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": "60"},
            content={
                "error": {
                    "code": "rate_limited",
                    "message": "Too many analyses in the last minute. Please wait a moment.",
                }
            },
        )

    params = await request.form()
    upload = params.get("file") or params.get("image")
    if upload is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "missing_image",
                "message": "No image was uploaded. Send the screenshot as the 'file' field.",
            },
        )

    try:
        options = parse_analyze_options(params)
        image_bytes = await upload.read()
        validate_upload(image_bytes, upload.content_type, settings)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_upload", "message": str(exc)},
        ) from exc

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: pipeline.analyze(image_bytes, options),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_request", "message": str(exc)},
        ) from exc
    except Exception as exc:
        logger.exception("Analysis failed")
        raise HTTPException(
            status_code=500,
            detail={"code": "analysis_failed", "message": f"Analysis failed: {exc}"},
        ) from exc

    return JSONResponse(content=result.model_dump())


def parse_analyze_options(params) -> AnalyzeOptions:
    """Read the optional form fields into an ``AnalyzeOptions`` instance."""

    def as_bool(name: str, default: bool) -> bool:
        raw = params.get(name)
        if raw is None:
            return default
        return str(raw).strip().lower() in {"1", "true", "yes", "on"}

    def as_float(name: str, default: float, low: float, high: float) -> float:
        raw = params.get(name)
        if raw is None or str(raw).strip() == "":
            return default
        try:
            value = float(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"'{name}' must be a number.") from exc
        if not low <= value <= high:
            raise ValueError(f"'{name}' must be between {low} and {high}.")
        return value

    def as_int(name: str, default: int, low: int, high: int) -> int:
        raw = params.get(name)
        if raw is None or str(raw).strip() == "":
            return default
        try:
            value = int(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"'{name}' must be an integer.") from exc
        if not low <= value <= high:
            raise ValueError(f"'{name}' must be between {low} and {high}.")
        return value

    return AnalyzeOptions(
        colormap=str(params.get("colormap") or "jet"),
        blur_sigma=as_float("blur_sigma", settings.default_blur_sigma, 0.0, 100.0),
        opacity=as_float("opacity", settings.default_opacity, 0.0, 1.0),
        return_composite=as_bool("return_composite", False),
        viewport_only=as_bool("viewport_only", False),
        top_n=as_int("top_n", settings.default_top_n, 1, 50),
    )


__all__ = ["analyze", "app", "health"]
