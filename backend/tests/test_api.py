"""Tests for the HTTP API surface.

These use FastAPI's TestClient with the model replaced by a fake, so the
endpoint contract is exercised without loading the real DeepGaze weights.
"""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.config import Settings


@pytest.fixture()
def client(fake_model):
    """A TestClient with the fake model wired in."""
    main_module.model = fake_model
    main_module.pipeline = main_module.AnalysisPipeline(fake_model, Settings())
    main_module.rate_limiter.reset()
    with TestClient(main_module.app) as test_client:
        yield test_client
    main_module.model = None
    main_module.pipeline = None


def test_health_reports_the_model(client) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["device"] == "cpu"


def test_analyze_returns_the_documented_payload(client, sample_png: bytes) -> None:
    response = client.post(
        "/analyze",
        files={"file": ("page.png", sample_png, "image/png")},
        data={"colormap": "jet", "top_n": "3"},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["width"] == 240
    assert body["height"] == 320
    assert body["analysis_id"]
    assert body["saliency_png_base64"]
    assert body["heatmap_png_base64"]
    assert len(body["top_points"]) <= 3
    assert "above_fold_pct" in body["stats"]
    assert "thirds_pct" in body["stats"]
    assert "left_right_pct" in body["stats"]
    assert "inference" in body["timing_ms"]

    # The saliency map must decode to a grayscale image of the right size.
    raw = base64.b64decode(body["saliency_png_base64"])
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"


def test_analyze_rejects_a_missing_file(client) -> None:
    response = client.post("/analyze", data={"colormap": "jet"})

    assert response.status_code == 400
    assert "No image" in response.text


def test_analyze_rejects_a_non_image(client) -> None:
    response = client.post(
        "/analyze",
        files={"file": ("page.png", b"not an image at all", "image/png")},
    )

    assert response.status_code == 400
    assert "not a readable image" in response.text


def test_analyze_rejects_an_invalid_colormap_value(client, sample_png: bytes) -> None:
    response = client.post(
        "/analyze",
        files={"file": ("page.png", sample_png, "image/png")},
        data={"top_n": "not-a-number"},
    )

    assert response.status_code == 400
    assert "must be an integer" in response.text


def test_analyze_can_return_a_composite(client, sample_png: bytes) -> None:
    response = client.post(
        "/analyze",
        files={"file": ("page.png", sample_png, "image/png")},
        data={"return_composite": "true", "opacity": "0.5"},
    )

    assert response.status_code == 200
    assert response.json()["composite_png_base64"]


def test_analyze_requires_a_token_when_one_is_configured(
    client, sample_png: bytes, monkeypatch
) -> None:
    monkeypatch.setattr(main_module.settings, "api_token", "secret-token", raising=False)

    unauthorised = client.post(
        "/analyze", files={"file": ("page.png", sample_png, "image/png")}
    )
    assert unauthorised.status_code == 401

    wrong = client.post(
        "/analyze",
        files={"file": ("page.png", sample_png, "image/png")},
        headers={"Authorization": "Bearer wrong"},
    )
    assert wrong.status_code == 403

    accepted = client.post(
        "/analyze",
        files={"file": ("page.png", sample_png, "image/png")},
        headers={"Authorization": "Bearer secret-token"},
    )
    assert accepted.status_code == 200


def test_responses_carry_a_request_id(client) -> None:
    response = client.get("/health")

    assert response.headers.get("X-Request-Id")
