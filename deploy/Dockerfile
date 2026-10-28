# syntax=docker/dockerfile:1

# ---- LookAtify backend -------------------------------------------------
# The DeepGaze weights are downloaded on first start, so the image is built
# without them and the volume keeps them across restarts.
#
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t lookatify/backend:0.1.0 .

# numpy and scipy are pinned to versions that need Python 3.12 or newer, so
# the image cannot be older than that.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# libGL and libglib are needed by opencv-python; libjpeg/png by Pillow.
# curl is used by the health check, and git by pip: two of the requirements
# are installed straight from a git repository.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

# Install the dependencies first so the layer is cached across code changes.
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove git \
    && rm -rf /var/lib/apt/lists/*

COPY backend/app ./app

# The check script is used by "deploy.sh test" when there is no local
# Python environment to run it with.
COPY scripts/check-server-bands.py ./scripts/check-server-bands.py

# The centre-bias prior is cached here so it survives restarts.
ENV MODEL_WEIGHTS_DIR=/app/weights
RUN mkdir -p /app/weights

# Run as a non-root user.
RUN useradd --create-home --uid 10001 lookatify \
    && chown -R lookatify:lookatify /app
USER lookatify

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8001/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
