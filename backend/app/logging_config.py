"""Structured logging with a per-request correlation id.

The format is ``<timestamp> <level> <logger> [request-id] <message>`` so log
lines can be correlated with the request id returned in the ``X-Request-Id``
header. Image content and page URLs are never logged.
"""

from __future__ import annotations

import contextvars
import logging
import sys

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "lookatify_request_id", default=None
)


class RequestContextFilter(logging.Filter):
    """Inject the current request id into every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id.get() or "-"
        return True

    @staticmethod
    def set_request_id(request_id: str) -> None:
        """Bind a request id to the current context."""
        _request_id.set(request_id)

    @staticmethod
    def clear_request_id() -> None:
        """Remove the request id from the current context."""
        _request_id.set(None)


class RequestFormatter(logging.Formatter):
    """Format records with the optional request-id field."""

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        request_id = getattr(record, "request_id", "-")
        return f"{base} [req={request_id}]"


def install_logging(level: str = "INFO") -> None:
    """Configure the root logger once, at import time."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        RequestFormatter("%(asctime)s %(levelname)-7s %(name)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")
    )
    handler.addFilter(RequestContextFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # Uvicorn's own handlers duplicate ours; route them through the root logger.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
