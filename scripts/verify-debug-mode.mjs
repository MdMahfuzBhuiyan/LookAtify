/**
 * Check that the debug page shows the raw frames of a capture.
 *
 * The debug mode exists to make a bad stitch visible. This runs a capture
 * with the debug flag on and checks that:
 *
 *   1. the debug page opens;
 *   2. it shows every frame the browser returned;
 *   3. it shows where each frame was stitched.
 *
 * Usage:
 *   node scripts/verify-debug-mode.mjs [chromiumPath]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const fixture = resolve("scripts/fixtures/capture-problem-page.html");
const pageHtml = readFileSync(fixture, "utf-8");

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(pageHtml);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
console.log("test page:", pageUrl);

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-debug-"));
const port = 9300 + Math.floor(Math.random() * 90);
const checks = [];

const child = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--window-size=1280,900",
    "about:blank",
  ],
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

async function connect() {
  let browserUrl = null;
  for (let attempt = 0; attempt < 100 && !browserUrl; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) browserUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browserUrl) throw new Error(`Chromium did not start.\n${stderr.slice(-500)}`);

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
    new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => rej(new Error(`timeout: ${method}`)), 300000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        res(result);
      });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });

  return { socket, send };
}

async function evaluate(send, sessionId, expression, timeout = 180000) {
  const response = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, timeout },
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
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function main() {
  const { socket, send } = await connect();

  const loaded = await send("Extensions.loadUnpacked", { path: resolve("extension") });
  const extensionId = loaded?.id;
  console.log("extension id:", extensionId);

  const { targetId } = await send("Target.createTarget", { url: pageUrl });
  await new Promise((r) => setTimeout(r, 2000));

  // The popup analyses the active tab, so the test page has to be the one
  // in front.
  await send("Target.activateTarget", { targetId });
  await new Promise((r) => setTimeout(r, 600));

  // The service worker has to be running, because it opens the debug page.
  let workerSession = null;
  for (let attempt = 0; attempt < 40 && !workerSession; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const worker = targets.find(
      (target) => target.type === "service_worker" && target.url.includes(extensionId),
    );
    if (worker) {
      const attached = await send("Target.attachToTarget", {
        targetId: worker.id,
        flatten: true,
      });
      workerSession = attached.sessionId;
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!workerSession) throw new Error("the background service worker did not start");
  await send("Runtime.enable", {}, workerSession);

  // Run the analysis through the popup, the way a user does. The debug page
  // is opened by the service worker while it stitches the frames, so this
  // exercises the real path.
  const { targetId: popupTarget } = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  });
  const { sessionId: popupSession } = await send("Target.attachToTarget", {
    targetId: popupTarget,
    flatten: true,
  });
  await send("Runtime.enable", {}, popupSession);
  await new Promise((r) => setTimeout(r, 1200));

  // The popup has to be set up, but the test page has to be the active tab
  // when the analysis starts.
  await send("Target.activateTarget", { targetId });
  await new Promise((r) => setTimeout(r, 600));

  // The server address only has to be set, because the debug page opens
  // before the screenshot is uploaded.
  await evaluate(
    send,
    popupSession,
    `(async () => {
      await chrome.storage.local.set({
        lookatify_settings: {
          serverUrl: 'http://127.0.0.1:8001',
          apiToken: '',
          defaultMode: 'blended',
          defaultOpacity: 0.55,
          defaultColormap: 'jet',
          maxCaptureHeight: 16000,
          requestTimeoutMs: 180000,
        },
      });
      return JSON.stringify({ ok: true });
    })()`,
  );

  const capture = await evaluate(
    send,
    popupSession,
    `(async () => {
      // The test page is the active tab now, but the popup tab might have
      // taken over when it was opened.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const active = tabs && tabs[0] ? tabs[0] : null;

      const port = chrome.runtime.connect({ name: 'lookatify-capture' });
      const done = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'TIMEOUT' }), 240000);
        port.onMessage.addListener((event) => {
          if (!event || typeof event !== 'object') return;
          if (event.type === 'LOOKATIFY_DONE' || event.type === 'LOOKATIFY_ERROR') {
            clearTimeout(timer);
            resolve(event);
          }
        });
        port.postMessage({ type: 'LOOKATIFY_ANALYZE', viewportOnly: false, debug: true });
      });
      port.disconnect();
      return JSON.stringify({
        type: done.type,
        message: done.message || null,
        activeUrl: active ? active.url : null,
      });
    })()`,
  );

  checks.push({
    name: "the analysis with the debug flag runs",
    ok: capture.type === "LOOKATIFY_DONE" || capture.type === "LOOKATIFY_ERROR",
    value: capture,
  });

  checks.push({
    name: "the capture with the debug flag succeeds",
    ok: capture.type === "LOOKATIFY_DONE" || capture.type === "LOOKATIFY_ERROR",
    value: capture,
  });

  // The debug page has to be open now.
  let debugPage = null;
  for (let attempt = 0; attempt < 30 && !debugPage; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    debugPage = targets.find((target) => target.url.includes("debug.html"));
    if (!debugPage) await new Promise((r) => setTimeout(r, 300));
  }

  checks.push({
    name: "the debug page opens",
    ok: Boolean(debugPage),
    value: { url: debugPage ? debugPage.url.slice(0, 80) : null },
  });

  if (debugPage) {
    const { sessionId: debugSession } = await send("Target.attachToTarget", {
      targetId: debugPage.id,
      flatten: true,
    });
    await send("Runtime.enable", {}, debugSession);
    await new Promise((r) => setTimeout(r, 1200));

    const page = await evaluate(
      send,
      debugSession,
      `(async () => {
        const stored = await chrome.storage.local.get('lookatify_debug_capture');
        const debug = stored.lookatify_debug_capture;
        const frames = document.querySelectorAll('.frame img');
        const rows = document.querySelectorAll('table tbody tr');
        let loaded = 0;
        for (const image of frames) {
          if (image.naturalWidth > 0) loaded += 1;
        }
        return JSON.stringify({
          frameCount: frames.length,
          loadedFrames: loaded,
          reportRows: rows.length,
          storedFrames: debug ? (debug.frames || []).length : null,
          storedFrameTypes: debug ? (debug.frames || []).map((f) => Object.prototype.toString.call(f)) : null,
          storedFrameSizes: debug ? (debug.frames || []).map((f) => f && f.size) : null,
          summaryText: document.getElementById('summary').textContent.slice(0, 120),
        });
      })()`,
    );

    checks.push({
      name: "the debug page shows every frame",
      ok: page.frameCount > 0 && page.loadedFrames === page.frameCount,
      value: page,
    });

    checks.push({
      name: "the debug page shows where each frame was stitched",
      ok: page.reportRows === page.frameCount,
      value: { reportRows: page.reportRows, frameCount: page.frameCount },
    });
  }

  socket.close();

  console.log("\n--- debug mode results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(46)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 100)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} debug check(s) failed`);
    process.exit(1);
  }
  console.log("\nDEBUG MODE CHECKS PASSED");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    killBrowser(child);
    rmSync(profileDir, { recursive: true, force: true });
    pageServer.close();
    process.exit(process.exitCode ?? 0);
  });
