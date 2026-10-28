/**
 * LookAtify service worker.
 *
 * Orchestrates the whole flow: capture the page, stitch the slices, upload
 * the screenshot to the backend, store the result and open the viewer.
 */

import { analyzeImage, checkHealth } from "../lib/api.js";
import {
  CAPTURE_PORT,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  normaliseServerUrl,
  withDefaults,
} from "../lib/config.js";
import {
  MAX_STORED_ANALYSES,
  migrateLegacyAnalyses,
  pruneAnalyses,
  readAllAnalyses,
  syncMetadata,
  writeAnalysis,
} from "../lib/storage.js";
import { computeCanvasSize, sliceLayout } from "../lib/stitch.js";

/** The tab that is currently being analysed. */
let activeTabId = null;

/** The storage key that holds the frames of the last debug capture. */
const DEBUG_STORAGE_KEY = "lookatify_debug_capture";
/** Abort controller for an in-flight analysis. */
let activeController = null;
/** Last capture timestamp, used to respect the browser rate limit. */
let lastCaptureAt = 0;
/**
 * Keeps the service worker alive while an analysis is running.
 *
 * Chrome suspends an idle service worker after about thirty seconds. A long
 * analysis waits on the network without sending any events, so the worker can
 * be killed mid-request and the popup never hears back. The interval below
 * resets that idle timer.
 */
let keepAliveTimer = null;

/**
 * Read the stored settings.
 *
 * @returns {Promise<Object>}
 */
async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return withDefaults(stored[STORAGE_KEYS.settings]);
}

/**
 * Wait until the browser allows another visible-tab capture.
 *
 * @returns {Promise<void>}
 */
async function respectCaptureRate() {
  const elapsed = Date.now() - lastCaptureAt;
  if (elapsed < 500) {
    await new Promise((resolve) => setTimeout(resolve, 500 - elapsed));
  }
}

/**
 * Capture the visible tab.
 *
 * @param {number} tabId
 * @returns {Promise<string>} A PNG data URL.
 */
async function captureVisibleTab(tabId) {
  await respectCaptureRate();
  lastCaptureAt = Date.now();

  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
    format: "png",
  });

  if (!dataUrl) {
    throw new Error("The browser returned an empty screenshot.");
  }
  return dataUrl;
}

/**
 * Make sure the content script is present in the tab.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "LOOKATIFY_PING" });
    if (response && response.ok) return;
  } catch {
    // The content script is not there yet — inject it below.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    // The path has to be absolute. Firefox resolves a relative path against
    // the page that is running the script, so "content/capture.js" would be
    // looked up inside the extension's own pages folder.
    files: ["/content/capture.js"],
  });
}

/**
 * Load an image from a data URL.
 *
 * @param {string} dataUrl
 * @returns {Promise<ImageBitmap>}
 */
async function loadImage(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Open the debug page for a capture.
 *
 * The frames are far too big for an address: a long page produces tens of
 * megabytes of PNG. They are therefore written to the extension's own
 * storage, and the page reads them from there.
 *
 * @param {Object} capture The capture result from the content script.
 * @param {Object} layout The placements the slices were drawn at.
 * @returns {Promise<void>}
 */
async function openDebugPage(capture, layout) {
  const report = {
    pageHeight: capture.pageHeight,
    capturedHeight: capture.height,
    viewportHeight: capture.viewportHeight,
    devicePixelRatio: capture.devicePixelRatio,
    viewportOnly: capture.viewportOnly,
    truncated: capture.truncated,
    warnings: capture.warnings,
    slices: capture.slices.map((slice) => {
      const placement = layout.find((entry) => entry.index === slice.index);
      return {
        index: slice.index,
        scrollY: slice.scrollY,
        offsetY: placement ? placement.offsetY : null,
        drawHeight: placement ? placement.drawHeight : null,
      };
    }),
  };

  // The frames are kept as data URLs, because the settings area stores
  // plain values rather than binary data.
  const frames = capture.slices.map((slice) => slice.dataUrl);

  const debugId = `debug-${Date.now()}`;
  await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: { id: debugId, report, frames } });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`viewer/debug.html?id=${debugId}`),
  });
}

/**
 * Stitch the captured slices into one tall image.
 *
 * Each slice is placed at the position the page was really scrolled to, and
 * every slice is cut so that it meets the next one exactly. A slice that is
 * one pixel too long would show up as a faint horizontal line across the
 * whole page.
 *
 * @param {Object} capture The capture result from the content script.
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
async function stitchSlices(capture) {
  const { width, height, devicePixelRatio, slices } = capture;

  const size = computeCanvasSize({
    width,
    height,
    devicePixelRatio,
    maxHeight: 16000,
  });

  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext("2d");

  // The layout is derived from the real scroll positions of the slices, so
  // the geometry follows the page even when it did not scroll exactly as
  // it was asked to.
  const layout = sliceLayout(slices, {
    canvasHeight: size.height,
    devicePixelRatio,
  });

  for (const placement of layout) {
    const slice = slices[placement.index];
    if (!slice) continue;

    const bitmap = await loadImage(slice.dataUrl);

    // The frame is a full viewport. It is cut at the bottom so that it ends
    // where the next slice starts.
    const available = Math.max(1, Math.min(placement.drawHeight, bitmap.height));

    context.drawImage(
      bitmap,
      placement.sourceTop,
      0,
      bitmap.width,
      available,
      0,
      placement.offsetY,
      bitmap.width,
      available,
    );
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });

  // In debug mode the raw frames are shown in a page of their own, so a
  // bad stitch can be looked at piece by piece.
  if (capture.debug) {
    try {
      await openDebugPage(capture, layout);
    } catch (error) {
      console.warn("LookAtify: the debug page could not be opened.", error);
    }
  }

  return { blob, width: size.width, height: size.height };
}

/**
 * Store an analysis so the viewer can open it.
 *
 * The images go into IndexedDB as blobs. They used to be written into
 * `chrome.storage.local` as base64 data URLs, which filled the 10 MB quota
 * after a few runs and made every later analysis fail with
 * "Resource::kQuotaBytes quota exceeded". Only the small metadata record is
 * kept in the settings area.
 *
 * @param {Object} payload
 * @param {Blob} payload.imageBlob The stitched screenshot.
 * @param {Blob} payload.saliencyBlob The saliency map.
 * @returns {Promise<string>} The analysis id.
 */
async function storeAnalysis(payload) {
  const analysisId = await writeAnalysis({
    analysisId: payload.analysisId,
    hostname: payload.hostname,
    imageBlob: payload.imageBlob,
    saliencyBlob: payload.saliencyBlob,
    width: payload.width,
    height: payload.height,
    topPoints: payload.topPoints,
    stats: payload.stats,
    timingMs: payload.timingMs,
    warnings: payload.warnings,
    capturedAt: payload.capturedAt,
  });

  // Drop the oldest analyses so the disk usage stays bounded.
  const removed = await pruneAnalyses({
    keep: MAX_STORED_ANALYSES,
    protectId: analysisId,
  });
  if (removed.length > 0) {
    console.info(`[lookatify] removed ${removed.length} old analysis record(s)`);
  }

  // Keep the metadata list in step with the database.
  await syncMetadata(await readAllAnalyses());

  await chrome.storage.local.set({ [STORAGE_KEYS.lastAnalysis]: analysisId });
  return analysisId;
}

/**
 * Keep the service worker alive while an analysis is running.
 *
 * Chrome suspends an idle service worker after about thirty seconds, and a
 * long analysis waits on the network without sending any events. This
 * interval resets the idle timer so the worker survives the request.
 */
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    // Any cheap extension call counts as activity.
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}

/** Stop the keep-alive interval. */
function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/**
 * Run the full analysis flow for a tab.
 *
 * @param {number} tabId
 * @param {boolean} viewportOnly
 * @param {chrome.runtime.Port} [port] Progress channel.
 * @param {boolean} [debug] Show the raw capture slices as well.
 * @returns {Promise<void>}
 */
async function runAnalysis(tabId, viewportOnly, port, debug = false) {
  const report = (step, message) => {
    try {
      port?.postMessage({ type: "LOOKATIFY_PROGRESS", step, message });
    } catch {
      // The popup may have closed; that is not an error.
    }
  };

  try {
    const settings = await getSettings();
    const serverUrl = normaliseServerUrl(settings.serverUrl);
    if (!serverUrl) {
      throw new Error("No analysis server is configured. Open Settings and set the server URL.");
    }
    settings.serverUrl = serverUrl;

    startKeepAlive();

    report("capturing", "Capturing the page…");
    await ensureContentScript(tabId);

    const capture = await chrome.tabs.sendMessage(tabId, {
      type: "LOOKATIFY_CAPTURE_START",
      viewportOnly,
      debug: Boolean(settings.debugCapture) || debug,
    });

    if (!capture || !capture.ok) {
      throw new Error((capture && capture.error) || "The page could not be captured.");
    }

    report("uploading", "Uploading the screenshot…");
    const stitched = await stitchSlices(capture);

    report("analyzing", "Analysing the page…");
    activeController = new AbortController();
    const response = await analyzeImage({
      settings,
      blob: stitched.blob,
      options: {
        colormap: settings.defaultColormap,
        opacity: settings.defaultOpacity,
        topN: settings.defaultTopN,
        viewportOnly,
      },
      signal: activeController.signal,
    });

    if (!response.ok) {
      throw new Error(response.error || "The analysis failed.");
    }

    report("rendering", "Rendering the heatmap…");
    const data = response.data;

    const saliencyBlob = await (await fetch(dataUrlFromBase64(data.saliency_png_base64))).blob();

    // Free the space that earlier versions filled before storing the result.
    await runMaintenance();

    let analysisId;
    try {
      analysisId = await storeAnalysis({
        analysisId: data.analysis_id,
        hostname: await safeHostname(tabId),
        imageBlob: stitched.blob,
        saliencyBlob,
        width: data.width,
        height: data.height,
        topPoints: data.top_points || [],
        stats: data.stats || {},
        timingMs: data.timing_ms || {},
        warnings: data.warnings || [],
        capturedAt: Date.now(),
      });
    } catch (error) {
      throw new Error(storageErrorMessage(error));
    }

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`viewer/viewer.html?id=${analysisId}`),
    });

    port?.postMessage({ type: "LOOKATIFY_DONE", analysisId });
  } catch (error) {
    const message = error && error.message ? error.message : "The analysis failed.";
    try {
      port?.postMessage({ type: "LOOKATIFY_ERROR", message });
    } catch {
      // The popup closed before the error could be delivered.
    }
  } finally {
    stopKeepAlive();
    activeController = null;
    activeTabId = null;
  }
}

/**
 * Convert base64 image data into a data URL.
 *
 * @param {string} base64
 * @returns {string}
 */
function dataUrlFromBase64(base64) {
  return `data:image/png;base64,${base64}`;
}

/**
 * Turn a storage failure into a message the user can act on.
 *
 * The browser reports a full storage area as "Resource::kQuotaBytes quota
 * exceeded", which says nothing about what to do. The usual cause is an
 * old analysis that is still stored, so the message points at the control
 * that removes it.
 *
 * @param {Error} error
 * @returns {string}
 */
function storageErrorMessage(error) {
  const message = String((error && error.message) || error || "");
  if (/quota|kQuotaBytes/i.test(message)) {
    return (
      "The browser storage is full, so the result could not be saved. "
      + "Open Settings and use “Clear saved analyses”, then try again."
    );
  }
  return `The result could not be saved: ${message}`;
}

/**
 * Get the hostname of a tab, for the export filename.
 *
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function safeHostname(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) {
      const url = new URL(tab.url);
      return url.hostname || "page";
    }
  } catch {
    // The tab may have closed; fall through to the default.
  }
  return "page";
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!stored[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS },
    });
  }

  await runMaintenance();
});

chrome.runtime.onStartup.addListener(() => {
  runMaintenance();
});

/**
 * Move legacy analyses out of the settings area and drop the old ones.
 *
 * A browser that is already over the storage quota rejects every write, so
 * this has to run before an analysis is stored. It is safe to run repeatedly.
 *
 * @returns {Promise<void>}
 */
async function runMaintenance() {
  try {
    const { migrated, removed } = await migrateLegacyAnalyses();
    if (migrated > 0 || removed > 0) {
      console.info(
        `[lookatify] storage maintenance: ${migrated} analysis record(s) moved, ${removed} removed`,
      );
    }

    await pruneAnalyses({ keep: MAX_STORED_ANALYSES });
    await syncMetadata(await readAllAnalyses());
  } catch (error) {
    console.error(`[lookatify] storage maintenance failed: ${error.message}`);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CAPTURE_PORT) return;

  port.onMessage.addListener((message) => {
    if (!message || message.type !== "LOOKATIFY_ANALYZE") return;

    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tabId = tabs && tabs[0] ? tabs[0].id : null;
        if (tabId === null || tabId === undefined) {
          throw new Error("No active tab was found.");
        }
        activeTabId = tabId;
        return runAnalysis(
          tabId,
          Boolean(message.viewportOnly),
          port,
          Boolean(message.debug),
        );
      })
      .catch((error) => {
        port.postMessage({
          type: "LOOKATIFY_ERROR",
          message: error.message || "The analysis failed.",
        });
      });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;

  if (message.type === "LOOKATIFY_CAPTURE_FRAME") {
    const tabId = sender.tab ? sender.tab.id : activeTabId;
    if (tabId === null || tabId === undefined) {
      sendResponse({ ok: false, error: "The active tab could not be found." });
      return true;
    }
    captureVisibleTab(tabId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || "The screenshot failed." }),
      );
    return true;
  }

  if (message.type === "LOOKATIFY_CANCEL") {
    activeController?.abort();
    activeController = null;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "LOOKATIFY_HEALTH") {
    getSettings()
      .then((settings) => checkHealth({ ...settings, serverUrl: normaliseServerUrl(settings.serverUrl) }))
      .then((result) => sendResponse(result));
    return true;
  }

  return undefined;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "analyze-full-page" && command !== "analyze-viewport") return;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs && tabs[0] ? tabs[0].id : null;
  if (tabId === null || tabId === undefined) return;

  await runAnalysis(tabId, command === "analyze-viewport", null);
});
