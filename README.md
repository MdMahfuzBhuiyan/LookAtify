# LookAtify

**Visual attention heatmaps for web pages.** LookAtify captures a full-page
screenshot, runs it through the DeepGaze IIE saliency model and shows you
where a visitor's attention is most likely to land — as a heatmap you can
blend, split, zoom and export.


---

## Status

| Step | State |
|---|---|
| 1. Backend skeleton (FastAPI, `/health`, config, Docker) | done |
| 2. Model wrapper (DeepGaze IIE, verified on a real image) | done |
| 3. Pipeline (tiling, post-processing, analytics, `/analyze`, auth) | done |
| 4. Extension capture (content script, service worker, stitching) | done |
| 5. Connect to the backend, viewer with Blended mode | done |
| 6. Viewer features (Split / Heatmap / Original, opacity, zoom, export) | done |
| 7. Extras (colormaps, blur, threshold, Top-N, stats, smart capture) | done |
| 8. Hardening (security, error UX, tests) | done |
| 9. Docs and packaging | done |

---

## Architecture

```
┌────────────────────────────────────┐        HTTPS (multipart)        ┌─────────────────────────────────┐
│ Browser Extension (MV3)            │ ───────────────────────────────▶ │ FastAPI Backend                 │
│  - popup (trigger, progress)       │                                  │  - /health (status, model)      │
│  - content script (scroll/measure) │ ◀─────────────────────────────── │  - /analyze (image → heatmap)  │
│  - service worker (capture/stitch) │      PNG saliency + JSON stats    │  - DeepGaze IIE inference       │
│  - viewer (4 modes, zoom, export)  │                                  │  - tiling + heatmap engine      │
└────────────────────────────────────┘                                  └─────────────────────────────────┘
```

### Module map

```
backend/app/
├── main.py           FastAPI app, routes, request context, error handling
├── config.py         Environment-driven settings
├── logging_config.py Structured logging with a request id
├── model.py          SaliencyModel — DeepGaze wrapper (load once, reuse)
├── pipeline.py       preprocess → infer → postprocess, tiling and blending
├── heatmap.py        normalize, blur, colormaps, overlay compositing
├── analytics.py      top-N peaks, thirds/fold/left-right statistics
├── security.py       token auth, upload validation, rate limiting
└── schemas.py        Pydantic request/response models

extension/
├── manifest.json           Chrome MV3 manifest
├── manifest.firefox.json   Firefox MV3 manifest
├── background/service-worker.js  Capture orchestration, upload, storage
├── content/capture.js      Scroll loop, sticky-element handling
├── popup/                  Trigger UI with the progress steps
├── viewer/                 Interactive heatmap viewer
├── options/                Settings page
├── lib/
│   ├── config.js           Brand, defaults, storage keys
│   ├── stitch.js           Pure capture geometry
│   ├── api.js              Backend client (injectable fetch)
│   ├── state.js            Pure viewer state reducer
│   ├── colormaps.js        Client-side colormaps, blur and threshold
│   └── export.js           PNG/JPEG export helpers
└── icons/                  Brand monogram at 16/32/48/128 px
```

---

## Setup

### 1. Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # optional — the defaults work as-is
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

The first start downloads the DeepGaze IIE weights (~400 MB) into the torch
hub cache and warms the model up. That takes a couple of minutes; afterwards
`/health` reports `model_loaded: true`.

Check it:

```bash
curl http://127.0.0.1:8001/health
```

### 2. Extension

**Chrome, Brave, Edge and other Chromium browsers**

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `extension/` folder.
3. Click the LookAtify icon, open **Settings** and confirm the server URL
   (`http://127.0.0.1:8001` by default).
4. Press **Analyze Full Page**.

**Firefox**

Firefox rejects a manifest that declares a background service worker, so it
uses its own manifest. Build a loadable copy first:

```bash
node scripts/build-firefox.mjs extension dist/firefox
```

Then open `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
and select `dist/firefox/manifest.json`.

The extension is unsigned, so Firefox will not install it permanently
without a signing key. For a permanent install, sign the build with
`web-ext sign` or publish it through addons.mozilla.org.

**Keyboard shortcuts**

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+A` (`Cmd+Shift+A` on macOS) | Analyse the full page |
| `Ctrl+Shift+V` (`Cmd+Shift+V` on macOS) | Analyse the visible area |

### 3. Docker

```bash
cd deploy
cp .env.example .env
./deploy.sh up
```

The API is then on <http://127.0.0.1:8001>. See [`deploy/README.md`](deploy/README.md)
for the GPU image, an HTTPS setup for a remote server, and the settings.

---

## Tests

```bash
# Backend — 81 tests
cd backend && .venv/bin/python -m pytest tests -q

# Extension — 42 tests
cd extension && node --test tests/extension.test.mjs
```

Browser-level checks run against a headless Chromium:

```bash
# Load the extension and verify the popup, options and viewer pages
npx @puppeteer/browsers install chromium@latest --path /tmp/pptr-browsers
node scripts/verify-extension.mjs extension

# Full flow: capture a real page, stitch it, upload it and analyse it
node scripts/verify-e2e.mjs

# The whole user flow: the popup drives an analysis and the viewer opens it
LOOKATIFY_BACKEND=http://127.0.0.1:8001 node scripts/verify-flow.mjs

# The viewer really shows the heatmap, checked against the canvas pixels
LOOKATIFY_BACKEND=http://127.0.0.1:8001 node scripts/verify-viewer.mjs

# Repeated large analyses must not exhaust the browser storage
node scripts/verify-storage.mjs
```

### Browser compatibility

The extension is verified in every browser that is installed on the machine.
Each browser gets the same checks: the popup, options and viewer pages
render, the storage and command APIs work, the content script is injected,
and the capture pipeline returns the expected slices.

```bash
# Install the browsers the checks drive
npx @puppeteer/browsers install chromium@latest --path /tmp/pptr-browsers
npx @puppeteer/browsers install firefox@stable --path /tmp/pptr-browsers
curl -sL -o /tmp/geckodriver.tar.gz \
  https://github.com/mozilla/geckodriver/releases/download/v0.36.0/geckodriver-v0.36.0-linux64.tar.gz
tar -xzf /tmp/geckodriver.tar.gz -C /tmp

node scripts/verify-all-browsers.mjs extension
```

Chrome, Brave and Chromium are driven through the DevTools protocol, Firefox
through geckodriver. The two differences the extension has to absorb are
handled in the code:

| Difference | Handling |
| --- | --- |
| Firefox rejects `background.service_worker` | `manifest.firefox.json` declares `background.scripts` instead |
| Firefox resolves a relative `executeScript` path against the calling page | The content script is injected as `/content/capture.js` |

> Google Chrome 137 and newer ignore the `--load-extension` command line
> switch, so the checks install the extension through the DevTools protocol
> (`Extensions.loadUnpacked`) instead. Loading it by hand through
> **Load unpacked** works in every Chromium browser.

The pipeline proof script runs the real model on a synthetic page and writes
the saliency map, heatmap and blend to `assets/proof/`:

```bash
backend/.venv/bin/python scripts/prove_pipeline.py
```

---

## Verified results

Measured on this machine (CPU only, no GPU):

| Metric | Value |
|---|---|
| Model | DeepGaze IIE (`deepgaze_pytorch` 1.2.1) |
| Device | CPU |
| 1440 × 2400 page, 3 tiles | ~10 s total (6.6 s inference) |
| `/analyze` over HTTP | 13.3 s including the composite |
| Saliency map | 1440 × 2400 grayscale, 0–1 normalized |
| Heatmap | 1440 × 2400 RGBA with an alpha ramp |
| Peak coordinates | spread across the page, not clustered at an edge |
| Browser end-to-end | 1280 × 1817 page → 3 slices → stitched → analysed → 5 peaks |

Verified in a real headless Chromium: the extension loads, the popup reports
the backend as **online**, the options page loads the defaults, the viewer
renders all four modes, and a full capture → stitch → upload → analyse round
trip returns attention points.

---

## Assumptions and design decisions

**DeepGaze IIE instead of II.** The original DeepGaze II weights are not
available in PyTorch; IIE is the calibrated successor with the same input and
output interface. The model is behind a `SaliencyModel` interface, so
`MODEL_NAME=deepgaze3` switches implementations without touching the pipeline.

**Uniform centre bias by default.** DeepGaze normally applies the MIT1003
photographic centre bias. A 6,000 px screenshot is not a photograph, and a
strong photographic centre bias drags attention toward the middle of a long
page. The default is therefore a uniform prior; `CENTER_BIAS=vertical` gives
each screen-sized band the same prior, and `CENTER_BIAS=mit1003` enables the
original for comparison.

**Tiles are padded to 32 pixels.** The DeepGaze readout grid advances in steps
of 32 pixels (a factor of 2 in the model and 16 in the backbone). A tile whose
size is not a multiple of 32 leaves a partially covered feature cell at the
border, which produced a bright line along the tile edge — the bottom row of a
page reached 2.9× the median attention. Padding to the stride and cropping
the padding away afterwards removed the artifact (2.65 → 0.90).

**Tiles are reflect-padded on all sides.** The model itself has a border bias:
on a featureless image the outermost columns receive about 2.3× the median
attention. Reflecting the content into a border of one stride brings that
down to 0.49 and removes the bright frame around the heatmap.

**Log-space normalisation.** The log-density output is converted to a
probability distribution with `logsumexp`, not by subtracting the maximum
value. Subtracting only the maximum underflows every other pixel to zero when
the dynamic range is large, which destroys the saliency signal.

**Peak scores are relative.** A point's score is reported as a fraction of the
strongest peak (`1.0` = strongest), because raw fixation probabilities are
around `1e-6` and are unreadable.

---

## Honest limitations

- DeepGaze predicts bottom-up visual saliency on natural-image-like inputs. It
  does not understand text meaning, user intent or task context, and web pages
  differ from the photographs it was trained on. The results are a **design
  aid, not ground truth**.
- Long pages are processed in tiles, so comparisons between distant regions
  are approximate. The response says so in its `warnings` field.
- Animated, video and hover-dependent UI is captured as a static frame.
- Only the outer page is captured; content inside an inner scroll container is
  missed (the viewer reports this as a warning).
- Pages taller than the configured maximum (16,000 px by default) are
  truncated, with a warning.

---

## Privacy

Screenshots are sent to the server you configure, and they can contain
anything on the page — including personal data. LookAtify:

- keeps every image in memory and never writes it to disk,
- logs no image content and no page URLs,
- shows a warning when the page contains a password field,
- supports self-hosting, so the image never leaves your machine.

Only run it against pages you are allowed to capture.

---

## Documentation

- `docs/architecture.md` — how the pieces fit together
- `docs/api.md` — the HTTP API
- `docs/user-guide.md` — installing and using the extension
