"""Shared pytest fixtures for the LookAtify backend tests."""

from __future__ import annotations

import io
import os

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.model import SaliencyModel
from app.pipeline import AnalysisPipeline

# The test client runs the application lifespan without ever binding a TCP
# port, so the startup port check has to be skipped.
os.environ.setdefault("LOOKATIFY_SKIP_PORT_CHECK", "1")


class FakeModel(SaliencyModel):
    """A stand-in model that produces a deterministic saliency map.

    The fake puts its strongest response in the middle of the image and adds a
    small deterministic pattern, so tests can assert on the shape of the
    output without loading a 400 MB model.
    """

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self.model = object()  # marks the model as "loaded"
        self.device = "cpu"
        self.calls: list[tuple[int, int]] = []

    def load(self) -> None:  # pragma: no cover - nothing to load
        self.warm = True

    def predict(self, image: np.ndarray) -> np.ndarray:
        self.calls.append((image.shape[0], image.shape[1]))
        height, width = image.shape[:2]
        grid_y = np.linspace(-1.0, 1.0, height)[:, None]
        grid_x = np.linspace(-1.0, 1.0, width)[None, :]
        # A blob in the centre plus a gentle gradient towards the bottom.
        blob = -6.0 * (grid_y**2 + grid_x**2)
        gradient = 1.5 * grid_y
        return (blob + gradient).astype(np.float32)


@pytest.fixture()
def fake_model() -> FakeModel:
    """A FakeModel instance using the default settings."""
    return FakeModel(Settings())


@pytest.fixture()
def fake_pipeline(fake_model: FakeModel) -> AnalysisPipeline:
    """An AnalysisPipeline wired to the fake model."""
    return AnalysisPipeline(fake_model, Settings())


@pytest.fixture()
def sample_png() -> bytes:
    """A small PNG of a synthetic page."""
    image = Image.new("RGB", (240, 320), "white")
    pixels = np.array(image)
    pixels[40:80, 30:180] = (200, 40, 40)
    pixels[150:220, 60:120] = (30, 90, 200)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture()
def sample_settings() -> Settings:
    """Settings with small limits, for validation tests."""
    return Settings(max_upload_bytes=1024, max_image_pixels=10_000)
