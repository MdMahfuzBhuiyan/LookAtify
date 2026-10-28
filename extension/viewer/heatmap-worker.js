/**
 * LookAtify heatmap worker — builds the coloured heatmap off the main thread.
 *
 * A full-page saliency map has around 19 million pixels. Blurring and
 * colouring it takes about half a second, which is long enough to freeze the
 * viewer when it runs on the main thread. The work is therefore done here,
 * and the finished bitmap is handed back to the viewer.
 *
 * The source map is sent once and kept here. The worker also keeps the
 * blurred map for the last sigma it was asked for, so moving the threshold or
 * the colormap does not repeat the blur.
 */

import { applyColormap, applyThreshold, blurGrayscale } from "../lib/colormaps.js";

/**
 * The grayscale saliency map.
 *
 * @type {ImageData|null}
 */
let sourceMap = null;

/**
 * The blurred map, cached by sigma.
 *
 * @type {Map<number, ImageData>}
 */
const blurredCache = new Map();

/**
 * Build the heatmap for the given settings.
 *
 * @param {ImageData} source The grayscale saliency map.
 * @param {number} sigma Blur radius.
 * @param {number} threshold 0..1.
 * @param {string} colormap Colormap name.
 * @returns {{rgba: Uint8ClampedArray, width: number, height: number}}
 */
function buildHeatmap(source, sigma, threshold, colormap) {
  let blurred = blurredCache.get(sigma);
  if (!blurred) {
    blurred = blurGrayscale(source, sigma);
    // Only the last sigma is kept: a full-page map is large.
    blurredCache.clear();
    blurredCache.set(sigma, blurred);
  }

  const thresholded = applyThreshold(blurred, threshold);
  const rgba = applyColormap(thresholded, colormap);
  return { rgba, width: source.width, height: source.height };
}

self.addEventListener("message", (event) => {
  const message = event.data ?? {};
  const { type, id } = message;

  if (type === "SET_SOURCE") {
    try {
      sourceMap = new ImageData(
        new Uint8ClampedArray(message.pixels),
        message.width,
        message.height,
      );
      // The blurred map belongs to the old source.
      blurredCache.clear();
      self.postMessage({ type: "SOURCE_READY", id });
    } catch (error) {
      self.postMessage({
        type: "SOURCE_FAILED",
        id,
        error: error?.message || "The saliency map could not be read.",
      });
    }
    return;
  }

  if (type !== "BUILD_HEATMAP") return;

  if (!sourceMap) {
    self.postMessage({
      type: "HEATMAP_FAILED",
      id,
      error: "The saliency map was not sent to the worker.",
    });
    return;
  }

  try {
    const { rgba, width, height } = buildHeatmap(
      sourceMap,
      message.sigma,
      message.threshold,
      message.colormap,
    );

    // The buffer is transferred, not copied.
    self.postMessage(
      { type: "HEATMAP_READY", id, rgba: rgba.buffer, width, height },
      [rgba.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "HEATMAP_FAILED",
      id,
      error: error?.message || "The heatmap could not be built.",
    });
  }
});
