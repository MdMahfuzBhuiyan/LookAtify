/**
 * Client-side colormaps.
 *
 * The backend returns a raw grayscale saliency map; the viewer re-colours it
 * locally so switching a colormap, blurring it or applying a threshold is
 * instant and never needs a server round trip.
 *
 * Each colormap is defined by anchor colours from low attention to high
 * attention, matching the palettes on the server.
 */

/**
 * @typedef {Object} Colormap
 * @property {string} css        CSS gradient for the legend.
 * @property {[number,number,number][]} anchors  RGB anchors in 0..255.
 */

/** @type {Record<string, Colormap>} */
export const COLORMAPS = {
  jet: {
    css: "linear-gradient(to right, #006837, #28be5a, #dcdc28, #f0961e, #dc281e)",
    anchors: [
      [0, 104, 55],
      [40, 190, 90],
      [220, 220, 40],
      [240, 150, 30],
      [220, 40, 30],
    ],
  },
  turbo: {
    css: "linear-gradient(to right, #30123b, #466be3, #2ac7c4, #97e03a, #faa61e, #be1e2d)",
    anchors: [
      [48, 18, 59],
      [70, 107, 227],
      [42, 199, 196],
      [151, 224, 58],
      [250, 166, 30],
      [190, 30, 45],
    ],
  },
  viridis: {
    css: "linear-gradient(to right, #440154, #3b528b, #21918c, #5ec962, #fde725)",
    anchors: [
      [68, 1, 84],
      [59, 82, 139],
      [33, 145, 140],
      [94, 201, 98],
      [253, 231, 37],
    ],
  },
  hot: {
    css: "linear-gradient(to right, #000000, #8c0000, #dc4600, #ffaa00, #ffffd2)",
    anchors: [
      [0, 0, 0],
      [140, 0, 0],
      [220, 70, 0],
      [255, 170, 0],
      [255, 255, 210],
    ],
  },
  colorblind: {
    css: "linear-gradient(to right, #0c2c5c, #186e91, #3caa9f, #d7cd5a, #faf5af)",
    anchors: [
      [12, 44, 92],
      [24, 110, 145],
      [60, 170, 160],
      [215, 205, 90],
      [250, 245, 175],
    ],
  },
};

/** Names of the available colormaps. */
export const COLORMAP_NAMES = Object.keys(COLORMAPS);

/**
 * Build a 256-entry lookup table for a colormap.
 *
 * @param {string} name Colormap name.
 * @returns {Uint8ClampedArray} 768 bytes of RGB values.
 */
export function buildLookupTable(name) {
  const colormap = COLORMAPS[name] ?? COLORMAPS.jet;
  const table = new Uint8ClampedArray(256 * 3);
  const anchors = colormap.anchors;

  for (let index = 0; index < 256; index += 1) {
    const position = index / 255;
    const scaled = position * (anchors.length - 1);
    const lower = Math.min(anchors.length - 1, Math.floor(scaled));
    const upper = Math.min(anchors.length - 1, lower + 1);
    const fraction = scaled - lower;

    for (let channel = 0; channel < 3; channel += 1) {
      const low = anchors[lower][channel];
      const high = anchors[upper][channel];
      table[index * 3 + channel] = Math.round(low + (high - low) * fraction);
    }
  }
  return table;
}

/**
 * Apply a colormap to a grayscale image.
 *
 * @param {ImageData} imageData Source grayscale image.
 * @param {string} name Colormap name.
 * @returns {Uint8ClampedArray} RGBA bytes.
 */
export function applyColormap(imageData, name) {
  const table = buildLookupTable(name);
  const pixels = imageData.data;
  const output = new Uint8ClampedArray(pixels.length);

  for (let index = 0; index < pixels.length; index += 4) {
    const gray = pixels[index];
    output[index] = table[gray * 3];
    output[index + 1] = table[gray * 3 + 1];
    output[index + 2] = table[gray * 3 + 2];
    // The alpha ramp makes low attention fade out over the screenshot.
    output[index + 3] = gray;
  }
  return output;
}

/**
 * Zero out pixels below a threshold.
 *
 * @param {ImageData} imageData Grayscale image.
 * @param {number} threshold 0..1.
 * @returns {ImageData} A new image with the low intensities removed.
 */
export function applyThreshold(imageData, threshold) {
  if (threshold <= 0) return imageData;

  const pixels = new Uint8ClampedArray(imageData.data);
  const cutoff = Math.round(threshold * 255);

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < cutoff) {
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
      pixels[index + 3] = 0;
    }
  }
  return new ImageData(pixels, imageData.width, imageData.height);
}

/**
 * Create a canvas of the given size.
 *
 * A worker has no `document`, so it uses `OffscreenCanvas` instead. The same
 * code therefore works on the main thread and inside the heatmap worker.
 *
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
function createCanvas(width, height) {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new OffscreenCanvas(width, height);
}

/**
 * Apply a Gaussian blur to a grayscale image.
 *
 * The blur is done by the browser's own image pipeline, through the canvas
 * `filter` property. A hand-written JavaScript kernel is far too slow for
 * a full-page map: on a 1440 x 13316 page the old implementation spent
 * 1.2 seconds at sigma 2 and about 3.4 seconds at sigma 8, which froze the
 * viewer on every slider tick. The native filter takes about 0.37 seconds
 * whatever the sigma, because the work happens in the compositor.
 *
 * The image is drawn onto a padded canvas first, because the native filter
 * samples the pixels outside the drawn area, which are transparent. Without
 * the padding the border of the result fades out; with it the edges keep the
 * same value as the old edge-clamping kernel.
 *
 * @param {ImageData} imageData Grayscale image.
 * @param {number} sigma Blur radius in pixels; 0 returns the input unchanged.
 * @returns {ImageData} A new blurred image.
 */
export function blurGrayscale(imageData, sigma) {
  if (!sigma || sigma <= 0) return imageData;

  const { width, height } = imageData;

  const source = createCanvas(width, height);
  source.getContext("2d").putImageData(imageData, 0, 0);

  // The blur reaches three sigma out, so the padding has to cover that.
  const padding = Math.ceil(sigma * 3);

  const padded = createCanvas(width + padding * 2, height + padding * 2);
  const paddedContext = padded.getContext("2d");

  // Extend the edges outwards, so every edge pixel has real neighbours to
  // blur with instead of the transparent area around the canvas.
  paddedContext.drawImage(source, padding, padding);
  paddedContext.drawImage(source, 0, 0, width, 1, padding, 0, width, padding);
  paddedContext.drawImage(
    source,
    0,
    height - 1,
    width,
    1,
    padding,
    padding + height,
    width,
    padding,
  );
  paddedContext.drawImage(source, 0, 0, 1, height, 0, padding, padding, height);
  paddedContext.drawImage(
    source,
    width - 1,
    0,
    1,
    height,
    padding + width,
    padding,
    padding,
    height,
  );
  paddedContext.drawImage(source, 0, 0, 1, 1, 0, 0, padding, padding);
  paddedContext.drawImage(
    source,
    width - 1,
    0,
    1,
    1,
    padding + width,
    0,
    padding,
    padding,
  );
  paddedContext.drawImage(
    source,
    0,
    height - 1,
    1,
    1,
    0,
    padding + height,
    padding,
    padding,
  );
  paddedContext.drawImage(
    source,
    width - 1,
    height - 1,
    1,
    1,
    padding + width,
    padding + height,
    padding,
    padding,
  );

  const target = createCanvas(padded.width, padded.height);
  const targetContext = target.getContext("2d");
  targetContext.filter = `blur(${sigma}px)`;
  targetContext.drawImage(padded, 0, 0);
  targetContext.filter = "none";

  // Read back only the centre, which is the original image.
  return targetContext.getImageData(padding, padding, width, height);
}
