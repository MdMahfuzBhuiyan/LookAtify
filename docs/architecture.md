# LookAtify architecture

This document explains how the pieces fit together and, more importantly, why
the non-obvious decisions were made.

---

## The flow

```
popup                service worker          content script         backend
  │                        │                       │                     │
  ├─ LOOKATIFY_ANALYZE ──▶│                       │                     │
  │                        ├─ inject capture.js ─▶│                     │
  │                        ├─ LOOKATIFY_CAPTURE_START ─▶│               │
  │                        │                       ├─ scroll + measure   │
  │                        │◀─ LOOKATIFY_CAPTURE_FRAME │ (asks per slice)│
  │                        ├─ captureVisibleTab ──▶ (2/s max)           │
  │                        │◀─ data URL ───────────┤                     │
  │                        │  (repeat per slice)   │                     │
  │                        ├─ stitch onto OffscreenCanvas               │
  │                        ├─ POST /analyze ────────────────────────────▶│
  │                        │◀─ saliency + heatmap + stats ──────────────┤
  │                        ├─ store the images in IndexedDB              │
  │                        ├─ store the metadata in storage.local        │
  │                        ├─ open the viewer tab                       │
  │◀─ LOOKATIFY_DONE ─────┤                                               │
```

The service worker owns the capture. The content script owns the page: it
measures, scrolls, waits for lazy content and hides repeating headers. The
viewer is a separate tab that reads the stored result — which keeps the
result alive after the popup closes.

---

## Where the results are stored

`chrome.storage.local` caps the whole area at 10 MB and a single item at
8 MB. A full-page screenshot is several megabytes, and a base64 data URL is a
third larger than the image itself. Writing the images into the settings area
therefore filled the quota after a few analyses, and every later run failed
with `Resource::kQuotaBytes quota exceeded`.

The results are split instead:

| Part | Where | Why |
|---|---|---|
| Screenshot and saliency map | IndexedDB | Stored as blobs, so there is no base64 overhead and no quota. |
| Statistics, peak points, dimensions | `chrome.storage.local` | A few hundred bytes each, so the settings area stays small. |

Only the newest `MAX_STORED_ANALYSES` (5) results are kept. The oldest ones
are removed when a new analysis is stored, which keeps the disk usage
bounded. **Settings → Clear saved analyses** removes all of them at once.

An analysis written by an older version is migrated into the database the
first time the extension runs. Without the migration the browser would
reject every write, because the old record still filled the quota.

---

## Long pages: tiling

A 1440 × 6000 screenshot is far too large for the model. The pipeline:

1. **Scales the page down** so its width fits `MAX_INFERENCE_SIDE` (1024 px).
2. **Slices it vertically** into tiles of `TILE_HEIGHT` (640 px) with
   `TILE_OVERLAP` (96 px) between them.
3. **Runs inference per tile.**
4. **Blends the overlaps** with a linear feathered weight ramp, so the
   transition between two tiles is a gradient rather than a seam.
5. **Rescales the result** to the exact original screenshot dimensions.

Every tile spans the full width, so the blended result always covers the whole
page. The alternative — tiling horizontally as well — multiplies the runtime
by the number of columns for no benefit, because the model can handle a full
width in one pass.

`LONG_PAGE_STRATEGY=downscale` shrinks the whole page to
`MAX_INFERENCE_SIDE` instead. It is faster, but small details are lost.

### Why a second, coarse pass is needed

The DeepGaze model normalises **every image it sees** so that its output sums
to one. That is the right behaviour for a photograph, but it has a
consequence for a page that is analysed in tiles: each tile ends up carrying
exactly the same attention mass, no matter how interesting its content is.

Blending tiles that all carry the same mass produces a page that is lit
evenly from top to bottom. Measured on a real 1440 × 13316 news capture,
that gave a top/middle/bottom split of 32/32/36 %, an above-the-fold share of
5.4 %, and put the strongest attention peaks in the footer.

The pipeline therefore runs **two passes**:

1. the **coarse pass** (`COARSE_INFERENCE_SIDE`, 1024 px) sees the whole page
   as one image, so its output does carry the global profile;
2. the **tile pass** supplies the detail.

The two are multiplied together: the detail decides *where* the attention is
inside a band, the profile decides *how much* attention that band deserves.
The coarse pass is cheap — the page is shrunk to a fraction of its size — and
it is skipped entirely when the page fits in a single inference pass.

After the change, the same capture gave a split of 48/21/31 %, an
above-the-fold share of 17.7 %, and moved the top five peaks from the footer
to the hero.

### Why the tiles are padded

The DeepGaze readout grid advances in steps of **32 pixels**: the model
downsamples the input by 2, and the backbone downsamples by 16 more. A tile
whose height is not a multiple of 32 leaves a partially covered feature cell
at the border. That cell accumulates probability and shows up as a bright
line along the tile edge.

Measured on a 1440 × 2400 test page, the bottom row of the saliency map
reached **2.9× the median row** before the fix. Padding the tile to a
multiple of 32 and cropping the padding away afterwards brought it to
**0.90** — the noise floor.

### Why the tiles are reflect-padded on every side

The model itself has a border bias. On a completely featureless grey image,
the outermost columns still receive about **2.3× the median** attention,
because the convolution sees padding where there should be content.

Reflecting the content into a border of one stride (32 px) on all four sides
fixes it: the border bias dropped to **0.49**, and the bright frame around the
heatmap disappeared.

### Why the probability is computed with `logsumexp`

The model returns a log fixation density. To turn that into a probability
distribution, the natural shortcut is `exp(x - max(x)) / sum(...)`. That is
wrong when the dynamic range is large: subtracting only the maximum
underflows every other pixel to zero, and the saliency signal is destroyed.

`logsumexp` keeps the full range. The test in
`backend/tests/test_heatmap.py::test_normalise_to_probability_survives_large_dynamic_range`
pins this behaviour.

### Why the display map is stretched with a soft curve

A saliency map is very peaked: nearly every pixel sits near the bottom of the
range and only a handful reach the top. A min-max stretch therefore leaves
almost the whole page near zero. The viewer takes its alpha from the
intensity, so the result is a faint, almost transparent green wash with no
yellow and no red — even at 100 % opacity.

The display map is stretched against a percentile window (10th to 99th)
instead, and the low end is **not** hard-clipped to zero. Clipping draws a
contour where the intensity crosses the percentile, and that contour appears
in the viewer as a faint horizontal band across the page. A softplus curve
keeps the transition smooth, so no row jumps: the strongest row
discontinuity on the real capture fell from a hard step of 1.00 to 0.018.

The high percentile is the 99th, not the 99.5th. The top half percent of a
long page holds a handful of pixels, and one of them can be an artefact.
With 99.5 the whole page was scaled down so far that the hotspots of
several bands of the page stayed below the yellow part of the colormap, and
those bands looked empty.

The probability map that the statistics are computed from keeps the
*unstretched* values, so the numbers describe the real distribution of
attention rather than the stretched picture.

### Why the profile is flattened when it is too steep

The coarse pass shrinks the page so its longest side is `COARSE_INFERENCE_SIDE`.
On a long page that produces a very tall, very narrow strip — for a
1440 × 14052 capture, 105 × 1024, a 1:10 image. The model was trained on
short, wide images, and on such a strip its response over the middle of the
page collapses. The profile it returns is then far steeper than the page
really is: measured on that capture, the first band of the profile carried
27.7 % of the attention while a band in the middle carried 6 %.

Multiplied with the per-tile detail, that crushes every local hotspot in the
middle of the page below the visible part of the colormap. The middle of the
page came out empty while the first and last band were lit.

The profile is therefore flattened when it is steeper than
`PROFILE_STEEPNESS_LIMIT` (1.6), by raising it to a power. Two properties
matter:

- the power is **monotone**, so the order of the bands does not change and
  the profile still says which part of the page deserves more attention;
- a profile that is *not* steeper than the limit is returned **unchanged**,
  so a page that already works cannot get worse. Such a page exists: on a
  short page the profile is what lifts the local hotspots above the visible
  threshold, and flattening it would push them back down.

The flattening applies to the **display** map only. The statistics and the
top attention points are computed from the original profile, so they keep
describing the real distribution of attention.

Measured on the same 1440 × 14052 capture, the number of bands without a
visible hotspot fell from 7 out of 10 to none, while the attention split
stayed at 48/20/32 % and the above-the-fold share stayed at 18.3 %.

---

## The centre bias

DeepGaze was trained on natural images with a strong photographic centre
bias: people tend to look at the middle of a photograph. Applying that prior
to a 6,000 px web page pulls attention toward the middle of the page,
regardless of what is actually there.

| `CENTER_BIAS` | Behaviour |
|---|---|
| `uniform` | No prior. The default for web pages. |
| `vertical` | The prior is repeated down the page, so every screen-sized band gets the same amount. |
| `mit1003` | The original MIT1003 prior, rescaled to the image size. |

---

## The capture

### Scroll and slice

The content script walks the page in viewport-height steps. At each step it
waits for the layout to settle (220 ms plus a check that
`scrollHeight` stopped changing) before asking for a frame.

`chrome.tabs.captureVisibleTab` is rate limited to roughly 2 calls per second
by Chrome, so the service worker throttles the calls to 520 ms apart.

### Sticky headers

Fixed and sticky elements (navigation bars, cookie banners) appear in every
captured slice, which produces a repeated band across the stitched image. The
content script hides them **after the first frame** — so the top of the page
still shows the real header — and restores every one of them in a `finally`
block, along with the original scroll position.

### The last slice

The visible tab always captures a full viewport, but the last slice of a page
is usually shorter. The slice plan records its exact height, and the stitcher
crops the bottom of the frame to match, so the stitched image is exactly
`min(page height, max height)` pixels tall.

### Device pixel ratio

`captureVisibleTab` returns an image at the device pixel ratio, so the stitch
works in device pixels throughout. A 1440 CSS-pixel-wide page on a 2× display
produces a 2880-pixel-wide capture, which is what the backend receives.

---

## The viewer

### One transform, two layers

The original screenshot and the heatmap are drawn onto the same canvas with
the same transform matrix, so they stay pixel-aligned at every zoom level and
in every export. Opacity changes only touch `globalAlpha` — no redraw of the
source data, no server call.

### Client-side colormaps

The backend returns the raw grayscale saliency map. The viewer re-colours it
locally, so switching a colormap, changing the blur or moving the threshold
slider is instant and works offline.

The blur is a separable Gaussian, which costs linear time in the pixel count.

### Exports

Exports render at the **full original resolution**, not the on-screen zoom
level. The viewer draws the layers into an offscreen canvas at the source
dimensions and encodes that.

---

## Security

| Concern | Measure |
|---|---|
| Transport | HTTPS required for any non-loopback server; the options page refuses plain HTTP for a remote host. |
| Authentication | Bearer token, checked on every `/analyze` request. |
| Cross-origin | Strict CORS — only extension origins and the local development hosts. |
| Uploads | Content type, magic bytes and decoded dimensions are all validated. |
| Abuse | Sliding-window rate limit per token or client. |
| Storage | The images stay in the browser's own storage (IndexedDB) and are never sent anywhere except to the analysis server. The oldest results are removed automatically. |
| Logging | Request ids and timings only — no image content and no page URLs. |

---

## Privacy

A screenshot can contain anything on the page, including personal data. The
extension warns when the page contains a password field, and the backend
supports self-hosting so the image never leaves the machine.

---

## Performance

Measured on CPU only (no GPU available on the development machine):

| Page | Tiles | Inference | Total |
|---|---|---|---|
| 1440 × 2400 | 3 | 6.6 s | 8.4 s |
| 1440 × 2400 (with composite) | 3 | 8.1 s | 10.3 s |

On a GPU the inference step is typically 5–10× faster, which puts a typical
page inside the 10 s target from the project brief.
