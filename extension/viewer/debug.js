/**
 * LookAtify capture debug — shows the raw frames of a capture.
 *
 * The debug mode exists to make a bad stitch visible: the raw frames show
 * exactly what the browser returned, and the report shows where each of them
 * was pasted, so a gap, a duplicate or a clipped heading is easy to spot.
 *
 * The frames are read from the extension's own storage, because they are far
 * too big for an address.
 */

const debugId = new URLSearchParams(location.search).get("id");

const container = document.getElementById("frames");
const summary = document.getElementById("summary");

/**
 * Render the report as a table.
 *
 * @param {Object} data The slice report.
 * @returns {void}
 */
function renderReport(data) {
  const rows = (data.slices || [])
    .map(
      (slice) =>
        `<tr>
          <td>${slice.index}</td>
          <td>${slice.scrollY ?? ""}</td>
          <td>${slice.offsetY ?? ""}</td>
          <td>${slice.drawHeight ?? ""}</td>
        </tr>`,
    )
    .join("");

  summary.innerHTML = `
    <dl>
      <dt>Page height</dt><dd>${data.pageHeight ?? "?"} px</dd>
      <dt>Captured height</dt><dd>${data.capturedHeight ?? "?"} px</dd>
      <dt>Viewport height</dt><dd>${data.viewportHeight ?? "?"} px</dd>
      <dt>Device pixel ratio</dt><dd>${data.devicePixelRatio ?? "?"}</dd>
      <dt>Slices</dt><dd>${(data.slices || []).length}</dd>
      <dt>Truncated</dt><dd>${data.truncated ? "yes" : "no"}</dd>
    </dl>
    ${
      (data.warnings || []).length
        ? `<ul class="warnings">${data.warnings
            .map((warning) => `<li>${warning}</li>`)
            .join("")}</ul>`
        : ""
    }
    <table>
      <thead>
        <tr><th>Slice</th><th>scrollY</th><th>offsetY</th><th>Height</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Show the frames.
 *
 * @param {string[]} frames The captured frames, as data URLs.
 * @returns {void}
 */
function renderFrames(frames) {
  if (!frames || frames.length === 0) {
    container.innerHTML = '<p class="empty">The capture returned no frames.</p>';
    return;
  }

  container.innerHTML = frames
    .map(
      (dataUrl, index) =>
        `<section class="frame">
          <h2>Frame ${index}</h2>
          <img src="${dataUrl}" alt="Captured frame ${index}" />
        </section>`,
    )
    .join("");
}

async function load() {
  if (!debugId) {
    container.innerHTML = '<p class="empty">No capture was selected.</p>';
    return;
  }

  const stored = await chrome.storage.local.get("lookatify_debug_capture");
  const debug = stored.lookatify_debug_capture;

  if (!debug || debug.id !== debugId) {
    container.innerHTML =
      '<p class="empty">The frames of this capture are no longer stored. Run the capture again.</p>';
    return;
  }

  renderReport(debug.report);
  renderFrames(debug.frames);
}

load().catch((error) => {
  container.innerHTML = `<p class="empty">The frames could not be read: ${error.message}</p>`;
});
