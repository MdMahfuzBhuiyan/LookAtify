"""Tests for the CORS configuration.

The extension calls the API from a ``chrome-extension://`` or
``moz-extension://`` origin. The CORS layer matches origins literally, so a
plain ``chrome-extension://*`` wildcard does not work — it has to be a
regular expression. These tests pin that behaviour, because getting it wrong
blocks the extension in production while everything still looks healthy
locally.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.config import Settings

CHROME_ORIGIN = "chrome-extension://oiipoodfglkcjdoemdhhkchnnpjhbedc"
FIREFOX_ORIGIN = "moz-extension://3a1b2c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d"


@pytest.fixture()
def client():
    """A TestClient with the CORS middleware active."""
    with TestClient(main_module.app) as test_client:
        yield test_client


def test_extension_origin_is_allowed(client) -> None:
    response = client.options(
        "/analyze",
        headers={
            "Origin": CHROME_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == CHROME_ORIGIN


def test_firefox_origin_is_allowed(client) -> None:
    response = client.options(
        "/analyze",
        headers={
            "Origin": FIREFOX_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == FIREFOX_ORIGIN


def test_unknown_origin_is_rejected(client) -> None:
    response = client.options(
        "/analyze",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert "access-control-allow-origin" not in response.headers


def test_actual_request_carries_the_allow_origin_header(client) -> None:
    response = client.get("/health", headers={"Origin": CHROME_ORIGIN})

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == CHROME_ORIGIN


def test_default_origins_are_regular_expressions() -> None:
    """A plain wildcard would silently break the extension."""
    for origin in Settings().cors_origins:
        if origin.startswith(("chrome-extension://", "moz-extension://")):
            assert "*" not in origin, f"{origin} is a literal wildcard"
            assert origin.endswith("}") or "[" in origin, f"{origin} is not a pattern"
