/**
 * Verify that the viewer really shows the heatmap.
 *
 * The page checks only prove that the viewer loads. They cannot tell whether
 * the DeepGaze layer reaches the screen: the overlay that says "Preparing
 * the heatmap…" once sat on top of the canvas for good, because the
 * stylesheet gave the placeholder a `display` that beat the `hidden`
 * attribute.
 *
 * This test therefore reads the canvas back and checks the pixels:
 *
 *   1. every element with the `hidden` attribute is out of sight
 *   2. the heatmap mode is not blank
 *   3. the blended mode differs from the plain screenshot
 *   4. the heatmap changes the pixels where the attention peaks
 *
 * Usage:
 *   node scripts/verify-viewer.mjs [chromiumPath] [extensionDir]
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
  "<html><head><meta charset='utf-8'><title>LookAtify viewer test</title>",
  "<style>",
  "  body { margin: 0; font-family: system-ui, sans-serif; }",
  "  header { padding: 40px 24px; }",
  "  .hero { height: 480px; margin: 24px; background: linear-gradient(120deg, #f6f2e6, #e0c9a6); }",
  "  section { padding: 36px 24px; }",
  "</style></head>",
  "<body>",
  "  <header><h1>Viewer test</h1><p>Copy.</p></header>",
  "  <div class='hero'></div>",
  "  <section><h2>One</h2><p>Copy.</p></section>",
  "  <section><h2>Two</h2><p>Copy.</p></section>",
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

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-viewer-"));
const port = 9750 + Math.floor(Math.random() * 200);

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

  const target = await openPage(send, targetUrl, 2500);
  const popup = await openPage(
    send,
    `chrome-extension://${extensionId}/popup/popup.html`,
  );

  await evaluateJson(
    send,
    popup.sessionId,
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

  await send("Target.activateTarget", { targetId: target.targetId });
  await new Promise((r) => setTimeout(r, 500));

  // Run a real analysis, so the viewer gets a genuine DeepGaze result.
  const flow = await evaluateJson(
    send,
    popup.sessionId,
    `(async () => {
      const capturePort = chrome.runtime.connect({ name: 'lookatify-capture' });
      const done = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'TIMEOUT' }), 240000);
        capturePort.onMessage.addListener((event) => {
          if (!event || typeof event !== 'object') return;
          if (event.type === 'LOOKATIFY_DONE' || event.type === 'LOOKATIFY_ERROR') {
            clearTimeout(timer);
            resolve(event);
          }
        });
        capturePort.postMessage({ type: 'LOOKATIFY_ANALYZE', viewportOnly: false });
      });
      return JSON.stringify({ type: done.type, message: done.message || null });
    })()`,
  );

  checks.push({
    name: "the analysis completes",
    ok: flow.type === "LOOKATIFY_DONE",
    value: flow,
  });

  const viewer = await openPage(
    send,
    `chrome-extension://${extensionId}/viewer/viewer.html`,
    4000,
  );

  const report = await evaluateJson(
    send,
    viewer.sessionId,
    `(async () => {
      const canvas = document.getElementById('canvas');
      const context = canvas.getContext('2d');
      const read = () =>
        Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);

      const click = async (mode) => {
        document.querySelector('[data-mode="' + mode + '"]').click();
        await new Promise((r) => setTimeout(r, 700));
      };

      const blended = read();
      await click('original');
      const original = read();
      await click('heatmap');
      const heatmap = read();
      await click('blended');

      // The pixels that the heatmap layer paints.
      let lit = 0;
      for (let index = 0; index < heatmap.length; index += 4) {
        if (heatmap[index] + heatmap[index + 1] + heatmap[index + 2] > 30) lit += 1;
      }

      // How much the blend differs from the plain screenshot.
      let differs = 0;
      let maxDelta = 0;
      for (let index = 0; index < original.length; index += 4) {
        const delta =
          Math.abs(original[index] - blended[index]) +
          Math.abs(original[index + 1] - blended[index + 1]) +
          Math.abs(original[index + 2] - blended[index + 2]);
        if (delta > 6) differs += 1;
        if (delta > maxDelta) maxDelta = delta;
      }

      // Every element that carries the hidden attribute has to be out of
      // sight, or an overlay covers the canvas.
      const hiddenLeaks = Array.from(document.querySelectorAll('[hidden]'))
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => element.id || element.className);

      return JSON.stringify({
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        heatmapLitPixels: lit,
        blendedDiffersFromOriginal: differs,
        maxDelta,
        hiddenLeaks,
        errorText: document.getElementById('error-detail')?.textContent?.slice(0, 160),
      });
    })()`,
  );

  checks.push({
    name: "no hidden element is on screen",
    ok: report.hiddenLeaks.length === 0,
    value: { hiddenLeaks: report.hiddenLeaks },
  });
  checks.push({
    name: "the heatmap layer is not blank",
    ok: report.heatmapLitPixels > 1000,
    value: { heatmapLitPixels: report.heatmapLitPixels },
  });
  checks.push({
    name: "the heatmap is visible on the screenshot",
    ok: report.blendedDiffersFromOriginal > 1000 && report.maxDelta > 10,
    value: {
      blendedDiffersFromOriginal: report.blendedDiffersFromOriginal,
      maxDelta: report.maxDelta,
    },
  });
  checks.push({
    name: "the viewer reports no error",
    ok: !report.errorText,
    value: { errorText: report.errorText },
  });

  socket.close();

  console.log("\n--- viewer results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(38)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 140)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} viewer check(s) failed`);
    process.exit(1);
  }
  console.log("\nVIEWER CHECKS PASSED");
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
