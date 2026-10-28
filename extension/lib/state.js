/**
 * Pure viewer state helpers.
 *
 * Every function here is side-effect free so the viewer behaviour (mode,
 * opacity, zoom, pan) can be unit tested without a DOM.
 */

/** Minimum and maximum zoom level (10% – 800%). */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** The four view modes the viewer supports. */
export const MODES = ["blended", "split", "heatmap", "original"];

/**
 * Clamp a zoom level into the supported range.
 *
 * @param {number} zoom
 * @returns {number}
 */
export function clampZoom(zoom) {
  const value = Number(zoom);
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * Format a zoom factor as a percentage label.
 *
 * @param {number} zoom
 * @returns {string} e.g. `"55%"`
 */
export function formatZoomPercent(zoom) {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}

/**
 * Zoom around a point so the content under the cursor stays in place.
 *
 * @param {Object} params
 * @param {number} params.zoom Current zoom factor.
 * @param {number} params.panX Current horizontal pan in pixels.
 * @param {number} params.panY Current vertical pan in pixels.
 * @param {number} params.pointerX Pointer position inside the viewport.
 * @param {number} params.pointerY Pointer position inside the viewport.
 * @param {number} params.viewportX Viewport width.
 * @param {number} params.viewportY Viewport height.
 * @param {number} params.factor Zoom multiplier (>1 zooms in).
 * @returns {{zoom: number, panX: number, panY: number}}
 */
export function zoomAroundPoint({
  zoom,
  panX,
  panY,
  pointerX,
  pointerY,
  viewportX,
  viewportY,
  factor,
}) {
  const nextZoom = clampZoom(zoom * factor);
  const appliedFactor = nextZoom / zoom;

  // The content point under the cursor must stay under the cursor.
  const contentX = (pointerX - panX) / zoom;
  const contentY = (pointerY - panY) / zoom;

  const nextPanX = pointerX - contentX * nextZoom;
  const nextPanY = pointerY - contentY * nextZoom;

  void viewportX;
  void viewportY;

  return { zoom: nextZoom, panX: nextPanX, panY: nextPanY };
}

/**
 * Compute the scale that fits the content into the viewport.
 *
 * @param {Object} params
 * @param {number} params.contentWidth
 * @param {number} params.contentHeight
 * @param {number} params.viewportWidth
 * @param {number} params.viewportHeight
 * @param {"width"|"screen"|"actual"} params.mode
 * @returns {number} Scale factor, clamped to the supported zoom range.
 */
export function fitScale({ contentWidth, contentHeight, viewportWidth, viewportHeight, mode }) {
  if (mode === "actual") return 1;
  if (!contentWidth || !contentHeight || !viewportWidth || !viewportHeight) return 1;

  const widthScale = viewportWidth / contentWidth;
  const heightScale = viewportHeight / contentHeight;
  const scale = mode === "width" ? widthScale : Math.min(widthScale, heightScale);

  return clampZoom(scale);
}

/**
 * Convert a pointer position into a 0..1 split fraction.
 *
 * @param {number} clientX
 * @param {{left: number, width: number}} bounds
 * @returns {number}
 */
export function splitFractionForPointer(clientX, bounds) {
  if (!bounds || !bounds.width) return 0.5;
  const fraction = (clientX - bounds.left) / bounds.width;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * Create the initial viewer state.
 *
 * @param {Object} [defaults]
 * @returns {Object}
 */
export function createViewerState(defaults = {}) {
  return {
    mode: MODES.includes(defaults.mode) ? defaults.mode : "blended",
    opacity: clampOpacity(defaults.opacity),
    zoom: clampZoom(defaults.zoom ?? 1),
    panX: Number(defaults.panX) || 0,
    panY: Number(defaults.panY) || 0,
    colormap: defaults.colormap || "jet",
    blurSigma: Math.max(0, Number(defaults.blurSigma) || 0),
    threshold: Math.min(1, Math.max(0, Number(defaults.threshold) || 0)),
    showTopN: Boolean(defaults.showTopN),
    showScanpath: Boolean(defaults.showScanpath),
    splitOrientation: defaults.splitOrientation || "vertical",
    splitPosition: Math.min(1, Math.max(0, Number(defaults.splitPosition ?? 0.5))),
  };
}

/**
 * Clamp an opacity value into 0..1.
 *
 * @param {number} opacity
 * @returns {number}
 */
export function clampOpacity(opacity) {
  const value = Number(opacity);
  if (!Number.isFinite(value)) return 0.55;
  return Math.min(1, Math.max(0, value));
}

/**
 * Apply one action to the viewer state.
 *
 * @param {Object} state Current state.
 * @param {Object} action Action to apply.
 * @returns {Object} A new state object.
 */
export function applyViewerAction(state, action) {
  if (!action || typeof action !== "object") return state;

  const next = { ...state };

  switch (action.type) {
    case "SET_MODE":
      if (MODES.includes(action.mode)) next.mode = action.mode;
      break;

    case "SET_OPACITY":
      next.opacity = clampOpacity(action.value);
      break;

    case "ZOOM_IN":
      next.zoom = clampZoom(next.zoom * 1.25);
      break;

    case "ZOOM_OUT":
      next.zoom = clampZoom(next.zoom / 1.25);
      break;

    case "ZOOM_RESET":
      next.zoom = 1;
      next.panX = 0;
      next.panY = 0;
      break;

    case "ZOOM_FIT_WIDTH":
    case "ZOOM_FIT_SCREEN":
      // The viewer computes the exact scale; the reducer only records intent.
      next.fitRequest = action.type === "ZOOM_FIT_WIDTH" ? "width" : "screen";
      break;

    case "SET_COLORMAP":
      next.colormap = action.value;
      break;

    case "SET_BLUR":
      next.blurSigma = Math.max(0, Number(action.value) || 0);
      break;

    case "SET_THRESHOLD":
      next.threshold = Math.min(1, Math.max(0, Number(action.value) || 0));
      break;

    case "TOGGLE_TOP_N":
      next.showTopN = action.value === undefined ? !next.showTopN : Boolean(action.value);
      break;

    case "TOGGLE_SCANPATH":
      next.showScanpath = action.value === undefined ? !next.showScanpath : Boolean(action.value);
      break;

    case "SET_SPLIT_ORIENTATION":
      next.splitOrientation = action.value === "horizontal" ? "horizontal" : "vertical";
      break;

    case "SET_SPLIT_POSITION":
      next.splitPosition = Math.min(1, Math.max(0, Number(action.value) || 0));
      break;

    case "PAN":
      next.panX = Number(action.panX) || 0;
      next.panY = Number(action.panY) || 0;
      break;

    case "SET_ZOOM":
      next.zoom = clampZoom(action.value);
      break;

    default:
      break;
  }

  return next;
}
