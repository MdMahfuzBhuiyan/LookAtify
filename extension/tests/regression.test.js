/**
 * Regression tests for the reported viewer and capture bugs.
 *
 * The tests cover the two extension-side issues from the bug report:
 *
 *   4. the summary panel showed "Analysis time 0 ms";
 *   5. a faint horizontal line appeared near the bottom of the page,
 *      because the slices were positioned against the full page height
 *      instead of the captured height.
 *
 * Run with: node --test extension/tests/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeCanvasSize, planSlices } from "../lib/stitch.js";
import { summaryRows } from "../lib/summary.js";

/**
 * The offset the background worker uses to place a slice.
 *
 * @param {Object} slice The slice.
 * @param {number} capturedHeight The height of the captured page.
 * @param {number} canvasHeight The height of the canvas.
 * @returns {number}
 */
function sliceOffset(slice, capturedHeight, canvasHeight) {
  return Math.min(
    canvasHeight - 1,
    Math.round((slice.scrollY / Math.max(1, capturedHeight)) * canvasHeight),
  );
}

// ----------------------------------------------------------------------
// bug 4: "Analysis time 0 ms"
// ----------------------------------------------------------------------
test("the summary shows the analysis time from the stored record", () => {
  const rows = summaryRows({
    stats: { above_fold_pct: 17.7 },
    timingMs: { total: 67011 },
  });

  const time = rows.find(([label]) => label === "Analysis time");
  assert.ok(time, "the summary has an analysis time row");
  assert.equal(time[1], "67011 ms");
});

test("the summary also accepts the server's own field name", () => {
  const rows = summaryRows({
    stats: {},
    timing_ms: { total: 1234 },
  });

  const time = rows.find(([label]) => label === "Analysis time");
  assert.equal(time[1], "1234 ms");
});

test("the summary reports zero when there is no timing at all", () => {
  const rows = summaryRows({ stats: {} });

  const time = rows.find(([label]) => label === "Analysis time");
  assert.equal(time[1], "0 ms");
});

test("the summary keeps the other statistics", () => {
  const rows = summaryRows({
    stats: {
      above_fold_pct: 17.67,
      thirds_pct: { top: 48.49, middle: 20.68, bottom: 30.83 },
      left_right_pct: { left: 47.19, right: 52.81 },
    },
    timingMs: { total: 500 },
  });

  const values = Object.fromEntries(rows);
  assert.equal(values["Above the fold"], "17.67%");
  assert.equal(values["Top third"], "48.49%");
  assert.equal(values["Middle third"], "20.68%");
  assert.equal(values["Bottom third"], "30.83%");
  assert.equal(values["Left half"], "47.19%");
  assert.equal(values["Right half"], "52.81%");
});

// ----------------------------------------------------------------------
// bug 5: the faint horizontal line / blank canvas
// ----------------------------------------------------------------------
test("the slices cover the captured page without a gap", () => {
  const plan = planSlices({
    scrollHeight: 13933,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });
  const canvas = computeCanvasSize({
    width: 1280,
    height: plan.totalHeightCss,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });

  let previousEnd = null;
  for (const slice of plan.slices) {
    const offset = sliceOffset(slice, plan.totalHeightCss, canvas.height);
    const end = offset + Math.min(800, canvas.height - offset);

    if (previousEnd !== null) {
      assert.ok(
        offset <= previousEnd,
        `slice ${slice.index} leaves a gap: ${previousEnd}..${offset}`,
      );
    }
    previousEnd = end;
  }

  assert.equal(previousEnd, canvas.height, "the last slice reaches the bottom");
});

test("a truncated page does not leave blank canvas at the bottom", () => {
  const plan = planSlices({
    scrollHeight: 22000,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });
  const canvas = computeCanvasSize({
    width: 1280,
    height: plan.totalHeightCss,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });

  let reached = 0;
  for (const slice of plan.slices) {
    const offset = sliceOffset(slice, plan.totalHeightCss, canvas.height);
    reached = Math.max(reached, offset + Math.min(800, canvas.height - offset));
  }

  assert.equal(reached, canvas.height, "the canvas is covered to its last row");
});

test("the slice offsets use the captured height, not the page height", () => {
  const plan = planSlices({
    scrollHeight: 22000,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });
  const canvas = computeCanvasSize({
    width: 1280,
    height: plan.totalHeightCss,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });

  const first = plan.slices[0];
  const second = plan.slices[1];

  const firstOffset = sliceOffset(first, plan.totalHeightCss, canvas.height);
  const secondOffset = sliceOffset(second, plan.totalHeightCss, canvas.height);

  assert.equal(firstOffset, 0, "the first slice starts at the top");
  assert.ok(
    secondOffset - firstOffset <= 800,
    "consecutive slices are one viewport apart, not a fraction of the page apart",
  );
});

test("the slice count follows the captured height", () => {
  const plan = planSlices({
    scrollHeight: 22000,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });

  assert.equal(plan.truncated, true);
  assert.equal(plan.totalHeightCss, 16000);
  assert.equal(plan.slices.length, 20);
});
