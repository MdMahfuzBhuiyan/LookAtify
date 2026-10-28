/**
 * Pure stitching math and page preparation for the full-page capture.
 *
 * The geometry functions have no browser dependencies so the capture geometry
 * can be unit tested. All offsets are in DEVICE pixels (CSS pixels multiplied
 * by the device pixel ratio), because that is the resolution the captured
 * frames are painted at.
 */

/**
 * The attribute that marks an element as hidden during the capture.
 *
 * @type {string}
 */
export const HIDDEN_ATTRIBUTE = "data-lookatify-hidden";

/**
 * The id of the style element that the capture installs in the page.
 *
 * @type {string}
 */
export const CAPTURE_STYLE_ID = "lookatify-capture-style";

/**
 * The CSS that the capture installs in the page.
 *
 * It solves three problems at once:
 *
 *   1. the marked elements and their descendants are hidden, so a fixed chat
 *      widget cannot repeat across the slices or turn into a hotspot;
 *   2. animations and transitions are switched off, so a carousel or a
 *      marquee shows the same frame in every slice;
 *   3. smooth scrolling is switched off, so the page jumps to the position
 *      the capture asked for instead of gliding towards it.
 *
 * @returns {string}
 */
export function captureStyleText() {
  return `
[${HIDDEN_ATTRIBUTE}], [${HIDDEN_ATTRIBUTE}] * {
  visibility: hidden !important;
  pointer-events: none !important;
}
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
}
html, body {
  scroll-behavior: auto !important;
}
`;
}

/**
 * Plan the scroll steps for a full-page capture.
 *
 * @param {Object} params
 * @param {number} params.scrollHeight Total scrollable height in CSS pixels.
 * @param {number} params.viewportHeight Visible height in CSS pixels.
 * @param {number} params.devicePixelRatio
 * @param {number} params.maxHeight Maximum height to capture, in CSS pixels.
 * @param {number} [params.currentScrollY] Scroll offset at the start.
 * @returns {Object} The slice plan.
 */
export function planSlices({
  scrollHeight,
  viewportHeight,
  devicePixelRatio = 1,
  maxHeight = 16000,
  currentScrollY = 0,
}) {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const viewport = Math.max(1, Math.floor(viewportHeight));
  const totalCss = Math.max(1, Math.floor(scrollHeight));
  const limit = Math.max(viewport, Math.floor(maxHeight));

  // The page is truncated at maxHeight; the last slice is cropped to match.
  const targetCss = Math.min(totalCss, limit);
  const truncated = totalCss > limit;

  // Start from the top of the document so the capture is deterministic.
  const slices = [];
  let index = 0;
  let scrollY = 0;

  while (scrollY < targetCss) {
    const remaining = targetCss - scrollY;
    const heightCss = Math.min(viewport, remaining);

    slices.push({
      index,
      scrollY,
      heightCss,
      // Where this slice starts in the final image, in device pixels.
      offsetY: Math.round(scrollY * ratio),
      sourceTopCss: 0,
      sourceHeightCss: heightCss,
      // The visible tab always captures a full viewport, so the region that
      // is kept starts at the top of the captured frame.
      cropTopCss: 0,
      cropTopDevice: 0,
    });

    index += 1;
    // A partial last slice ends the capture.
    if (heightCss < viewport) break;
    scrollY += viewport;
  }

  return {
    slices,
    totalHeightCss: targetCss,
    totalHeightDevice: Math.round(targetCss * ratio),
    widthDevice: 0,
    devicePixelRatio: ratio,
    truncated,
    pageHeightCss: totalCss,
    startScrollY: currentScrollY,
  };
}

/**
 * Compute the canvas size for the stitched image.
 *
 * @param {Object} params
 * @param {number} params.width Viewport width in CSS pixels.
 * @param {number} params.height Target height in CSS pixels.
 * @param {number} params.devicePixelRatio
 * @param {number} params.maxHeight Maximum height in CSS pixels.
 * @returns {{width: number, height: number}} Canvas size in device pixels.
 */
export function computeCanvasSize({ width, height, devicePixelRatio = 1, maxHeight = 16000 }) {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const limit = Math.max(1, Math.floor(maxHeight));
  const capped = Math.min(Math.max(1, Math.floor(height)), limit);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(capped * ratio)),
  };
}

/**
 * Y offset (in device pixels) where a slice is pasted onto the canvas.
 *
 * @param {Object} plan The plan returned by {@link planSlices}.
 * @param {number} index Slice index.
 * @returns {number}
 */
export function blendOffsetForSlice(plan, index) {
  const slice = plan.slices[index];
  if (!slice) return 0;
  return slice.offsetY;
}

/**
 * Estimate how many slices a capture will need.
 *
 * @param {number} pageHeight Page height in CSS pixels.
 * @param {number} viewportHeight Viewport height in CSS pixels.
 * @returns {number}
 */
export function estimateSliceCount(pageHeight, viewportHeight) {
  const viewport = Math.max(1, Math.floor(viewportHeight));
  const height = Math.max(0, Math.floor(pageHeight));
  return Math.max(1, Math.ceil(height / viewport));
}

/**
 * Work out where every captured slice goes on the canvas.
 *
 * The slices are placed at the position the page was really scrolled to, not
 * at the position the capture asked for. A page that scrolls smoothly, or that
 * clamps at the bottom, would otherwise be stitched with gaps and duplicated
 * content.
 *
 * Each slice is cut to exactly meet the next one. The device pixel ratio and
 * the viewport height rarely divide evenly, so consecutive slices can be a
 * single pixel apart; without cutting them to fit, that difference shows up
 * as a faint horizontal line across the whole page.
 *
 * @param {Array<{scrollY: number}>} slices The captured slices.
 * @param {Object} params
 * @param {number} params.canvasHeight The height of the canvas, in device pixels.
 * @param {number} params.devicePixelRatio
 * @returns {Array<{index: number, offsetY: number, sourceTop: number, sourceHeight: number, drawHeight: number}>}
 */
export function sliceLayout(slices, { canvasHeight, devicePixelRatio = 1 }) {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const canvas = Math.max(1, Math.floor(canvasHeight));

  return slices.map((slice, index) => {
    const offsetY = Math.min(canvas - 1, Math.max(0, Math.round(slice.scrollY * ratio)));

    // The next slice decides where this one has to stop.
    const next = slices[index + 1];
    const nextOffsetY = next
      ? Math.min(canvas - 1, Math.max(0, Math.round(next.scrollY * ratio)))
      : canvas;

    // The page can scroll less than a viewport when it is near the bottom.
    // The slice then overlaps its neighbour, so it is cut to the part that
    // is not covered yet.
    const gap = nextOffsetY - offsetY;
    const drawHeight =
      gap >= 1
        ? Math.min(gap, canvas - offsetY)
        : Math.max(1, Math.min(canvas - offsetY, 1));

    return {
      index,
      offsetY,
      // The slice is cut at the bottom, so the part that is kept is the top.
      sourceTop: 0,
      sourceHeight: drawHeight,
      drawHeight,
    };
  });
}

/**
 * The height of the stitched image, in CSS pixels.
 *
 * The capture can end before the bottom of the page, either because the page
 * was shorter than planned or because the limit was reached. The canvas is
 * only as tall as the content that was actually captured, so there is no
 * empty band at the bottom.
 *
 * @param {Object} params
 * @param {number} params.lastScrollY The scroll position of the last slice.
 * @param {number} params.viewportHeight The viewport height in CSS pixels.
 * @param {number} params.pageHeight The page height in CSS pixels.
 * @param {number} params.maxHeight The capture limit in CSS pixels.
 * @returns {number}
 */
export function capturedHeightFor({
  lastScrollY,
  viewportHeight,
  pageHeight,
  maxHeight = 16000,
}) {
  const viewport = Math.max(1, Math.floor(viewportHeight));
  const page = Math.max(0, Math.floor(pageHeight));
  const limit = Math.max(1, Math.floor(maxHeight));

  // The last slice shows the viewport, so it covers up to its scroll position
  // plus one viewport — but never past the end of the page.
  const covered = Math.max(0, Math.floor(lastScrollY)) + viewport;
  return Math.max(1, Math.min(covered, page || covered, limit));
}

/**
 * Detect elements that would repeat in every captured slice.
 *
 * Fixed elements are overlays: they sit on top of the content at all times,
 * so they are hidden for the whole capture. Sticky elements are part of the
 * layout, so the real header is kept in the first frame and hidden from the
 * second frame onwards.
 *
 * @param {Document|Element} root
 * @returns {Array<{element: Element, position: string, visibility: string}>}
 */
export function findStickyElements(root) {
  const found = [];
  const elements = root.querySelectorAll("*");

  for (const element of elements) {
    const style = window.getComputedStyle(element);
    const position = style.position;
    if (position !== "fixed" && position !== "sticky") continue;
    if (style.visibility === "hidden" || style.display === "none") continue;
    found.push({
      element,
      position,
      visibility: element.style.visibility,
    });
  }

  return found;
}

/**
 * Hide the elements that would repeat across slices.
 *
 * The elements are marked rather than styled directly, because the capture
 * style hides them together with their descendants. That way a widget that
 * injects its children later is hidden as well.
 *
 * @param {Array<{element: Element, position: string, visibility: string}>} entries
 * @returns {void}
 */
export function hideStickyElements(entries) {
  for (const entry of entries) {
    entry.element.setAttribute(HIDDEN_ATTRIBUTE, "");
  }
}

/**
 * Restore the elements hidden by {@link hideStickyElements}.
 *
 * @param {Array<{element: Element, position: string, visibility: string}>} entries
 * @returns {void}
 */
export function restoreStickyElements(entries) {
  for (const entry of entries) {
    entry.element.removeAttribute(HIDDEN_ATTRIBUTE);
  }
}
