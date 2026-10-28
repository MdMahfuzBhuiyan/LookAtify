/**
 * Verify the complete analysis flow the way a user runs it.
 *
 * The other tests exercise the parts in isolation. This one drives the real
 * path: the popup connects to the capture port, the service worker captures
 * the page, uploads it, analyses it and stores the result. It then checks
 * that the result is in IndexedDB, that the viewer opens it, and that the
 * settings area stays small.
 *
 * It also checks the migration: an analysis that an older version wrote as a
 * base64 data URL has to move into the database and free the space, because
 * a browser that is already over the quota rejects every write.
 *
 * Usage:
 *   node scripts/verify-flow.mjs [chromiumPath] [extensionDir]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const extensionDir = resolve(process.argv[3] || "extension");
const backendUrl = process.env.LOOKATIFY_BACKEND || "http://127.0.0.1:8001";

const TARGET_PAGE = [
  "<!doctype html>",
  "<html><head><meta charset='utf-8'><title>LookAtify flow</title>",
  "<style>",
  "  body { margin: 0; font-family: system-ui, sans-serif; }",
  "  nav { position: sticky; top: 0; padding: 16px 24px; color: #fff; background: #241f23; }",
  "  header { padding: 48px 24px; }",
  "  h1 { margin: 0 0 12px; font-size: 40px; }",
  "  .hero { height: 520px; margin: 24px; background: linear-gradient(120deg, #d7e3f0, #7fa8d0); }",
  "  section { padding: 40px 24px; border-top: 1px solid #eee; }",
  "  footer { padding: 70px 24px; color: #999; background: #241f23; }",
  "</style></head>",
  "<body>",
  "  <nav>nav</nav>",
  "  <header><h1>Flow test</h1><p>Headline copy.</p></header>",
  "  <div class='hero'></div>",
  "  <section><h2>One</h2><p>Copy.</p></section>",
  "  <section><h2>Two</h2><p>Copy.</p></section>",
  "  <footer>footer</footer>",
  "</body></html>",
].join("\n");

if (!existsSync(binary)) {
  console.error(`Chromium not found at ${binary}`);
  process.exit(2);
}

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(TARGET_PAGE);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const targetUrl = `http://127.0.0.1:${pageServer.address().port}/`;

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-flow-"));
const port = 9700 + Math.floor(Math.random() * 200);

const chrome = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,900",
    "about:blank",
  ],
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

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
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 300000);
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

async function evaluateJson(send, sessionId, expression, timeout = 300000) {
  const response = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, timeout },
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

async function openPage(send, url, settleMs = 2000) {
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await new Promise((r) => setTimeout(r, settleMs));
  return { sessionId, targetId };
}

async function main() {
  const { socket, send } = await connect();

  const loaded = await send("Extensions.loadUnpacked", { path: extensionDir });
  if (!loaded?.id) throw new Error("The extension did not load.");
  const extensionId = loaded.id;
  console.log("extension id:", extensionId);

  const checks = [];

  // The page that is analysed.
  const target = await openPage(send, targetUrl, 2500);

  // The extension page that drives the analysis, like the popup does.
  const popup = await openPage(
    send,
    `chrome-extension://${extensionId}/popup/popup.html`,
  );
  const popupSession = popup.sessionId;

  // The service worker captures the active tab, so the page under test has
  // to be the one in front when the analysis starts.
  await send("Target.activateTarget", { targetId: target.targetId });
  await new Promise((r) => setTimeout(r, 500));

  // Point the extension at the backend.
  await evaluateJson(
    send,
    popupSession,
    `(async () => {
      await chrome.storage.local.set({ lookatify_settings: {
        serverUrl: ${JSON.stringify(backendUrl)},
        apiToken: '',
        defaultMode: 'blended',
        defaultOpacity: 0.55,
        defaultColormap: 'jet',
        defaultTopN: 5,
        maxCaptureHeight: 16000,
        requestTimeoutMs: 180000,
      }});
      return JSON.stringify({ ok: true });
    })()`,
  );

  // A legacy analysis, the way an older version wrote it. It has to be
  // migrated, because a browser that is over the quota rejects every write.
  const legacy = await evaluateJson(
    send,
    popupSession,
    `(async () => {
      const module = await import(chrome.runtime.getURL('lib/storage.js'));
      const canvas = new OffscreenCanvas(400, 300);
      const context = canvas.getContext('2d');
      context.fillStyle = '#c2703d';
      context.fillRect(0, 0, 400, 300);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });

      await chrome.storage.local.set({
        'lookatify_analysis_legacy-1': {
          analysisId: 'legacy-1',
          hostname: 'legacy.example',
          imageDataUrl: dataUrl,
          saliencyDataUrl: dataUrl,
          width: 400,
          height: 300,
          topPoints: [],
          stats: {},
          timingMs: {},
          warnings: [],
          capturedAt: 1600000000000,
        },
      });

      const before = await module.migrateLegacyAnalyses();
      const stored = await chrome.storage.local.get(null);
      const all = await module.readAllAnalyses();
      const read = await module.readAnalysis('legacy-1');

      return JSON.stringify({
        before,
        legacyStillInSettings:
          Object.keys(stored).includes('lookatify_analysis_legacy-1'),
        migrated: all.some((record) => record.id === 'legacy-1'),
        imageBytes: read?.imageBlob?.size ?? 0,
      });
    })()`,
  );

  checks.push({
    name: "the legacy analysis is migrated",
    ok:
      legacy.before.migrated === 1 &&
      legacy.legacyStillInSettings === false &&
      legacy.migrated === true &&
      legacy.imageBytes > 0,
    value: legacy,
  });

  // Now the real flow: the popup asks for an analysis and waits for it.
  const flow = await evaluateJson(
    send,
    popupSession,
    `(async () => {
      const steps = [];
      const capturePort = chrome.runtime.connect({ name: 'lookatify-capture' });

      const done = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ type: 'TIMEOUT' }), 240000);
        capturePort.onMessage.addListener((event) => {
          if (!event || typeof event !== 'object') return;
          if (event.type === 'LOOKATIFY_PROGRESS') {
            steps.push(event.step);
            return;
          }
          if (event.type === 'LOOKATIFY_DONE' || event.type === 'LOOKATIFY_ERROR') {
            clearTimeout(timer);
            resolve(event);
            return;
          }
        });
        capturePort.postMessage({ type: 'LOOKATIFY_ANALYZE', viewportOnly: false });
      });

      const module = await import(chrome.runtime.getURL('lib/storage.js'));
      const all = await module.readAllAnalyses();
      const last = await chrome.storage.local.get('lookatify_last_analysis_id');
      const stored = await chrome.storage.local.get(null);
      const analysisKeys = Object.keys(stored).filter((key) =>
        key.startsWith('lookatify_analysis_'),
      );
      let settingsBytes = 0;
      for (const key of analysisKeys) {
        settingsBytes += JSON.stringify(stored[key]).length;
      }

      const ordered = all.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
      const newest = ordered[0];

      return JSON.stringify({
        type: done.type,
        message: done.message || null,
        steps,
        stored: all.length,
        lastAnalysis: last.lookatify_last_analysis_id || null,
        settingsBytes,
        settingsTotal: await chrome.storage.local.getBytesInUse(null),
        newest: newest
          ? {
              id: newest.id,
              imageBytes: newest.imageBlob?.size ?? 0,
              saliencyBytes: newest.saliencyBlob?.size ?? 0,
            }
          : null,
      });
    })()`,
  );

  console.log("flow result:", JSON.stringify(flow).slice(0, 400));

  checks.push({
    name: "the analysis completes",
    ok: flow.type === "LOOKATIFY_DONE",
    value: { type: flow.type, message: flow.message, steps: flow.steps },
  });
  checks.push({
    name: "the result is stored with its images",
    ok:
      flow.newest !== null &&
      flow.newest.imageBytes > 0 &&
      flow.newest.saliencyBytes > 0,
    value: flow.newest,
  });
  checks.push({
    name: "the settings area stays small",
    ok: flow.settingsBytes < 1024 * 1024,
    value: { settingsBytes: flow.settingsBytes, settingsTotal: flow.settingsTotal },
  });

  // The viewer opens the result.
  const viewer = await openPage(
    send,
    `chrome-extension://${extensionId}/viewer/viewer.html`,
    3000,
  );
  const viewerState = await evaluateJson(
    send,
    viewer.sessionId,
    `JSON.stringify({
      emptyHidden: document.getElementById('empty-state')?.hidden,
      loadingHidden: document.getElementById('loading-state')?.hidden,
      error: document.getElementById('error-detail')?.textContent?.slice(0, 160),
    })`,
  );

  checks.push({
    name: "the viewer opens the result",
    ok:
      viewerState.emptyHidden === true &&
      viewerState.loadingHidden === true &&
      !viewerState.error,
    value: viewerState,
  });

  socket.close();

  console.log("\n--- flow results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(38)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 150)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} flow check(s) failed`);
    process.exit(1);
  }
  console.log("\nFLOW CHECKS PASSED");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    killBrowser(chrome);
    rmSync(profileDir, { recursive: true, force: true });
    pageServer.close();
  });
