# LookAtify user guide

---

## Installing

### Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin LookAtify to the toolbar.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `extension/manifest.firefox.json`.

> Firefox temporary add-ons are removed when the browser closes. For a
> permanent install, sign the manifest with `web-ext sign`.

---

## Connecting to the backend

LookAtify needs a running backend. Start one with:

```bash
cd backend
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Then open **Settings** from the popup and confirm the server URL. The dot next
to the logo shows the status:

| Dot | Meaning |
|---|---|
| Green | The server is reachable and the model is loaded. |
| Orange | Checking. |
| Red | The server cannot be reached, or the URL is wrong. |

**Test connection** in Settings gives a more precise answer, including which
device the model is running on.

### Using a token

If the backend has `API_TOKEN` set, put the same value in **Settings → API
token**. The token is stored in `chrome.storage.local` on your machine and is
sent as `Authorization: Bearer <token>`.

---

## Running an analysis

**Analyze Full Page** captures the entire scrollable page.
**Analyze Visible Area** captures only what is on screen — much faster, and
useful for a quick check of a landing page.

The progress bar shows four steps: **Capturing → Uploading → Analyzing →
Rendering**. **Cancel** stops the run at any point.

A keyboard shortcut is available: `Ctrl+Shift+A` (Windows/Linux) or
`Command+Shift+A` (macOS) analyses the full page.

### Saved analyses

Every analysis is kept on your machine so you can reopen it. The screenshot
and the heatmap are stored in the browser's own database, and the newest five
results are kept — older ones are removed automatically.

**Settings → Clear saved analyses** removes all of them at once. Use it if the
browser reports that the storage is full.

---

## The viewer

The viewer opens in a new tab once the analysis is ready.

### View modes

| Mode | What it shows |
|---|---|
| **Blended** | The screenshot with the heatmap on top. Use the opacity slider to see through it. |
| **Split** | The screenshot on one side, the heatmap on the other, with a draggable divider. |
| **Heatmap** | Only the heatmap, on a black background. |
| **Original** | The untouched screenshot. |

### Zoom and pan

| Control | Action |
|---|---|
| `+` / `−` | Zoom in and out |
| `Ctrl` + scroll | Zoom around the cursor |
| Scroll | Pan |
| Drag | Pan |
| **Fit width** | Fit the whole page width into the window |
| **Fit screen** | Fit the whole page into the window |
| **100%** | Reset to actual size |

The zoom range is 10% to 800%.

### Reading the heatmap

| Colour | Attention |
|---|---|
| Transparent | Little or no attention |
| Green | Low |
| Yellow | Medium |
| Orange | High |
| Red | Highest |

The legend in the bottom-right corner shows the scale. Switch to the
**Colour-blind safe** colormap in the toolbar if green-to-red is hard to
distinguish.

### Refining the result

| Control | Effect |
|---|---|
| **Opacity** | How strongly the heatmap covers the screenshot. |
| **Blur** | Widens the hotspots. Increase it when the heatmap looks speckled. |
| **Threshold** | Hides areas below a certain attention level, so only the strong hotspots remain. |
| **Top-N** | Marks the strongest attention points with numbered circles. |

All four are applied instantly, on your machine — the screenshot is not sent
to the server again.

### The side panel

- **Attention summary** — how much attention lands above the fold, in each
  vertical third, and on each half of the page. It also lists any warnings
  about approximations.
- **Top attention points** — click a row to jump to that point in the image.

---

## Exporting

**Export PNG** and **Export JPEG** save the image exactly as it is currently
displayed, at the **full original resolution** — not at the on-screen zoom
level. Files are named:

```
attention-{hostname}-{YYYYMMDD-HHmm}.png
```

For example `attention-example.com-20240521-1432.png`.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `1` | Blended mode |
| `2` | Split mode |
| `3` | Heatmap only |
| `4` | Original only |
| `+` / `−` | Zoom in / out |
| `0` | Fit to width |
| `H` | Toggle the heatmap |
| `E` | Export as PNG |
| `Esc` | Close the viewer |

---

## Interpreting the results

**Attention is not the same as clicks.** A heatmap shows where the eye is
likely to go, not what a visitor will do. Combine it with your analytics to
draw conclusions.

**A heatmap is a design aid, not ground truth.** DeepGaze learned from
photographs of natural scenes. Web pages differ from those, and the model
does not read text — a headline full of words is not "interesting" to it the
way a face is.

**Distant regions are hard to compare.** Long pages are analysed in tiles, so
"is the hero more attention-grabbing than the footer?" is a rough judgement.

**Watch for false positives.** Large flat areas of colour, bright images and
high-contrast text all attract attention from the model, whether or not they
matter to a reader.

---

## Troubleshooting

### "Cannot reach the analysis server"

The backend is not running, or the URL is wrong. Check:

```bash
curl http://127.0.0.1:8001/health
```

A JSON response means the server is up. If the request hangs, the model may
still be loading — the first start downloads ~400 MB of weights.

### "The API token was rejected"

The token in Settings does not match `API_TOKEN` on the backend.

### "The page could not be captured"

Chrome blocks extensions on `chrome://` pages, the Web Store and other
restricted pages. Firefox blocks them on `about:` pages. Try a normal page.

### "This page was analysed as N tiles"

A normal note for a long page. It means comparisons between distant regions
are approximate.

### "The page was scaled to N% for inference"

The page is wider than the inference width, so it was scaled down first. Very
small text may be smoothed out. Reduce the browser zoom or use a narrower
window if this matters.

### The heatmap looks wrong

- Try a different **colormap** — some ramps hide low-intensity areas.
- Raise the **blur** slightly to see the overall shape.
- Check the **threshold** is not set too high.

### The capture repeats a header

Some sticky elements cannot be hidden (for example, elements inside a
cross-origin iframe). This is a known limitation.

---

## Privacy

Screenshots are sent to the server you configure. If that server is not yours,
your page content — including anything personal on it — is sent to a third
party. LookAtify warns when the page contains a password field, but it cannot
guarantee a page is safe to capture.

Self-host the backend and the image never leaves your machine.
