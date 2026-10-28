/**
 * Unit tests for the pure extension helpers.
 *
 * Run with:  node --test extension/tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyViewerAction,
  clampZoom,
  createViewerState,
  fitScale,
  formatZoomPercent,
  splitFractionForPointer,
  zoomAroundPoint,
} from "../lib/state.js";

import {
  computeCanvasSize,
  estimateSliceCount,
  planSlices,
} from "../lib/stitch.js";

import {
  analyzeImage,
  base64ToBlob,
  buildHeaders,
  extractServerMessage,
  messageForStatus,
} from "../lib/api.js";

import { exportFilename, formatDateStamp } from "../lib/export.js";

import { withDefaults, normaliseServerUrl, isLoopbackUrl } from "../lib/config.js";

import {
  MAX_STORED_ANALYSES,
  findUncloneableField,
  selectExpiredIds,
  sortByNewest,
  toMetadata,
} from "../lib/storage.js";

/* ------------------------------------------------------------------ */
/* state.js                                                            */
/* ------------------------------------------------------------------ */

test("clampZoom keeps the zoom inside 10% – 800%", () => {
  assert.equal(clampZoom(0.01), 0.1);
  assert.equal(clampZoom(100), 8);
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(Number.NaN), 1);
});

test("formatZoomPercent renders a percentage label", () => {
  assert.equal(formatZoomPercent(0.55), "55%");
  assert.equal(formatZoomPercent(1), "100%");
  assert.equal(formatZoomPercent(2.345), "235%");
});

test("zoomAroundPoint keeps the anchored content point stationary", () => {
  const start = { zoom: 1, panX: 0, panY: 0 };
  const params = {
    ...start,
    pointerX: 300,
    pointerY: 200,
    viewportX: 800,
    viewportY: 600,
    factor: 2,
  };

  const result = zoomAroundPoint(params);

  // The content point under the cursor before the zoom.
  const contentX = (params.pointerX - start.panX) / start.zoom;
  const contentY = (params.pointerY - start.panY) / start.zoom;

  // The same content point must sit under the cursor after the zoom.
  const afterX = params.pointerX - result.panX;
  const afterY = params.pointerY - result.panY;

  assert.ok(Math.abs(afterX / result.zoom - contentX) < 1e-9);
  assert.ok(Math.abs(afterY / result.zoom - contentY) < 1e-9);
});

test("zoomAroundPoint clamps the zoom factor", () => {
  const result = zoomAroundPoint({
    zoom: 7,
    panX: 0,
    panY: 0,
    pointerX: 100,
    pointerY: 100,
    viewportX: 500,
    viewportY: 500,
    factor: 4,
  });

  assert.equal(result.zoom, 8);
});

test("fitScale fits to width or to the screen", () => {
  const params = {
    contentWidth: 1000,
    contentHeight: 3000,
    viewportWidth: 500,
    viewportHeight: 500,
  };

  assert.equal(fitScale({ ...params, mode: "width" }), 0.5);
  assert.equal(fitScale({ ...params, mode: "screen" }), 1 / 6);
  assert.equal(fitScale({ ...params, mode: "actual" }), 1);
});

test("splitFractionForPointer clamps to 0..1", () => {
  const bounds = { left: 100, width: 400 };

  assert.equal(splitFractionForPointer(300, bounds), 0.5);
  assert.equal(splitFractionForPointer(0, bounds), 0);
  assert.equal(splitFractionForPointer(9999, bounds), 1);
});

test("createViewerState applies the defaults", () => {
  const state = createViewerState();

  assert.equal(state.mode, "blended");
  assert.equal(state.opacity, 0.55);
  assert.equal(state.colormap, "jet");
  assert.equal(state.zoom, 1);
});

test("applyViewerAction handles every documented action", () => {
  let state = createViewerState();

  state = applyViewerAction(state, { type: "SET_MODE", mode: "split" });
  assert.equal(state.mode, "split");

  state = applyViewerAction(state, { type: "SET_OPACITY", value: 0.8 });
  assert.equal(state.opacity, 0.8);

  state = applyViewerAction(state, { type: "ZOOM_IN" });
  assert.ok(state.zoom > 1);

  state = applyViewerAction(state, { type: "ZOOM_RESET" });
  assert.equal(state.zoom, 1);
  assert.equal(state.panX, 0);

  state = applyViewerAction(state, { type: "SET_COLORMAP", value: "viridis" });
  assert.equal(state.colormap, "viridis");

  state = applyViewerAction(state, { type: "SET_BLUR", value: 4 });
  assert.equal(state.blurSigma, 4);

  state = applyViewerAction(state, { type: "SET_THRESHOLD", value: 0.3 });
  assert.equal(state.threshold, 0.3);

  state = applyViewerAction(state, { type: "TOGGLE_TOP_N" });
  assert.equal(state.showTopN, true);

  state = applyViewerAction(state, { type: "SET_SPLIT_POSITION", value: 0.25 });
  assert.equal(state.splitPosition, 0.25);
});

test("applyViewerAction ignores unknown modes and actions", () => {
  const state = createViewerState();

  const afterMode = applyViewerAction(state, { type: "SET_MODE", mode: "nonsense" });
  assert.equal(afterMode.mode, "blended");

  const afterUnknown = applyViewerAction(state, { type: "NOT_A_REAL_ACTION" });
  assert.deepEqual(afterUnknown, state);
});

test("applyViewerAction clamps the opacity", () => {
  const state = createViewerState();

  assert.equal(applyViewerAction(state, { type: "SET_OPACITY", value: 5 }).opacity, 1);
  assert.equal(applyViewerAction(state, { type: "SET_OPACITY", value: -3 }).opacity, 0);
});

/* ------------------------------------------------------------------ */
/* stitch.js                                                           */
/* ------------------------------------------------------------------ */

test("planSlices covers the page exactly", () => {
  const plan = planSlices({
    scrollHeight: 2400,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });

  assert.equal(plan.slices.length, 3);
  assert.equal(plan.slices[0].scrollY, 0);
  assert.equal(plan.slices[1].scrollY, 800);
  assert.equal(plan.slices[2].scrollY, 1600);

  // The slices must add up to the page height without a gap.
  const covered = plan.slices.reduce((sum, slice) => sum + slice.heightCss, 0);
  assert.equal(covered, 2400);
  assert.equal(plan.truncated, false);
});

test("planSlices crops the final partial slice", () => {
  const plan = planSlices({
    scrollHeight: 2000,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 16000,
  });

  const last = plan.slices[plan.slices.length - 1];
  assert.equal(last.heightCss, 400);
  assert.equal(plan.slices.length, 3);
});

test("planSlices truncates pages beyond the maximum height", () => {
  const plan = planSlices({
    scrollHeight: 40000,
    viewportHeight: 800,
    devicePixelRatio: 1,
    maxHeight: 2000,
  });

  assert.equal(plan.truncated, true);
  assert.equal(plan.totalHeightCss, 2000);
  assert.equal(plan.slices.length, 3);
});

test("planSlices uses device pixels for the offsets", () => {
  const plan = planSlices({
    scrollHeight: 1600,
    viewportHeight: 800,
    devicePixelRatio: 2,
    maxHeight: 16000,
  });

  assert.equal(plan.slices[1].offsetY, 1600);
  assert.equal(plan.totalHeightDevice, 3200);
});

test("computeCanvasSize respects the maximum height", () => {
  const size = computeCanvasSize({
    width: 1440,
    height: 40000,
    devicePixelRatio: 2,
    maxHeight: 16000,
  });

  assert.equal(size.width, 2880);
  assert.equal(size.height, 32000);
});

test("estimateSliceCount rounds up", () => {
  assert.equal(estimateSliceCount(2400, 800), 3);
  assert.equal(estimateSliceCount(800, 800), 1);
  assert.equal(estimateSliceCount(801, 800), 2);
});

/* ------------------------------------------------------------------ */
/* api.js                                                              */
/* ------------------------------------------------------------------ */

test("buildHeaders only sends a token when one is configured", () => {
  assert.deepEqual(buildHeaders({ apiToken: "" }), {});
  assert.deepEqual(buildHeaders({ apiToken: "abc" }), { Authorization: "Bearer abc" });
});

test("messageForStatus maps the common failures", () => {
  assert.match(messageForStatus(401), /token/i);
  assert.match(messageForStatus(404), /server URL/i);
  assert.match(messageForStatus(413), /too large/i);
  assert.match(messageForStatus(503), /busy/i);
  assert.match(messageForStatus(500), /server hit an error/i);
});

test("extractServerMessage reads the different error shapes", () => {
  assert.equal(extractServerMessage({ error: { message: "a" } }), "a");
  assert.equal(extractServerMessage({ detail: { message: "b" } }), "b");
  assert.equal(extractServerMessage({ detail: "c" }), "c");
  assert.equal(extractServerMessage(null), null);
});

test("base64ToBlob decodes a PNG payload", () => {
  const blob = base64ToBlob("iVBORw0KGgo=");
  assert.equal(blob.type, "image/png");
  assert.ok(blob.size > 0);
});

/* ------------------------------------------------------------------ */
/* analyzeImage                                                        */
/* ------------------------------------------------------------------ */

test("analyzeImage posts the screenshot and returns the result", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ analysis_id: "abc", width: 10, height: 20 }),
    };
  };

  const result = await analyzeImage({
    settings: { serverUrl: "http://127.0.0.1:8001", requestTimeoutMs: 5000 },
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    options: { colormap: "jet", topN: 5 },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.analysis_id, "abc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8001/analyze");
  assert.equal(calls[0].init.method, "POST");
});

test("analyzeImage reports a missing server URL", async () => {
  const result = await analyzeImage({ settings: {}, blob: new Blob(), fetchImpl: async () => {
    throw new Error("should not be called");
  } });

  assert.equal(result.ok, false);
  assert.match(result.error, /No server URL/);
});

test("analyzeImage turns a timeout into a readable error", async () => {
  // A fetch that never settles, aborted by the request's own deadline.
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  const result = await analyzeImage({
    settings: { serverUrl: "http://127.0.0.1:8001", requestTimeoutMs: 20 },
    blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
});

test("analyzeImage reports a cancelled run as cancelled, not as a timeout", async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
      controller.abort();
    });

  const result = await analyzeImage({
    settings: { serverUrl: "http://127.0.0.1:8001", requestTimeoutMs: 60000 },
    blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
    signal: controller.signal,
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/);
});

/* ------------------------------------------------------------------ */
/* export.js                                                           */
/* ------------------------------------------------------------------ */

test("exportFilename follows the documented pattern", () => {
  const filename = exportFilename({
    hostname: "example.com",
    format: "png",
    date: new Date(2024, 4, 21, 14, 32),
  });

  assert.equal(filename, "attention-example.com-20240521-1432.png");
});

test("exportFilename uses the jpg extension for JPEG", () => {
  const filename = exportFilename({
    hostname: "example.com",
    format: "jpeg",
    date: new Date(2024, 4, 21, 14, 32),
  });

  assert.ok(filename.endsWith(".jpg"));
});

test("formatDateStamp pads the values", () => {
  assert.equal(formatDateStamp(new Date(2024, 0, 2, 3, 4)), "20240102-0304");
});

/* ------------------------------------------------------------------ */
/* config.js                                                           */
/* ------------------------------------------------------------------ */

test("withDefaults fills in the missing values", () => {
  const settings = withDefaults({ serverUrl: "http://127.0.0.1:8001" });

  assert.equal(settings.serverUrl, "http://127.0.0.1:8001");
  assert.equal(settings.defaultMode, "blended");
  assert.equal(settings.defaultOpacity, 0.55);
});

test("withDefaults rejects an invalid view mode", () => {
  assert.equal(withDefaults({ defaultMode: "bogus" }).defaultMode, "blended");
});

test("normaliseServerUrl strips the trailing slash and adds a scheme", () => {
  assert.equal(normaliseServerUrl("localhost:8001/"), "https://localhost:8001");
  assert.equal(normaliseServerUrl("http://127.0.0.1:8001/"), "http://127.0.0.1:8001");
  assert.equal(normaliseServerUrl(""), "");
});

test("isLoopbackUrl detects the local hosts", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8001"), true);
  assert.equal(isLoopbackUrl("http://localhost:8001"), true);
  assert.equal(isLoopbackUrl("https://example.com"), false);
});

/* ------------------------------------------------------------------ */
/* storage.js                                                          */
/* ------------------------------------------------------------------ */

test("sortByNewest puts the most recent analysis first", () => {
  const sorted = sortByNewest([
    { id: "old", capturedAt: 1000 },
    { id: "newest", capturedAt: 3000 },
    { id: "middle", capturedAt: 2000 },
  ]);

  assert.deepEqual(
    sorted.map((record) => record.id),
    ["newest", "middle", "old"],
  );
});

test("sortByNewest treats a record without a timestamp as the oldest", () => {
  const sorted = sortByNewest([
    { id: "undated" },
    { id: "dated", capturedAt: 1000 },
  ]);

  assert.deepEqual(
    sorted.map((record) => record.id),
    ["dated", "undated"],
  );
});

test("selectExpiredIds keeps the newest analyses and drops the oldest", () => {
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `analysis-${index}`,
    capturedAt: index,
  }));

  const expired = selectExpiredIds(records, { keep: 3 });

  // The three newest are kept, so analysis-0 to analysis-4 go.
  assert.deepEqual(expired, ["analysis-4", "analysis-3", "analysis-2", "analysis-1", "analysis-0"]);
});

test("selectExpiredIds drops nothing when there is room", () => {
  const records = [
    { id: "a", capturedAt: 1 },
    { id: "b", capturedAt: 2 },
  ];

  assert.deepEqual(selectExpiredIds(records, { keep: 5 }), []);
});

test("selectExpiredIds never removes the analysis that is on screen", () => {
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `analysis-${index}`,
    capturedAt: index,
  }));

  // analysis-0 is the oldest, so it would be dropped first.
  const expired = selectExpiredIds(records, { keep: 3, protectId: "analysis-0" });

  assert.ok(!expired.includes("analysis-0"));
  assert.deepEqual(expired, ["analysis-4", "analysis-3", "analysis-2", "analysis-1"]);
});

test("selectExpiredIds uses the default limit", () => {
  const records = Array.from({ length: MAX_STORED_ANALYSES + 3 }, (_, index) => ({
    id: `analysis-${index}`,
    capturedAt: index,
  }));

  assert.equal(selectExpiredIds(records).length, 3);
});

test("toMetadata leaves the images out of the settings record", () => {  const metadata = toMetadata({
    analysisId: "abc",
    hostname: "example.com",
    imageDataUrl: "data:image/png;base64,AAAA",
    saliencyDataUrl: "data:image/png;base64,BBBB",
    width: 1280,
    height: 2400,
    topPoints: [{ x: 10, y: 20 }],
    stats: { above_fold_pct: 42 },
    timingMs: { total_ms: 1200 },
    warnings: [],
    capturedAt: 1700000000000,
  });

  assert.equal(metadata.analysisId, "abc");
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.imageDataUrl, undefined);
  assert.equal(metadata.saliencyDataUrl, undefined);
  assert.equal(JSON.stringify(metadata).includes("base64"), false);
});

test("findUncloneableField accepts a normal record", () => {
  const record = {
    id: "abc",
    hostname: "example.com",
    width: 1280,
    height: 2400,
    topPoints: [],
    stats: { above_fold_pct: 42 },
    capturedAt: 1700000000000,
    imageBlob: null,
    saliencyBlob: null,
  };

  assert.equal(findUncloneableField(record), null);
});

test("findUncloneableField names the field that cannot be stored", () => {
  // An un-awaited promise cannot be copied into the database, which is what
  // happened when the hostname was passed to the store without awaiting it.
  const record = { id: "abc", hostname: Promise.resolve("example.com") };

  assert.equal(findUncloneableField(record), "hostname");
});

/* ------------------------------------------------------------------ */
/* stylesheets                                                         */
/* ------------------------------------------------------------------ */

/** The directory of the extension. */
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every stylesheet makes the hidden attribute win", () => {
  // The `hidden` attribute is only a user-agent rule, so an author rule that
  // sets `display` beats it. `.placeholder { display: flex }` did exactly
  // that and left the "Preparing the heatmap…" overlay on top of the canvas
  // for good, so every stylesheet has to state the rule itself.
  for (const name of ["viewer/viewer.css", "popup/popup.css", "options/options.css"]) {
    const css = readFileSync(join(extensionDir, name), "utf8");

    assert.match(
      css,
      /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
      `${name} must hide elements that carry the hidden attribute`,
    );
  }
});

test("the viewer placeholder rule is the reason the hidden guard is needed", () => {
  const css = readFileSync(join(extensionDir, "viewer/viewer.css"), "utf8");

  // The placeholder sets `display`, which would beat the user-agent rule for
  // the `hidden` attribute. The guard has to use `!important` to win, and
  // that is what the first test checks.
  const placeholderRule = /\.placeholder\s*\{[^}]*\}/.exec(css);
  assert.ok(placeholderRule, "the placeholder rule is missing");
  assert.match(
    placeholderRule[0],
    /display:\s*flex/,
    "the placeholder rule is expected to set display, which is what broke the hidden attribute",
  );
});
