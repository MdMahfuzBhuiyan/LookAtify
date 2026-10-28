/**
 * End-to-end test: capture a real web page in Chromium, upload it to the
 * running LookAtify backend and open the viewer.
 *
 * Requires the backend to be running on http://127.0.0.1:8001. The page that
 * is captured is served by the test itself.
 *
 * Usage:
 *   node scripts/verify-e2e.mjs
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

/** The page the test captures. */
const TARGET_PAGE = [
  "<!doctype html>",
  "<html><head><meta charset='utf-8'><title>LookAtify e2e</title>",
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
  "  <header><h1>End to end capture</h1><p>Headline copy.</p></header>",
  "  <div class='hero'></div>",
  "  <section><h2>One</h2><p>Copy.</p></section>",
  "  <section><h2>Two</h2><p>Copy.</p></section>",
  "  <section><h2>Three</h2><p>Copy.</p></section>",
  "  <footer>footer</footer>",
  "</body></html>",
].join("\n");

const extensionDir = resolve("extension");
const chromiumPath = process.argv[2] || "/usr/bin/google-chrome";
const backendUrl = process.env.LOOKATIFY_BACKEND || "http://127.0.0.1:8001";

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-e2e-"));
const port = 9800 + Math.floor(Math.random() * 400);

// The page that is captured is served by the test, so it needs no fixture.
const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(TARGET_PAGE);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const targetUrl = `http://127.0.0.1:${pageServer.address().port}/`;
console.log("target page:", targetUrl);

if (!existsSync(chromiumPath)) {
  console.error(`Chromium not found at ${chromiumPath}`);
  process.exit(2);
}

const chrome = spawnBrowser(
  chromiumPath,
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

async function waitForDevTools() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {
      // Still starting.
    }
    await new Promise((resolve_) => setTimeout(resolve_, 100));
  }
  throw new Error(`Chromium did not start.\n${stderr.slice(-600)}`);
}

async function findExtensionTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const match = targets.find(
      (target) =>
        target.type === "service_worker" &&
        target.url.includes("/background/service-worker.js"),
    );
    if (match) return match;
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
  return null;
}

async function main() {
  const browserUrl = await waitForDevTools();
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
      const resolve_ = pending.get(message.id);
      pending.delete(message.id);
      resolve_(message.result);
    }
  });

  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve_(result);
      });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });
  };

  // Chrome 137 and newer ignore the --load-extension switch, so the extension
  // is installed over the DevTools protocol instead.
  const loaded = await send("Extensions.loadUnpacked", { path: extensionDir });
  if (!loaded?.id) throw new Error("The extension did not load.");
  console.log("extension id:", loaded.id);

  const extensionTarget = await findExtensionTarget();
  if (!extensionTarget) throw new Error("The extension did not load.");
  const extensionId = new URL(extensionTarget.url).host;
  console.log("extension id:", extensionId);

  // Open the page to capture.
  const { targetId } = await send("Target.createTarget", { url: targetUrl });
  await send("Target.attachToTarget", { targetId, flatten: true });
  await new Promise((resolve_) => setTimeout(resolve_, 2500));

  // Everything below runs in the service worker, which is the only context
  // that has access to chrome.tabs and chrome.scripting.
  const { sessionId: workerSession } = await send("Target.attachToTarget", {
    targetId: extensionTarget.id,
    flatten: true,
  });
  await send("Runtime.enable", {}, workerSession);

  // Configure the extension through its own storage.
  await send(
    "Runtime.evaluate",
    {
      expression: `chrome.storage.local.set({ lookatify_settings: {
        serverUrl: ${JSON.stringify(backendUrl)},
        apiToken: '',
        defaultMode: 'blended',
        defaultOpacity: 0.55,
        defaultColormap: 'jet',
        defaultTopN: 5,
        maxCaptureHeight: 16000
      }})`,
      awaitPromise: true,
    },
    workerSession,
  );
  console.log("settings written");

  // Run the capture through the service worker's message handler.
  const result = await send(
    "Runtime.evaluate",
    {
      expression: `(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => (t.url || '').startsWith(${JSON.stringify(targetUrl)}));
        const tabId = tab ? tab.id : tabs[0].id;
        const steps = [];
        steps.push('tabs=' + JSON.stringify(tabs.map(t => ({id: t.id, url: (t.url||'').slice(0,60)}))));
        try {
          const inj = await chrome.scripting.executeScript({ target: { tabId }, files: ['/content/capture.js'] });
          steps.push('inject ok');
        } catch (e) { steps.push('inject failed: ' + e.message); }
        try {
          const ping = await chrome.tabs.sendMessage(tabId, { type: 'LOOKATIFY_PING' });
          steps.push('ping=' + JSON.stringify(ping));
        } catch (e) { steps.push('ping failed: ' + e.message); }
        try {
          const capture = await chrome.tabs.sendMessage(tabId, { type: 'LOOKATIFY_CAPTURE_START', viewportOnly: false });
          steps.push('capture ok=' + (capture && capture.ok) + ' slices=' + ((capture && capture.slices || []).length) + ' size=' + (capture && capture.width) + 'x' + (capture && capture.height));
        } catch (e) { steps.push('capture failed: ' + e.message); }
        return JSON.stringify(steps);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    workerSession,
  );

  // The evaluation returns an array of diagnostic strings; the capture
  // summary is the last entry.
  const steps = JSON.parse(result.result?.value ?? "[]");
  for (const step of steps) console.log("  ", step);

  const summary = steps[steps.length - 1] ?? "";
  const match = /capture ok=(\S+) slices=(\d+) size=(\d+)x(\d+)/.exec(summary);
  if (!match) {
    throw new Error(`The capture did not report a result: ${summary}`);
  }

  const [, ok, sliceCount, width, height] = match;
  console.log("capture ok:", ok);
  console.log("slices:", sliceCount);
  console.log("size:", width, "x", height);

  if (ok !== "true") {
    throw new Error(`Capture failed: ${summary}`);
  }

  // Stitch the slices and upload them to the backend, exactly as the
  // service worker's analysis flow does.
  const upload = await send(
    "Runtime.evaluate",
    {
      expression: `(async () => {
        const steps = [];
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0].id;
        const capture = await chrome.tabs.sendMessage(tabId, { type: 'LOOKATIFY_CAPTURE_START', viewportOnly: false });
        steps.push('recaptured slices=' + capture.slices.length);

        // Stitch.
        const size = { width: Math.round(capture.width * capture.devicePixelRatio), height: Math.round(capture.height * capture.devicePixelRatio) };
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext('2d');
        for (const slice of capture.slices) {
          const bitmap = await createImageBitmap(await (await fetch(slice.dataUrl)).blob());
          const offsetY = Math.round((slice.scrollY / capture.pageHeight) * size.height);
          ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, offsetY, bitmap.width, Math.min(bitmap.height, size.height - offsetY));
        }
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        steps.push('stitched ' + size.width + 'x' + size.height + ' bytes=' + blob.size);

        // Upload.
        const stored = await chrome.storage.local.get('lookatify_settings');
        const settings = stored.lookatify_settings;
        const form = new FormData();
        form.append('file', blob, 'screenshot.png');
        form.append('colormap', settings.defaultColormap);
        form.append('top_n', String(settings.defaultTopN));

        const response = await fetch(settings.serverUrl + '/analyze', { method: 'POST', body: form });
        steps.push('analyze status=' + response.status);
        if (!response.ok) {
          steps.push('body=' + (await response.text()).slice(0, 200));
          return JSON.stringify(steps);
        }
        const data = await response.json();
        steps.push('analysis_id=' + data.analysis_id + ' size=' + data.width + 'x' + data.height + ' points=' + (data.top_points || []).length);
        steps.push('above_fold=' + data.stats.above_fold_pct);
        return JSON.stringify(steps);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    workerSession,
  );

  const uploadSteps = JSON.parse(upload.result?.value ?? "[]");
  for (const step of uploadSteps) console.log("  ", step);

  if (!uploadSteps.some((step) => step.startsWith("analyze status=200"))) {
    throw new Error("The upload to the backend failed.");
  }

  socket.close();
  killBrowser(chrome);
  pageServer.close();
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("E2E CAPTURE OK");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  killBrowser(chrome);
  pageServer.close();
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exit(1);
});

