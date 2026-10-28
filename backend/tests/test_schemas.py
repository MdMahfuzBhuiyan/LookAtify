"""Tests for the API schemas."""

from __future__ import annotations

import warnings

from app.schemas import HealthResponse


def test_health_response_uses_the_documented_field_names() -> None:
    """The ``model_`` prefixed fields are part of the wire format."""
    response = HealthResponse()

    assert response.model_loaded is False
    assert response.model_name == "deepgaze2e"
    assert response.model_version == ""


def test_health_response_does_not_warn_about_the_protected_namespace() -> None:
    """Pydantic must not warn about the reserved ``model_`` prefix."""
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        HealthResponse()
