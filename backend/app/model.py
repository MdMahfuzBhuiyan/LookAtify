"""DeepGaze model wrapper.

The wrapper owns a single model instance for the whole process:

* load once at startup (``pretrained=True`` downloads the official weights
  into the torch hub cache on first run),
* run in ``eval()`` mode under ``torch.no_grad()``,
* use CUDA when it is available, otherwise CPU,
* warm up once so the first real request is not slower than the rest.

The model is hidden behind a small interface so it can be swapped through the
``MODEL_NAME`` environment variable.
"""

from __future__ import annotations

import logging
import threading

import numpy as np
import torch
from scipy.ndimage import zoom
from scipy.special import logsumexp

from .config import Settings

logger = logging.getLogger("lookatify.model")

#: Official release with the pretrained DeepGaze weights.
_CENTERBIAS_URL = (
    "https://github.com/matthias-k/DeepGaze/releases/download/v1.0.0/centerbias_mit1003.npy"
)


class ModelUnavailableError(RuntimeError):
    """Raised when the saliency model cannot be loaded."""


class SaliencyModel:
    """Thin, thread-safe wrapper around the DeepGaze family of models."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model: torch.nn.Module | None = None
        self.device: str = "unavailable"
        self.model_name: str = settings.model_name
        self.model_version: str = ""
        self.warm: bool = False
        self._centerbias_template: np.ndarray | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    def load(self) -> None:
        """Load the model and warm it up. Raises ``ModelUnavailableError``."""
        try:
            import deepgaze_pytorch
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise ModelUnavailableError(
                "deepgaze_pytorch is not installed. Run: pip install -r requirements.txt"
            ) from exc

        self.device = self._resolve_device()
        logger.info("Loading model '%s' on %s", self.model_name, self.device)

        try:
            model = self._build_model(deepgaze_pytorch)
        except Exception as exc:
            raise ModelUnavailableError(
                f"Could not load '{self.model_name}': {exc}. "
                "The pretrained weights are downloaded on first run — check the network."
            ) from exc

        model = model.to(self.device)
        model.eval()
        self.model = model
        self.model_version = self._detect_version(deepgaze_pytorch)
        self._load_centerbias_template()
        self._warmup()
        self.warm = True
        logger.info("Model ready (version=%s, device=%s)", self.model_version, self.device)

    def _build_model(self, deepgaze_pytorch) -> torch.nn.Module:
        """Instantiate the model named by ``MODEL_NAME``."""
        name = self.model_name.lower()
        if name in {"deepgaze2e", "deepgaze_2e", "deepgazeii"}:
            # DeepGaze IIE is the calibrated successor of DeepGaze II and
            # shares the same input/output interface.
            return deepgaze_pytorch.DeepGazeIIE(pretrained=True)
        if name in {"deepgaze3", "deepgaze_3"}:
            return deepgaze_pytorch.DeepGazeIII(pretrained=True)
        if name in {"deepgaze1", "deepgaze_1"}:
            return deepgaze_pytorch.DeepGazeI(pretrained=True)
        raise ValueError(
            f"Unknown MODEL_NAME '{self.model_name}'. Use deepgaze2e, deepgaze3 or deepgaze1."
        )

    def _detect_version(self, deepgaze_pytorch) -> str:
        """Read the installed package version when it is discoverable."""
        try:
            from importlib.metadata import version

            return version("deepgaze-pytorch")
        except Exception:
            return "unknown"

    def _resolve_device(self) -> str:
        """Pick the best available torch device."""
        requested = self.settings.device.lower()
        if requested == "cpu":
            return "cpu"
        if requested == "cuda" or requested.startswith("cuda:"):
            if torch.cuda.is_available():
                return requested
            logger.warning("CUDA requested but unavailable — falling back to CPU")
            return "cpu"
        return "cuda" if torch.cuda.is_available() else "cpu"

    def unload(self) -> None:
        """Release the model and cached GPU memory."""
        with self._lock:
            self.model = None
            self.warm = False
            self._centerbias_template = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("Model unloaded")

    def info(self) -> dict:
        """Describe the current model state for ``/health``."""
        return {
            "model_loaded": self.model is not None,
            "device": self.device,
            "model_name": self.model_name,
            "model_version": self.model_version,
            "warm": self.warm,
        }

    # ------------------------------------------------------------------
    # inference
    # ------------------------------------------------------------------
    def _warmup(self) -> None:
        """Run one tiny dummy pass so the first request is not the slowest."""
        dummy = np.zeros((128, 128, 3), dtype=np.uint8)
        try:
            self.predict(dummy)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Warmup pass failed: %s", exc)

    def predict(self, image: np.ndarray) -> np.ndarray:
        """Run inference on an RGB uint8 image.

        :param image: RGB array shaped ``(height, width, 3)``.
        :returns: log fixation density shaped ``(height, width)``.
        """
        if self.model is None:
            raise ModelUnavailableError("The saliency model is not loaded.")

        tensor = torch.from_numpy(image.transpose(2, 0, 1)).float().div_(255.0)
        tensor = tensor.unsqueeze(0).to(self.device)

        centerbias = self._centerbias_for(image.shape[0], image.shape[1])
        centerbias_tensor = torch.from_numpy(centerbias).float().unsqueeze(0).to(self.device)

        with torch.no_grad():
            log_density = self.model(tensor, centerbias_tensor)
        return log_density.detach().cpu().numpy().squeeze()

    def _centerbias_for(self, height: int, width: int) -> np.ndarray:
        """Build the log-density centre-bias prior for an image of this size.

        Web pages are not photographs: a strong photographic centre bias would
        pull attention toward the middle of a very long screenshot. The
        default is therefore a uniform prior, with an optional vertically
        tiled prior for pages, and the MIT1003 prior available for comparison.
        """
        mode = self.settings.center_bias.lower()

        if mode == "mit1003" or (self.settings.use_center_bias and mode != "uniform"):
            template = self._centerbias_template
            if template is not None:
                resized = zoom(
                    template,
                    (height / template.shape[0], width / template.shape[1]),
                    order=0,
                    mode="nearest",
                )
                return self._normalise_log_density(resized)

        if mode in {"vertical", "tiled"}:
            # Repeat the upper third down the page so each screen-sized band
            # gets the same amount of prior attention.
            band = max(1, height // 3)
            template = np.zeros((band, width), dtype=np.float64)
            vertical = np.linspace(-1.0, 1.0, band)[:, None]
            template += -1.5 * (vertical**2)
            tiled = np.tile(template, (int(np.ceil(height / band)), 1))[:height]
            return self._normalise_log_density(tiled)

        return self._normalise_log_density(np.zeros((height, width), dtype=np.float64))

    @staticmethod
    def _normalise_log_density(density: np.ndarray) -> np.ndarray:
        """Shift a log-density map so it sums to one in probability space."""
        return density - logsumexp(density)

    def _load_centerbias_template(self) -> None:
        """Load the MIT1003 centre-bias prior when it is available."""
        local_path = self.settings.model_weights_dir / "centerbias_mit1003.npy"
        try:
            if local_path.exists():
                self._centerbias_template = np.load(local_path)
            else:
                from torch.hub import download_url_to_file

                local_path.parent.mkdir(parents=True, exist_ok=True)
                download_url_to_file(_CENTERBIAS_URL, str(local_path))
                self._centerbias_template = np.load(local_path)
            logger.info("Loaded centre-bias prior from %s", local_path)
        except Exception as exc:
            logger.warning("Centre-bias prior unavailable (%s) — using a uniform prior", exc)
            self._centerbias_template = None
