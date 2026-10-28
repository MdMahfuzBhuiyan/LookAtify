/**
 * Regression tests for the reported capture bugs.
 *
 * The tests cover the capture-side issues from the bug report:
 *
 *   1. visible horizontal seams in the stitched screenshot;
 *   2. content duplicated or cut off at the slice boundaries;
 *   3. sticky and fixed elements repeating across the slices;
 *   4. animated content changing between the slices;
 *   5. a false hotspot caused by a fixed widget.
 *
 * The geometry is checked without a browser, because the faults were in the
 * offset arithmetic. The page preparation is checked by reading the style
 * the capture installs.
 *
 * Run with: node --test extension/tests/
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_STYLE_ID,
  HIDDEN_ATTRIBUTE,
  capturedHeightFor,
  captureStyleText,
  computeCanvasSize,
  planSlices,
  sliceLayout,
} from "../lib/stitch.js";

/**
 * Build the slice list a capture would produce for a page.
 *
 * @param {number} scrollHeight
 * @param {number} viewportHeight
 * @param {number} devicePixelRatio
 * @param {number} maxHeight
 * @returns {Object}
 */
function planFor(scrollHeight, viewportHeight, devicePixelRatio = 1, maxHeight = 16000) {
  const plan = planSlices({ scrollHeight, viewportHeight, devicePixelRatio, maxHeight });
  const canvas = computeCanvasSize({
    width: 1280,
    height: plan.totalHeightCss,
    devicePixelRatio,
    maxHeight,
  });
  return { plan, canvas };
}

// ----------------------------------------------------------------------
// bug 1: visible horizontal seams
// ----------------------------------------------------------------------

test("consecutive slices meet exactly, with no gap and no overlap", () => {
  const { plan, canvas } = planFor(13933, 800, 1);
  const layout = sliceLayout(plan.slices, {
    canvasHeight: canvas.height,
    devicePixelRatio: 1,
  });

  for (let index = 1; index < layout.length; index += 1) {
    const previous = layout[index - 1];
    const current = layout[index];

    assert.equal(
      previous.offsetY + previous.drawHeight,
      current.offsetY,
      `slice ${index} starts exactly where slice ${index - 1} ends`,
    );
  }
});

test("the last slice reaches the bottom of the canvas", () => {
  const { plan, canvas } = planFor(13933, 800, 1);
  const layout = sliceLayout(plan.slices, {
    canvasHeight: canvas.height,
    devicePixelRatio: 1,
  });

  const last = layout[layout.length - 1];
  assert.equal(last.offsetY + last.drawHeight, canvas.height);
});

test("the slices meet exactly at a device pixel ratio of two", () => {
  const { plan, canvas } = planFor(13933, 800, 2);
  const layout = sliceLayout(plan.slices, {
    canvasHeight: canvas.height,
    devicePixelRatio: 2,
  });

  for (let index = 1; index < layout.length; index += 1) {
    const previous = layout[index - 1];
    const current = layout[index];
    assert.equal(previous.offsetY + previous.drawHeight, current.offsetY);
  }
});

test("a slice is never drawn past the end of the canvas", () => {
  const { plan, canvas } = planFor(13933, 800, 1);
  const layout = sliceLayout(plan.slices, {
    canvasHeight: canvas.height,
    devicePixelRatio: 1,
  });

  for (const placement of layout) {
    assert.ok(placement.offsetY + placement.drawHeight <= canvas.height);
  }
});

test("an overlapping slice is cut, not drawn twice", () => {
  // The page scrolled less than a viewport, so the second slice starts
  // before the first one ends.
  const slices = [
    { index: 0, scrollY: 0 },
    { index: 1, scrollY: 400 },
  ];

  const layout = sliceLayout(slices, { canvasHeight: 1200, devicePixelRatio: 1 });

  assert.equal(layout[0].offsetY, 0);
  assert.equal(layout[0].drawHeight, 400, "the first slice stops where the second begins");
  assert.equal(layout[1].offsetY, 400);
  assert.ok(layout[1].drawHeight >= 1, "the second slice still draws something");
});

test("every slice draws at least one row", () => {
  // The page did not move at all.
  const slices = [
    { index: 0, scrollY: 0 },
    { index: 1, scrollY: 0 },
  ];

  const layout = sliceLayout(slices, { canvasHeight: 800, devicePixelRatio: 1 });

  for (const placement of layout) {
    assert.ok(placement.drawHeight >= 1, "a slice is never empty");
  }
});

// ----------------------------------------------------------------------
// bug 2: content duplicated or cut off at the slice boundaries
// ----------------------------------------------------------------------

test("the slices are placed at the position the page really scrolled to", () => {
  // The page stopped short of the requested position, because it was
  // shorter than the capture expected.
  const slices = [
    { index: 0, scrollY: 0 },
    { index: 1, scrollY: 800 },
    { index: 2, scrollY: 1500 },
  ];

  const layout = sliceLayout(slices, { canvasHeight: 2300, devicePixelRatio: 1 });

  // The third slice starts where the page really was, not where the capture
  // asked it to go.
  assert.equal(layout[2].offsetY, 1500);
  // The second slice is cut so that it ends where the third one begins.
  assert.equal(layout[1].offsetY + layout[1].drawHeight, 1500);
});

test("the canvas is only as tall as the content that was captured", () => {
  // The page is 5000px tall, but the capture stopped at 2000px.
  const height = capturedHeightFor({
    lastScrollY: 1200,
    viewportHeight: 800,
    pageHeight: 5000,
    maxHeight: 16000,
  });

  assert.equal(height, 2000, "the canvas stops where the capture stopped");
});

test("the canvas never grows past the end of the page", () => {
  const height = capturedHeightFor({
    lastScrollY: 800,
    viewportHeight: 800,
    pageHeight: 1000,
    maxHeight: 16000,
  });

  assert.equal(height, 1000, "the canvas does not extend past the page");
});

test("the canvas is limited by the capture height", () => {
  // The capture ran past the limit, so the canvas is cut at the limit.
  const height = capturedHeightFor({
    lastScrollY: 20000,
    viewportHeight: 800,
    pageHeight: 40000,
    maxHeight: 16000,
  });

  assert.equal(height, 16000);
});

test("the canvas stops where the capture stopped, even below the limit", () => {
  // The capture ended early, so the canvas is not extended to the limit.
  const height = capturedHeightFor({
    lastScrollY: 12000,
    viewportHeight: 800,
    pageHeight: 40000,
    maxHeight: 16000,
  });

  assert.equal(height, 12800);
});

test("a truncated page is stitched without a blank band at the bottom", () => {
  const { plan, canvas } = planFor(22000, 800, 1, 16000);
  const layout = sliceLayout(plan.slices, {
    canvasHeight: canvas.height,
    devicePixelRatio: 1,
  });

  const last = layout[layout.length - 1];
  assert.equal(last.offsetY + last.drawHeight, canvas.height);
  assert.equal(canvas.height, 16000);
});

// ----------------------------------------------------------------------
// bugs 3 and 5: repeating overlays and the false hotspot
// ----------------------------------------------------------------------

test("the capture style hides the marked elements and their descendants", () => {
  const style = captureStyleText();

  assert.ok(
    style.includes(`[${HIDDEN_ATTRIBUTE}]`),
    "the marked elements are hidden",
  );
  assert.ok(
    style.includes(`[${HIDDEN_ATTRIBUTE}] *`),
    "the children of a marked element are hidden too",
  );
  assert.ok(style.includes("visibility: hidden"), "they are really hidden");
});

test("the capture style stops the animations and the transitions", () => {
  const style = captureStyleText();

  assert.ok(style.includes("animation: none"), "the animations are stopped");
  assert.ok(style.includes("transition: none"), "the transitions are stopped");
  assert.ok(
    style.includes("scroll-behavior: auto"),
    "the page jumps to the position instead of gliding to it",
  );
});

test("the capture style has a stable id, so it can be removed again", () => {
  assert.equal(CAPTURE_STYLE_ID, "lookatify-capture-style");
});

// ----------------------------------------------------------------------
// bug 4: the content that moves between slices
// ----------------------------------------------------------------------

test("the plan covers the whole page when the page is not a multiple of the viewport", () => {
  const plan = planSlices({
    scrollHeight: 2000,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });

  const covered = plan.slices.reduce((sum, slice) => sum + slice.heightCss, 0);
  assert.equal(covered, 2000, "the slices add up to the page height");
  assert.equal(plan.slices[plan.slices.length - 1].heightCss, 400);
});

test("the plan never goes past the capture limit", () => {
  const plan = planSlices({
    scrollHeight: 40000,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 2000,
  });

  const covered = plan.slices.reduce((sum, slice) => sum + slice.heightCss, 0);
  assert.equal(covered, 2000);
  assert.equal(plan.truncated, true);
});
