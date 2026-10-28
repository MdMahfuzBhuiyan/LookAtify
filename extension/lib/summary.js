/**
 * The attention summary panel's contents.
 *
 * The function is pure so the values the panel shows can be unit tested
 * without a DOM.
 */

/**
 * Build the rows of the attention summary panel.
 *
 * @param {Object} analysis The stored analysis.
 * @returns {Array<[string, string]>} Label and value pairs.
 */
export function summaryRows(analysis) {
  const stats = (analysis && analysis.stats) || {};
  const thirds = stats.thirds_pct || {};
  const halves = stats.left_right_pct || {};

  // The server sends `timing_ms`, the storage layer renames it to
  // `timingMs`. Both are accepted, so the panel never shows "0 ms" for an
  // analysis that took real time.
  const timing = analysis.timingMs || analysis.timing_ms || {};
  const total = timing.total ?? 0;

  return [
    ["Above the fold", `${stats.above_fold_pct ?? 0}%`],
    ["Top third", `${thirds.top ?? 0}%`],
    ["Middle third", `${thirds.middle ?? 0}%`],
    ["Bottom third", `${thirds.bottom ?? 0}%`],
    ["Left half", `${halves.left ?? 0}%`],
    ["Right half", `${halves.right ?? 0}%`],
    ["Analysis time", `${total} ms`],
  ];
}
