/**
 * Export helpers for the LookAtify viewer.
 */

/**
 * Build the export filename.
 *
 * @param {{hostname: string, format: string, date: Date}} options
 * @returns {string} e.g. `attention-example.com-20240521-1432.png`
 */
export function exportFilename({ hostname, format, date }) {
  const safeHost = String(hostname || "page").replace(/[^a-zA-Z0-9.-]/g, "_");
  const stamp = formatDateStamp(date);
  const extension = format === "jpeg" ? "jpg" : format;
  return `attention-${safeHost}-${stamp}.${extension}`;
}

/**
 * Format a date as `YYYYMMDD-HHmm`.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatDateStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * Render a canvas to a blob.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} format `png` or `jpeg`
 * @param {number} quality JPEG quality between 0 and 1.
 * @returns {Promise<Blob>}
 */
export function canvasToBlob(canvas, format, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The image could not be encoded."));
      },
      mimeType,
      format === "jpeg" ? quality : undefined,
    );
  });
}

/**
 * Download a canvas as an image file.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} filename
 * @param {string} format `png` or `jpeg`
 * @returns {Promise<void>}
 */
export async function exportImage(canvas, filename, format) {
  const blob = await canvasToBlob(canvas, format);
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
