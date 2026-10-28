# LookAtify API

Base URL: `http://127.0.0.1:8001` (development)

Interactive documentation is served by FastAPI at `/docs`, with the raw schema
at `/openapi.json`.

Every response carries an `X-Request-Id` header. The same id appears in the
server logs, so a request can be traced end to end.

---

## Authentication

When `API_TOKEN` is set on the backend, every request to `/analyze` must send:

```
Authorization: Bearer <token>
```

| Situation | Status | Code |
|---|---|---|
| No `Authorization` header | 401 | `missing_token` |
| Wrong token | 403 | `invalid_token` |

When `API_TOKEN` is empty (the default for local development) the endpoint is
open. **Always set a token on a server that is reachable from the internet.**

---

## `GET /health`

Reports whether the model is loaded and which device it runs on.

```bash
curl http://127.0.0.1:8001/health
```

```json
{
  "status": "ok",
  "model_loaded": true,
  "device": "cpu",
  "model_name": "deepgaze2e",
  "model_version": "1.2.1",
  "version": "0.1.0",
  "warm": true
}
```

| Field | Meaning |
|---|---|
| `status` | `ok`, `unavailable` (no model), or `error` |
| `model_loaded` | `true` when the weights are in memory |
| `device` | `cpu`, `cuda`, or `unavailable` |
| `warm` | `true` after the warm-up pass has run |

---

## `POST /analyze`

Analyses a screenshot and returns the saliency map, a colored heatmap and the
attention statistics.

### Request

`multipart/form-data`:

| Field | Type | Default | Description |
|---|---|---|---|
| `file` | file | — | The screenshot. Required. `image` is accepted as an alias. |
| `colormap` | string | `jet` | `jet`, `turbo`, `viridis`, `hot` or `colorblind` |
| `blur_sigma` | number | `0` | Gaussian blur radius, 0–100 |
| `opacity` | number | `0.55` | Opacity of the server-side composite, 0–1 |
| `return_composite` | bool | `false` | Also return the screenshot with the heatmap burned in |
| `viewport_only` | bool | `false` | Analyse only the visible area |
| `top_n` | integer | `5` | Number of attention points to report, 1–50 |

```bash
curl -X POST http://127.0.0.1:8001/analyze \
  -F "file=@screenshot.png" \
  -F "colormap=jet" \
  -F "top_n=5"
```

### Response

```json
{
  "analysis_id": "9d34016d98974ee5928e0b5000c49a99",
  "width": 1440,
  "height": 2400,
  "saliency_png_base64": "iVBORw0KGgo...",
  "heatmap_png_base64": "iVBORw0KGgo...",
  "composite_png_base64": null,
  "top_points": [
    { "rank": 1, "x": 614, "y": 2295, "score": 1.0 },
    { "rank": 2, "x": 864, "y": 2295, "score": 0.997 }
  ],
  "stats": {
    "above_fold_pct": 33.77,
    "thirds_pct": { "top": 33.77, "middle": 31.81, "bottom": 34.42 },
    "left_right_pct": { "left": 51.24, "right": 48.76 },
    "peak_score": 8.7e-07,
    "mean_intensity": 2.9e-07
  },
  "timing_ms": {
    "preprocess": 34,
    "inference": 8053,
    "postprocess": 266,
    "total": 8406
  },
  "warnings": [
    "The page was scaled to 71% for inference, so very small details may be smoothed out."
  ]
}
```

| Field | Description |
|---|---|
| `saliency_png_base64` | 8-bit grayscale saliency map at the original resolution |
| `heatmap_png_base64` | RGBA heatmap; the alpha channel ramps with the intensity |
| `composite_png_base64` | The screenshot with the heatmap burned in (only when requested) |
| `top_points` | The strongest attention peaks, ordered by rank |
| `stats.above_fold_pct` | Share of attention in the first 800 px |
| `stats.thirds_pct` | Share of attention in each vertical third |
| `stats.left_right_pct` | Share of attention on each half |
| `warnings` | Human-readable notes about approximations that were made |

**Peak scores are relative:** `1.0` is the strongest peak on the page and
`0.5` means half as strong. The raw fixation probability is around `1e-6`, so
it is reported in `stats.peak_score` instead.

---

## Errors

Errors use one of two shapes.

```json
{ "error": { "code": "rate_limited", "message": "Too many analyses in the last minute." } }
```

```json
{ "detail": { "code": "missing_image", "message": "No image was uploaded." } }
```

| Status | Code | Cause |
|---|---|---|
| 400 | `missing_image` | No `file` field in the request |
| 400 | `invalid_upload` | The file is empty, too large, not an image, or does not match its content type |
| 400 | `invalid_request` | A parameter is not a number or is out of range |
| 401 | `missing_token` | No bearer token was sent while one is required |
| 403 | `invalid_token` | The bearer token was rejected |
| 429 | `rate_limited` | More than `RATE_LIMIT_PER_MINUTE` requests in a minute |
| 500 | `analysis_failed` | The pipeline raised an unexpected error |
| 503 | `model_unavailable` | The model is not loaded |

---

## Limits

| Setting | Default | Description |
|---|---|---|
| `MAX_UPLOAD_BYTES` | 25 MB | Maximum upload size |
| `MAX_IMAGE_PIXELS` | 60,000,000 | Maximum `width × height` |
| `RATE_LIMIT_PER_MINUTE` | 30 | Requests per minute per token or client |
| `MAX_INFERENCE_SIDE` | 1024 | Longest side of a single inference pass |
| `COARSE_INFERENCE_SIDE` | 1024 | Longest side of the coarse whole-page pass (0 disables it) |

Uploads are validated on three axes: the declared content type, the magic
bytes of the file, and the decoded dimensions.

---

## Example: analyse with curl and save the result

```bash
curl -X POST http://127.0.0.1:8001/analyze \
  -F "file=@screenshot.png" \
  -F "return_composite=true" \
  | python3 -c "
import base64, json, sys
data = json.load(sys.stdin)
open('heatmap.png', 'wb').write(base64.b64decode(data['heatmap_png_base64']))
print('saved heatmap.png')
"
```
