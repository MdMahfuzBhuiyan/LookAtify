/**
 * Check the stitching geometry for gaps and overlaps.
 *
 * The background worker pastes each captured slice onto the canvas at an
 * offset derived from the slice's scroll position. Two things have to line
 * up for the result to be seamless:
 *
 *   1. the offset must be the slice's position in the *captured* page, not
 *      its position in the full page — otherwise a truncated page has its
 *      slices pulled apart;
 *   2. consecutive slices must meet exactly, with no gap between them.
 *
 * This script measures both on the geometry the worker actually uses.
 *
 * Usage:
 *   node scripts/check-stitch-geometry.mjs
 */

import { computeCanvasSize, planSlices } from "../extension/lib/stitch.js";

/** The worker's offset calculation, copied verbatim. */
function workerOffset(slice, capturedHeight, canvasHeight) {
  return Math.min(
    canvasHeight - 1,
    Math.round((slice.scrollY / Math.max(1, capturedHeight)) * canvasHeight),
  );
}

function report(label, { scrollHeight, viewportHeight, devicePixelRatio, maxHeight }) {
  const plan = planSlices({
    scrollHeight,
    viewportHeight,
    devicePixelRatio,
    maxHeight,
  });

  const canvas = computeCanvasSize({
    width: 1280,
    height: plan.totalHeightCss,
    devicePixelRatio,
    maxHeight,
  });

  console.log(`\n${label}`);
  console.log(
    `  page ${scrollHeight}px, viewport ${viewportHeight}px, dpr ${devicePixelRatio}, ` +
      `max ${maxHeight}px`,
  );
  console.log(
    `  truncated=${plan.truncated}  slices=${plan.slices.length}  ` +
      `canvas=${canvas.width}x${canvas.height}`,
  );

  const capturedHeight = plan.totalHeightCss;

  let gaps = 0;
  let overlaps = 0;
  let previousEnd = null;

  for (const slice of plan.slices) {
    const offset = workerOffset(slice, capturedHeight, canvas.height);
    const drawn = Math.min(
      Math.round(viewportHeight * devicePixelRatio),
      canvas.height - offset,
    );
    const end = offset + drawn;

    if (previousEnd !== null) {
      if (offset > previousEnd) {
        gaps += 1;
        console.log(
          `  GAP   before slice ${slice.index}: ${previousEnd}..${offset} ` +
            `(${offset - previousEnd}px empty)`,
        );
      } else if (offset < previousEnd) {
        overlaps += 1;
      }
    }
    previousEnd = end;
  }

  console.log(`  gaps=${gaps}  overlaps=${overlaps}`);

  // The tail of the canvas: how much of it did no slice reach?
  const covered = plan.slices.reduce((total, slice) => {
    const offset = workerOffset(slice, capturedHeight, canvas.height);
    const drawn = Math.min(
      Math.round(viewportHeight * devicePixelRatio),
      canvas.height - offset,
    );
    return Math.max(total, offset + drawn);
  }, 0);
  console.log(`  last slice reaches row ${covered} of ${canvas.height}`);

  if (covered < canvas.height) {
    console.log(`  UNCOVERED TAIL: ${canvas.height - covered}px of blank canvas`);
  }
}

// A normal page.
report("a page that fits", {
  scrollHeight: 2400,
  viewportHeight: 800,
  devicePixelRatio: 1,
  maxHeight: 16000,
});

// A long page.
report("a long page", {
  scrollHeight: 13933,
  viewportHeight: 800,
  devicePixelRatio: 1,
  maxHeight: 16000,
});

// A page taller than the capture limit: the interesting case.
report("a page taller than the limit", {
  scrollHeight: 22000,
  viewportHeight: 800,
  devicePixelRatio: 1,
  maxHeight: 16000,
});

// The same, with a device pixel ratio of 2.
report("a tall page at dpr 2", {
  scrollHeight: 22000,
  viewportHeight: 800,
  devicePixelRatio: 2,
  maxHeight: 16000,
});
