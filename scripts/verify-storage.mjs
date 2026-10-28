/**
 * Verify that LookAtify can store repeated full-page analyses.
 *
 * The bug this checks for: the extension used to write the screenshot and the
 * heatmap into `chrome.storage.local` as base64 data URLs. That area caps out
 * at 10 MB, so after a few analyses every later run failed with
 * "Resource::kQuotaBytes quota exceeded".
 *
 * The test stores several analyses that are each larger than the old quota,
 * reads them back, checks that the old records are pruned and that the
 * settings area stays small, and finally opens the result in the viewer.
 *
 * The storage checks run in an extension page rather than in the service
 * worker, because a dynamic `import()` is not allowed in a service worker
 * scope. The page has the same origin and therefore the same database.
 *
 * Usage:
 *   node scripts/verify-storage.mjs [chromiumPath] [extensionDir]
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const extensionDir = resolve(process.argv[3] || "extension");

if (!existsSync(binary)) {
  console.error(`Chromium not found at ${binary}`);
  process.exit(2);
}

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-storage-"));
const port = 9600 + Math.floor(Math.random() * 300);

const chrome = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

/**
 * Connect to the DevTools endpoint.
 */
async function connect() {
  let browserUrl = null;
  for (let attempt = 0; attempt < 100 && !browserUrl; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) browserUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!browserUrl) throw new Error(`Chromium did not start.\n${stderr.slice(-600)}`);

  const socket = new WebSocket(browserUrl);
  await new Promise((resolve_, reject) => {
    socket.addEventListener("open", resolve_, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const pending = new Map();
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve_, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve_(result);
      });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });

  return { socket, send };
}

/**
 * Evaluate an expression and return its JSON value.
 */
async function evaluateJson(send, sessionId, expression) {
  const response = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "evaluation failed",
    );
  }
  const value = response.result?.value;
  if (typeof value !== "string") {
    throw new Error(`Expected a JSON string, got: ${JSON.stringify(value)}`);
  }
  return JSON.parse(value);
}

/**
 * Open an extension page and attach to it.
 */
async function openExtensionPage(send, extensionId, path) {
  const { targetId } = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}${path}`,
  });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await new Promise((r) => setTimeout(r, 2000));
  return sessionId;
}

async function main() {
  const { socket, send } = await connect();

  const loaded = await send("Extensions.loadUnpacked", { path: extensionDir });
  if (!loaded?.id) throw new Error("The extension did not load.");
  const extensionId = loaded.id;
  console.log("extension id:", extensionId);

  // The background has to be alive: it imports the storage module with a
  // static import, so a broken module stops the service worker from starting.
  let workerStarted = false;
  for (let attempt = 0; attempt < 60 && !workerStarted; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    workerStarted = targets.some(
      (target) => target.type === "service_worker" && target.url.includes(extensionId),
    );
    if (!workerStarted) await new Promise((r) => setTimeout(r, 300));
  }

  const checks = [];

  checks.push({
    name: "the background service worker starts",
    ok: workerStarted,
    value: { workerStarted },
  });

  const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
  checks.push({
    name: "the manifest asks for unlimitedStorage",
    ok: manifest.permissions.includes("unlimitedStorage"),
    value: { permissions: manifest.permissions },
  });

  const pageSession = await openExtensionPage(send, extensionId, "/options/options.html");

  // Store several analyses that are each bigger than the old 10 MB quota.
  const result = await evaluateJson(
    send,
    pageSession,
    `(async () => {
      const module = await import(chrome.runtime.getURL('lib/storage.js'));

      // A real PNG of random noise, because the viewer has to decode it. The
      // pixels are random, so the PNG cannot compress: the image is larger
      // than the old quota, which no single item could be before the fix.
      async function makeNoisePng(size) {
        const canvas = new OffscreenCanvas(size, size);
        const context = canvas.getContext('2d');
        const image = context.createImageData(size, size);
        const pixels = image.data;

        // crypto.getRandomValues only takes 64 KB at a time.
        const chunkSize = 65536;
        for (let offset = 0; offset < pixels.length; offset += chunkSize) {
          const chunk = pixels.subarray(
            offset,
            Math.min(offset + chunkSize, pixels.length),
          );
          crypto.getRandomValues(chunk);
        }
        // The alpha channel stays opaque, so the colour noise is what is
        // stored.
        for (let index = 3; index < pixels.length; index += 4) {
          pixels[index] = 255;
        }

        context.putImageData(image, 0, 0);
        return canvas.convertToBlob({ type: 'image/png' });
      }

      const imageBlob = await makeNoisePng(3000);
      const saliencyBlob = await makeNoisePng(600);

      const ids = [];
      const errors = [];
      for (let index = 0; index < 8; index += 1) {
        try {
          ids.push(await module.writeAnalysis({
            analysisId: 'storage-test-' + index,
            hostname: 'example.com',
            imageBlob,
            saliencyBlob,
            width: 1280,
            height: 2400,
            topPoints: [],
            stats: {},
            timingMs: {},
            warnings: [],
            capturedAt: 1700000000000 + index,
          }));
        } catch (error) {
          errors.push(error.message);
        }
      }

      const all = await module.readAllAnalyses();
      const readBack = await module.readAnalysis(ids[ids.length - 1]);

      // The settings area must not hold the images.
      const stored = await chrome.storage.local.get(null);
      const analysisKeys = Object.keys(stored).filter((key) =>
        key.startsWith('lookatify_analysis_'),
      );
      let settingsBytes = 0;
      for (const key of analysisKeys) {
        settingsBytes += JSON.stringify(stored[key]).length;
      }

      return JSON.stringify({
        written: ids.length,
        errors,
        stored: all.length,
        imageBytes: readBack?.imageBlob?.size ?? 0,
        saliencyBytes: readBack?.saliencyBlob?.size ?? 0,
        settingsBytes,
        settingsTotal: await chrome.storage.local.getBytesInUse(null),
        quota: chrome.storage.local.QUOTA_BYTES ?? null,
        ids,
      });
    })()`,
  );

  checks.push({
    name: "large analyses are stored",
    ok: result.errors.length === 0 && result.written === 8,
    value: { written: result.written, errors: result.errors },
  });
  checks.push({
    name: "the images survive the round trip",
    ok: result.imageBytes > 10 * 1024 * 1024 && result.saliencyBytes > 0,
    value: { imageBytes: result.imageBytes, saliencyBytes: result.saliencyBytes },
  });
  checks.push({
    name: "the settings area stays small",
    ok: result.settingsBytes < 1024 * 1024,
    value: {
      settingsBytes: result.settingsBytes,
      settingsTotal: result.settingsTotal,
      quota: result.quota,
    },
  });

  // Pruning has to keep the number of stored analyses bounded.
  const prune = await evaluateJson(
    send,
    pageSession,
    `(async () => {
      const module = await import(chrome.runtime.getURL('lib/storage.js'));
      const removed = await module.pruneAnalyses({ keep: 3 });
      const all = await module.readAllAnalyses();
      return JSON.stringify({ removed: removed.length, stored: all.length });
    })()`,
  );

  checks.push({
    name: "old analyses are pruned",
    ok: prune.removed === 5 && prune.stored === 3,
    value: prune,
  });

  // The viewer has to be able to open a stored analysis.
  await evaluateJson(
    send,
    pageSession,
    `(async () => {
      const module = await import(chrome.runtime.getURL('lib/storage.js'));
      const all = await module.readAllAnalyses();
      const id = all[0]?.id;
      await chrome.storage.local.set({ lookatify_last_analysis_id: id });
      return JSON.stringify({ id });
    })()`,
  );

  const viewerSession = await openExtensionPage(send, extensionId, "/viewer/viewer.html");

  const viewerState = await evaluateJson(
    send,
    viewerSession,
    `JSON.stringify({
      emptyHidden: document.getElementById('empty-state')?.hidden,
      loadingHidden: document.getElementById('loading-state')?.hidden,
      error: document.getElementById('error-detail')?.textContent?.slice(0, 120),
      canvasWidth: document.getElementById('canvas')?.width,
      canvasHeight: document.getElementById('canvas')?.height,
    })`,
  );

  checks.push({
    name: "the viewer opens the stored analysis",
    ok:
      viewerState.emptyHidden === true &&
      viewerState.loadingHidden === true &&
      !viewerState.error,
    value: viewerState,
  });

  socket.close();

  console.log("\n--- storage results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(38)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 140)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} storage check(s) failed`);
    process.exit(1);
  }
  console.log("\nSTORAGE CHECKS PASSED");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    killBrowser(chrome);
    rmSync(profileDir, { recursive: true, force: true });
  });
