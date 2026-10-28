/**
 * LookAtify viewer — interactive heatmap viewer.
 *
 * The viewer renders the screenshot and the heatmap on stacked canvases that
 * share one transform matrix, so the two layers stay pixel-aligned at every
 * zoom level. Colormap, blur and threshold are re-applied on the client from
 * the raw grayscale saliency map, so those controls never need a server call.
 */

import {
  BRAND,
  STORAGE_KEYS,
  VIEW_MODES,
  VIEWER_SHORTCUTS,
  withDefaults,
} from "../lib/config.js";
import { COLORMAPS, applyColormap, applyThreshold, blurGrayscale } from "../lib/colormaps.js";
import { exportImage, exportFilename } from "../lib/export.js";
import { summaryRows } from "../lib/summary.js";
import { readAnalysis } from "../lib/storage.js";
import {
  applyViewerAction,
  createViewerState,
  fitScale,
  formatZoomPercent,
  splitFractionForPointer,
  zoomAroundPoint,
} from "../lib/state.js";

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("canvas"));
const context = canvas.getContext("2d");
const stage = document.getElementById("stage");
const emptyState = document.getElementById("empty-state");
const loadingState = document.getElementById("loading-state");
const errorState = document.getElementById("error-state");
const errorDetail = document.getElementById("error-detail");
const panel = document.getElementById("panel");
const panelToggle = document.getElementById("panel-toggle");
const splitDivider = document.getElementById("split-divider");
const legend = document.getElementById("legend");

/** Runtime data for the current analysis. */
const runtime = {
  /** @type {ImageBitmap|HTMLImageElement|null} */
  original: null,
  /** @type {ImageBitmap|HTMLImageElement|null} */
  heatmap: null,
  /** @type {ImageData|null} */
  saliency: null,
  /** @type {AnalysisPayload|null} */
  analysis: null,
  /** @type {string} */
  hostname: "",
  /** @type {Map<string, ImageBitmap>} */
  colormapCache: new Map(),
  /**
   * The grayscale map, read from the saliency bitmap once.
   *
   * @type {ImageData|null}
   */
  sourcePixels: null,
  /**
   * The worker that builds the heatmap off the main thread.
   *
   * @type {Worker|null}
   */
  worker: null,
  /** Set when the worker has been given the saliency map. */
  workerHasSource: false,
  /** Set when the worker could not be used, so it is not tried again. */
  workerFailed: false,
};

/**
 * The blur and threshold sliders fire on every pointer move.
 *
 * A full-page rebuild is far too slow to run that often, so the work is
 * debounced: the panel stays responsive and the heatmap catches up as soon
 * as the user stops moving the slider.
 */
const REBUILD_DEBOUNCE_MS = 120;

/** The pending rebuild timer. */
let rebuildTimer = null;

/** The build that was requested last, so a stale build cannot overwrite a newer one. */
let rebuildToken = 0;

/** The request counter for the worker. */
let workerRequestId = 0;

let state = createViewerState();
let splitDragging = false;

/* ------------------------------------------------------------------ */
/* data loading                                                        */
/* ------------------------------------------------------------------ */

/**
 * Load the analysis stored by the service worker.
 *
 * The images live in IndexedDB, because they are too large for the settings
 * area. The small metadata record in `chrome.storage.local` only says which
 * analyses exist, so the record itself is read from the database.
 */
async function loadAnalysis() {
  const params = new URLSearchParams(location.search);
  const analysisId = params.get("id");

  let id = analysisId;
  if (!id) {
    const last = await chrome.storage.local.get(STORAGE_KEYS.lastAnalysis);
    id = last[STORAGE_KEYS.lastAnalysis] || null;
  }

  if (!id) {
    showError("No analysis found. Run an analysis from the LookAtify popup first.");
    return;
  }

  const payload = await readAnalysis(id);
  if (!payload) {
    showError("No analysis found. Run an analysis from the LookAtify popup first.");
    return;
  }

  try {
    runtime.analysis = payload;
    runtime.original = await loadImage(payload.imageBlob);
    runtime.saliency = await loadImage(payload.saliencyBlob);
    runtime.hostname = payload.hostname || "page";
    runtime.worker = startHeatmapWorker();

    const settings = withDefaults(
      (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings],
    );
    state = createViewerState({
      mode: settings.defaultMode,
      opacity: settings.defaultOpacity,
      colormap: settings.defaultColormap,
    });

    await rebuildHeatmap();
    populateSummary(payload);
    populateTopPoints(payload);
    emptyState.hidden = true;
    loadingState.hidden = true;
    resize();
    applyState();
  } catch (error) {
    showError(`Could not open the analysis: ${error.message}`);
  }
}

/**
 * Load an image from a stored blob into an ImageBitmap.
 *
 * @param {Blob|null} blob
 * @returns {Promise<ImageBitmap>}
 */
async function loadImage(blob) {
  if (!blob) throw new Error("The stored image is missing.");
  return createImageBitmap(blob);
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read the grayscale saliency map into memory, once.
 *
 * @returns {ImageData|null}
 */
function readSourcePixels() {
  if (runtime.sourcePixels) return runtime.sourcePixels;
  if (!runtime.saliency || !runtime.saliency.width) return null;

  const width = runtime.saliency.width;
  const height = runtime.saliency.height;

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(runtime.saliency, 0, 0);
  runtime.sourcePixels = sourceContext.getImageData(0, 0, width, height);
  return runtime.sourcePixels;
}

/**
 * Build the heatmap on the main thread.
 *
 * This is the fallback for browsers without a worker, and for the case where
 * the worker fails. It is noticeably slower, because it blocks the viewer.
 *
 * @param {ImageData} source The grayscale saliency map.
 * @param {number} sigma
 * @param {number} threshold
 * @param {string} colormap
 * @returns {{rgba: Uint8ClampedArray, width: number, height: number}}
 */
function buildHeatmapOnMainThread(source, sigma, threshold, colormap) {
  const blurred = blurGrayscale(source, sigma);
  const thresholded = applyThreshold(blurred, threshold);
  const rgba = applyColormap(thresholded, colormap);
  return { rgba, width: source.width, height: source.height };
}

/**
 * Start the heatmap worker, if the browser supports one.
 *
 * @returns {Worker|null}
 */
function startHeatmapWorker() {
  if (typeof Worker === "undefined") return null;

  try {
    const worker = new Worker(new URL("./heatmap-worker.js", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("error", () => {
      // Fall back to the main thread for the rest of the session.
      runtime.worker = null;
      runtime.workerFailed = true;
    });
    return worker;
  } catch {
    return null;
  }
}

/**
 * Rebuild the heatmap bitmap from the saliency map using the current settings.
 *
 * The work happens in a worker, because a full-page map takes about half a
 * second to blur and colour. The worker keeps the blurred map, so moving the
 * threshold or the colormap does not repeat the blur.
 */
async function rebuildHeatmap() {
  const token = ++rebuildToken;

  const source = readSourcePixels();
  if (!source) return;

  const { width, height } = source;
  const sigma = state.blurSigma;
  const threshold = state.threshold;
  const colormap = state.colormap;

  let rgba = null;

  if (runtime.worker && !runtime.workerFailed) {
    rgba = await requestHeatmapFromWorker(source, sigma, threshold, colormap);
  }

  // The worker is unavailable or failed: do the work here instead.
  if (!rgba) {
    const built = buildHeatmapOnMainThread(source, sigma, threshold, colormap);
    rgba = built.rgba;
  }

  // A newer rebuild started while this one was running: drop the result,
  // otherwise the viewer would show the older settings.
  if (token !== rebuildToken) return;

  const output = new ImageData(rgba, width, height);
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  outputCanvas.getContext("2d").putImageData(output, 0, 0);

  const bitmap = await createImageBitmap(outputCanvas);

  if (token !== rebuildToken) return;

  runtime.heatmap = bitmap;
  runtime.colormapCache.clear();
  applyState();
}

/**
 * Ask the worker for a heatmap.
 *
 * @param {ImageData} source The grayscale saliency map.
 * @param {number} sigma
 * @param {number} threshold
 * @param {string} colormap
 * @returns {Promise<Uint8ClampedArray|null>}
 */
async function requestHeatmapFromWorker(source, sigma, threshold, colormap) {
  const id = ++workerRequestId;

  // The source is sent once and kept by the worker, so later requests only
  // carry the settings.
  if (!runtime.workerHasSource) {
    const sent = await sendSourceToWorker(source);
    if (!sent) return null;
    runtime.workerHasSource = true;
  }

  return new Promise((resolve) => {
    const handler = (event) => {
      const message = event.data;
      if (!message || message.id !== id) return;

      if (message.type === "HEATMAP_READY") {
        runtime.worker.removeEventListener("message", handler);
        resolve(new Uint8ClampedArray(message.rgba));
        return;
      }

      if (message.type === "HEATMAP_FAILED") {
        runtime.worker.removeEventListener("message", handler);
        runtime.workerFailed = true;
        resolve(null);
      }
    };

    runtime.worker.addEventListener("message", handler);
    runtime.worker.postMessage({
      type: "BUILD_HEATMAP",
      id,
      sigma,
      threshold,
      colormap,
    });
  });
}

/**
 * Send the saliency map to the worker.
 *
 * @param {ImageData} source
 * @returns {Promise<boolean>}
 */
function sendSourceToWorker(source) {
  const id = ++workerRequestId;

  return new Promise((resolve) => {
    const handler = (event) => {
      const message = event.data;
      if (!message || message.id !== id) return;

      runtime.worker.removeEventListener("message", handler);

      if (message.type === "SOURCE_READY") {
        resolve(true);
        return;
      }

      runtime.workerFailed = true;
      runtime.workerHasSource = false;
      resolve(false);
    };

    runtime.worker.addEventListener("message", handler);

    // The pixel buffer is transferred, not copied.
    const copy = new Uint8ClampedArray(source.data);
    runtime.worker.postMessage(
      {
        type: "SET_SOURCE",
        id,
        pixels: copy.buffer,
        width: source.width,
        height: source.height,
      },
      [copy.buffer],
    );
  });
}

/**
 * Schedule a rebuild, replacing any that is already pending.
 *
 * The sliders fire on every pointer move, and a full-page rebuild is far
 * too slow to run that often.
 */
function scheduleRebuild() {
  if (rebuildTimer !== null) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void rebuildHeatmap();
  }, REBUILD_DEBOUNCE_MS);
}

/** Resize the canvas to the stage size. */
function resize() {
  const rect = stage.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  applyState();
}

/** Draw the current frame. */
function applyState() {
  if (!runtime.original || !runtime.heatmap) return;

  const ratio = window.devicePixelRatio || 1;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);

  const sourceWidth = runtime.original.width;
  const sourceHeight = runtime.original.height;

  const scale = state.zoom * ratio;
  const offsetX = state.panX * ratio;
  const offsetY = state.panY * ratio;

  const draw = (image, opacity) => {
    context.save();
    context.globalAlpha = opacity;
    context.imageSmoothingEnabled = state.zoom < 3;
    context.drawImage(image, offsetX, offsetY, sourceWidth * scale, sourceHeight * scale);
    context.restore();
  };

  if (state.mode === "original") {
    draw(runtime.original, 1);
  } else if (state.mode === "heatmap") {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    draw(runtime.heatmap, 1);
  } else if (state.mode === "split") {
    const rect = canvas.getBoundingClientRect();
    const splitX = state.splitPosition * rect.width;
    const clipX = splitX * ratio;

    context.save();
    context.beginPath();
    context.rect(0, 0, clipX, canvas.height);
    context.clip();
    draw(runtime.original, 1);
    context.restore();

    context.save();
    context.beginPath();
    context.rect(clipX, 0, canvas.width - clipX, canvas.height);
    context.clip();
    context.fillStyle = "#000000";
    context.fillRect(clipX, 0, canvas.width - clipX, canvas.height);
    draw(runtime.heatmap, 1);
    context.restore();

    splitDivider.style.left = `${splitX}px`;
    splitDivider.hidden = false;
  } else {
    draw(runtime.original, 1);
    draw(runtime.heatmap, state.opacity);
    splitDivider.hidden = true;
  }

  if (state.mode !== "split") splitDivider.hidden = true;

  drawTopPointMarkers();
  updateToolbarState();
}

/** Draw the numbered top-N markers. */
function drawTopPointMarkers() {
  if (!state.showTopN || !runtime.analysis || state.mode === "heatmap") return;

  const points = runtime.analysis.topPoints || [];
  if (points.length === 0) return;

  const ratio = window.devicePixelRatio || 1;
  const scale = state.zoom * ratio;
  const sourceWidth = runtime.original.width;
  const sourceHeight = runtime.original.height;

  context.save();
  context.font = `${13 * ratio}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const point of points) {
    const x = state.panX * ratio + point.x * scale;
    const y = state.panY * ratio + point.y * scale;
    const radius = 13 * ratio * Math.min(1.6, Math.max(0.6, state.zoom));

    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = "rgba(194, 112, 61, 0.92)";
    context.fill();
    context.lineWidth = 2 * ratio;
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.stroke();

    context.fillStyle = "#ffffff";
    context.fillText(String(point.rank), x, y + 0.5 * ratio);
  }
  context.restore();
}

/* ------------------------------------------------------------------ */
/* toolbar                                                             */
/* ------------------------------------------------------------------ */

/** Push the current state into the toolbar controls. */
function updateToolbarState() {
  for (const button of document.querySelectorAll("[data-mode]")) {
    const isActive = button.dataset.mode === state.mode;
    button.setAttribute("aria-pressed", String(isActive));
    button.classList.toggle("is-active", isActive);
  }

  const opacitySlider = /** @type {HTMLInputElement} */ (document.getElementById("opacity"));
  opacitySlider.value = String(Math.round(state.opacity * 100));
  document.getElementById("opacity-value").textContent = `${opacitySlider.value}%`;

  const zoomLabel = document.getElementById("zoom-value");
  zoomLabel.textContent = formatZoomPercent(state.zoom);

  const colormapSelect = /** @type {HTMLSelectElement} */ (document.getElementById("colormap"));
  colormapSelect.value = state.colormap;

  const blurSlider = /** @type {HTMLInputElement} */ (document.getElementById("blur"));
  blurSlider.value = String(state.blurSigma);
  document.getElementById("blur-value").textContent = `${state.blurSigma}`;

  const thresholdSlider = /** @type {HTMLInputElement} */ (document.getElementById("threshold"));
  thresholdSlider.value = String(Math.round(state.threshold * 100));
  document.getElementById("threshold-value").textContent = `${thresholdSlider.value}%`;

  const topNToggle = /** @type {HTMLInputElement} */ (document.getElementById("toggle-top-n"));
  topNToggle.checked = state.showTopN;

  const legendBar = document.getElementById("legend-bar");
  const gradient = COLORMAPS[state.colormap]?.css ?? COLORMAPS.jet.css;
  legendBar.style.background = gradient;
}

/** Dispatch an action through the reducer and re-render. */
function dispatch(action) {
  const previous = state;
  state = applyViewerAction(state, action);

  if (previous.mode !== state.mode || previous.splitPosition !== state.splitPosition) {
    splitDivider.hidden = state.mode !== "split";
  }
  if (
    previous.colormap !== state.colormap ||
    previous.blurSigma !== state.blurSigma ||
    previous.threshold !== state.threshold
  ) {
    // The rebuild is debounced: the sliders fire on every pointer move and a
    // full-page rebuild cannot keep up with that.
    scheduleRebuild();
    applyState();
    persistPreferences();
    return;
  }

  applyState();
  persistPreferences();
}

/** Save the view preferences for the next session. */
function persistPreferences() {
  chrome.storage.local.set({
    lookatify_viewer_prefs: {
      mode: state.mode,
      opacity: state.opacity,
      colormap: state.colormap,
      showTopN: state.showTopN,
    },
  });
}

/* ------------------------------------------------------------------ */
/* zoom and pan                                                        */
/* ------------------------------------------------------------------ */

/** Fit the content into the stage. */
function fit(mode) {
  if (!runtime.original) return;
  const rect = stage.getBoundingClientRect();
  const scale = fitScale({
    contentWidth: runtime.original.width,
    contentHeight: runtime.original.height,
    viewportWidth: rect.width,
    viewportHeight: rect.height,
    mode,
  });

  const offsetX = (rect.width - runtime.original.width * scale) / 2;
  const offsetY = (rect.height - runtime.original.height * scale) / 2;

  state.zoom = scale;
  state.panX = offsetX;
  state.panY = offsetY;
  applyState();
}

/** Handle a wheel event for zooming or scrolling. */
function onWheel(event) {
  if (!runtime.original) return;

  const rect = stage.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;

  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.002);
    const result = zoomAroundPoint({
      zoom: state.zoom,
      panX: state.panX,
      panY: state.panY,
      pointerX,
      pointerY,
      viewportX: rect.width,
      viewportY: rect.height,
      factor,
    });
    state.zoom = result.zoom;
    state.panX = result.panX;
    state.panY = result.panY;
    applyState();
    return;
  }

  state.panX -= event.deltaX;
  state.panY -= event.deltaY;
  applyState();
}

/** Drag to pan the image. */
let panning = false;
let panStart = { x: 0, y: 0, panX: 0, panY: 0 };

function onPointerDown(event) {
  if (event.target === splitDivider || splitDivider.contains(event.target)) return;
  panning = true;
  panStart = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("is-panning");
}

function onPointerMove(event) {
  if (splitDragging) {
    const rect = stage.getBoundingClientRect();
    const fraction = splitFractionForPointer(event.clientX, rect);
    state.splitPosition = fraction;
    applyState();
    return;
  }
  if (!panning) return;
  state.panX = panStart.panX + (event.clientX - panStart.x);
  state.panY = panStart.panY + (event.clientY - panStart.y);
  applyState();
}

function onPointerUp(event) {
  panning = false;
  splitDragging = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  canvas.classList.remove("is-panning");
}

/* ------------------------------------------------------------------ */
/* side panel                                                          */
/* ------------------------------------------------------------------ */

/** Fill the attention summary panel. */
function populateSummary(analysis) {
  const container = document.getElementById("summary");

  container.innerHTML = "";

  for (const [label, value] of summaryRows(analysis)) {
    const row = document.createElement("div");
    row.className = "summary__row";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = value;
    row.append(labelNode, valueNode);
    container.append(row);
  }

  const warnings = analysis.warnings || [];
  if (warnings.length > 0) {
    const list = document.createElement("ul");
    list.className = "summary__warnings";
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    }
    container.append(list);
  }
}

/** Fill the top-N list. */
function populateTopPoints(analysis) {
  const list = document.getElementById("top-points");
  list.innerHTML = "";

  const points = analysis.topPoints || [];
  if (points.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No strong peaks were detected.";
    list.append(empty);
    return;
  }

  for (const point of points) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "top-point";
    button.textContent = `#${point.rank}  (${point.x}, ${point.y})  ${Math.round(point.score * 100)}%`;
    button.addEventListener("click", () => jumpToPoint(point));
    item.append(button);
    list.append(item);
  }
}

/** Scroll the view so a point is centred. */
function jumpToPoint(point) {
  if (!runtime.original) return;
  const rect = stage.getBoundingClientRect();
  state.panX = rect.width / 2 - point.x * state.zoom;
  state.panY = rect.height / 2 - point.y * state.zoom;
  applyState();
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

/** Export the current view at full resolution. */
async function exportCurrent(format) {
  if (!runtime.original || !runtime.heatmap) return;

  const width = runtime.original.width;
  const height = runtime.original.height;

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d");

  if (state.mode === "original") {
    outputContext.drawImage(runtime.original, 0, 0);
  } else if (state.mode === "heatmap") {
    outputContext.fillStyle = "#000000";
    outputContext.fillRect(0, 0, width, height);
    outputContext.drawImage(runtime.heatmap, 0, 0);
  } else if (state.mode === "split") {
    const splitX = Math.round(state.splitPosition * width);
    outputContext.drawImage(runtime.original, 0, 0, splitX, height, 0, 0, splitX, height);
    outputContext.fillStyle = "#000000";
    outputContext.fillRect(splitX, 0, width - splitX, height);
    outputContext.drawImage(runtime.heatmap, 0, 0, width - splitX, height, splitX, 0, width - splitX, height);
  } else {
    outputContext.drawImage(runtime.original, 0, 0);
    outputContext.globalAlpha = state.opacity;
    outputContext.drawImage(runtime.heatmap, 0, 0);
    outputContext.globalAlpha = 1;
  }

  const filename = exportFilename({
    hostname: runtime.hostname,
    format,
    date: new Date(),
  });

  await exportImage(output, filename, format);
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

/** Show a fatal error in the stage. */
function showError(text) {
  loadingState.hidden = true;
  emptyState.hidden = true;
  errorState.hidden = false;
  errorDetail.textContent = text;
}

function bindToolbar() {
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => dispatch({ type: "SET_MODE", mode: button.dataset.mode }));
  }

  document.getElementById("zoom-in").addEventListener("click", () => dispatch({ type: "ZOOM_IN" }));
  document.getElementById("zoom-out").addEventListener("click", () => dispatch({ type: "ZOOM_OUT" }));
  document.getElementById("zoom-reset").addEventListener("click", () => dispatch({ type: "ZOOM_RESET" }));
  document.getElementById("fit-width").addEventListener("click", () => fit("width"));
  document.getElementById("fit-screen").addEventListener("click", () => fit("screen"));

  const opacitySlider = /** @type {HTMLInputElement} */ (document.getElementById("opacity"));
  opacitySlider.addEventListener("input", () => {
    dispatch({ type: "SET_OPACITY", value: Number(opacitySlider.value) / 100 });
  });

  const colormapSelect = /** @type {HTMLSelectElement} */ (document.getElementById("colormap"));
  colormapSelect.addEventListener("change", () => {
    dispatch({ type: "SET_COLORMAP", value: colormapSelect.value });
  });

  const blurSlider = /** @type {HTMLInputElement} */ (document.getElementById("blur"));
  blurSlider.addEventListener("input", () => {
    dispatch({ type: "SET_BLUR", value: Number(blurSlider.value) });
  });

  const thresholdSlider = /** @type {HTMLInputElement} */ (document.getElementById("threshold"));
  thresholdSlider.addEventListener("input", () => {
    dispatch({ type: "SET_THRESHOLD", value: Number(thresholdSlider.value) / 100 });
  });

  const topNToggle = /** @type {HTMLInputElement} */ (document.getElementById("toggle-top-n"));
  topNToggle.addEventListener("change", () => {
    dispatch({ type: "TOGGLE_TOP_N", value: topNToggle.checked });
  });

  for (const button of document.querySelectorAll("[data-export]")) {
    button.addEventListener("click", () => exportCurrent(button.dataset.export));
  }

  document.getElementById("close").addEventListener("click", () => window.close());

  panelToggle.addEventListener("click", () => {
    panel.classList.toggle("is-collapsed");
    panelToggle.setAttribute("aria-expanded", String(!panel.classList.contains("is-collapsed")));
  });
}

function bindStage() {
  stage.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  splitDivider.addEventListener("pointerdown", (event) => {
    splitDragging = true;
    splitDivider.setPointerCapture(event.pointerId);
    event.stopPropagation();
  });
  splitDivider.addEventListener("pointermove", onPointerMove);
  splitDivider.addEventListener("pointerup", onPointerUp);

  window.addEventListener("resize", resize);
}

function bindKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }

    const mode = VIEWER_SHORTCUTS[event.key];
    if (mode) {
      dispatch({ type: "SET_MODE", mode });
      return;
    }

    switch (event.key) {
      case "+":
      case "=":
        dispatch({ type: "ZOOM_IN" });
        break;
      case "-":
        dispatch({ type: "ZOOM_OUT" });
        break;
      case "0":
        fit("width");
        break;
      case "h":
      case "H":
        dispatch({ type: "SET_MODE", mode: state.mode === "heatmap" ? "blended" : "heatmap" });
        break;
      case "e":
      case "E":
        exportCurrent("png");
        break;
      case "Escape":
        window.close();
        break;
      default:
        break;
    }
  });
}

bindToolbar();
bindStage();
bindKeyboard();
loadAnalysis();

document.getElementById("brand-name").textContent = BRAND.name;
