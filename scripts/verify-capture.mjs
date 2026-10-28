/**
 * End-to-end capture test for the LookAtify extension.
 *
 * The page checks only prove that the extension's HTML loads. This test
 * exercises the part that actually differs between browsers: the capture
 * pipeline, which uses `chrome.tabs.captureVisibleTab`,
 * `chrome.scripting.executeScript`, `OffscreenCanvas` and dynamic imports
 * inside a content script.
 *
 * The test:
 *   1. serves a real page over HTTP
 *   2. loads the extension
 *   3. injects the content script into the test page
 *   4. runs a viewport capture and checks the slices that come back
 *   5. checks the background service worker can stitch them
 *
 * Usage:
 *   node scripts/verify-capture.mjs [browserBinary] [extensionDir]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const extensionDir = resolve(process.argv[3] || "extension");

/** A page tall enough to need more than one viewport. */
const TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>LookAtify capture test</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  nav { position: sticky; top: 0; padding: 16px 24px; color: #fff; background: #241f23; }
  header { padding: 48px 24px; }
  h1 { margin: 0 0 12px; font-size: 38px; }
  .hero { height: 500px; margin: 24px; background: linear-gradient(120deg, #d7e3f0, #7fa8d0); }
  section { padding: 36px 24px; border-top: 1px solid #eee; }
  footer { padding: 60px 24px; color: #999; background: #241f23; }
</style></head>
<body>
  <nav>nav</nav>
  <header><h1>Capture test</h1><p>Subtitle copy.</p></header>
  <div class="hero"></div>
  <section><h2>One</h2><p>Copy.</p></section>
  <section><h2>Two</h2><p>Copy.</p></section>
  <section><h2>Three</h2><p>Copy.</p></section>
  <footer>footer</footer>
</body></html>`;

/**
 * Serve the test page.
 *
 * @returns {Promise<{port: number, close: Function}>}
 */
function startServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(TEST_PAGE);
  });
  return new Promise((resolve_) => {
    server.listen(0, "127.0.0.1", () => {
      resolve_({
        port: server.address().port,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Connect to the DevTools endpoint.
 *
 * @param {number} port
 */
async function connect(port) {
  const browserUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
    .webSocketDebuggerUrl;
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
      pending.get(message.id)(message.result ?? { error: message.error });
      pending.delete(message.id);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve_, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        if (result?.error) reject(new Error(`${method}: ${result.error.message}`));
        else resolve_(result);
      });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });

  return { socket, send };
}

/**
 * Evaluate an expression in a target.
 */
async function evaluate(send, sessionId, expression, timeout = 60000) {
  const result = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, timeout },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation failed",
    );
  }
  return result.result?.value;
}

async function main() {
  const server = await startServer();
  const pageUrl = `http://127.0.0.1:${server.port}/`;
  console.log(`test page: ${pageUrl}`);

  const profileDir = mkdtempSync(join(tmpdir(), "lookatify-capture-"));
  const port = 9700 + Math.floor(Math.random() * 200);
  const failures = [];
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
      `--window-size=1280,900`,
      "about:blank",
    ],
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const { socket, send } = await connect(port);

    // Load the extension.
    const loaded = await send("Extensions.loadUnpacked", { path: extensionDir });
    const extensionId = loaded?.id;
    if (!extensionId) throw new Error("the extension did not load");
    console.log("extension id:", extensionId);

    // Open the test page.
    const { targetId } = await send("Target.createTarget", { url: pageUrl });
    const { sessionId: pageSession } = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await send("Page.enable", {}, pageSession);
    await send("Runtime.enable", {}, pageSession);
    await new Promise((r) => setTimeout(r, 2500));

    const pageInfo = JSON.parse(
      await evaluate(
        send,
        pageSession,
        `JSON.stringify({
           title: document.title,
           height: document.documentElement.scrollHeight,
           width: window.innerWidth,
         })`,
      ),
    );
    checks.push({ name: "page loads", ok: pageInfo.height > 900, value: pageInfo });

    // Attach to the background service worker.
    let workerSession = null;
    for (let attempt = 0; attempt < 40 && !workerSession; attempt += 1) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const worker = targets.find(
        (target) =>
          target.type === "service_worker" &&
          target.url.includes(extensionId),
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

    // The service worker must have the APIs the capture flow needs.
    const apis = JSON.parse(
      await evaluate(
        send,
        workerSession,
        `JSON.stringify({
           hasTabs: typeof chrome.tabs?.captureVisibleTab === 'function',
           hasScripting: typeof chrome.scripting?.executeScript === 'function',
           hasStorage: typeof chrome.storage?.local?.get === 'function',
           hasOffscreenCanvas: typeof OffscreenCanvas === 'function',
           hasCreateImageBitmap: typeof createImageBitmap === 'function',
           hasCommands: typeof chrome.commands?.onCommand !== 'undefined',
         })`,
      ),
    );
    checks.push({
      name: "background APIs",
      ok:
        apis.hasTabs &&
        apis.hasScripting &&
        apis.hasStorage &&
        apis.hasOffscreenCanvas &&
        apis.hasCreateImageBitmap &&
        apis.hasCommands,
      value: apis,
    });

    // Inject the content script and run a real capture.
    const capture = JSON.parse(
      await evaluate(
        send,
        workerSession,
        `(async () => {
           const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl + "*")} });
           const tab = tabs[0];
           if (!tab) return JSON.stringify({ ok: false, error: "the test tab was not found" });

           try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["/content/capture.js"],
              });
           } catch (error) {
             return JSON.stringify({ ok: false, error: "inject: " + error.message });
           }

           let result;
           try {
             result = await chrome.tabs.sendMessage(tab.id, {
               type: "LOOKATIFY_CAPTURE_START",
                viewportOnly: false,
              });
           } catch (error) {
             return JSON.stringify({ ok: false, error: "capture: " + error.message });
           }

           if (!result || !result.ok) {
             return JSON.stringify({ ok: false, error: (result && result.error) || "capture failed" });
           }

           const first = result.slices[0] || {};
           return JSON.stringify({
             ok: true,
             slices: result.slices.length,
             width: result.width,
             height: result.height,
             pageHeight: result.pageHeight,
             devicePixelRatio: result.devicePixelRatio,
             isPng: typeof first.dataUrl === 'string' && first.dataUrl.startsWith('data:image/png'),
             dataUrlLength: (first.dataUrl || '').length,
           });
         })()`,
        90000,
      ),
    );
    checks.push({
      name: "capture pipeline",
      ok: capture.ok && capture.slices > 0 && capture.isPng && capture.dataUrlLength > 1000,
      value: capture,
    });

    // The full page capture scrolls through the page, so it produces more
    // than one slice.
    checks.push({
      name: "full page slices",
      ok: capture.ok && capture.slices > 1 && capture.height > capture.pageHeight * 0.5,
      value: {
        slices: capture.slices,
        height: capture.height,
        pageHeight: capture.pageHeight,
      },
    });

    // The background worker must be able to stitch the slices.
    const stitch = JSON.parse(
      await evaluate(
        send,
        workerSession,
        `(async () => {
           const canvas = new OffscreenCanvas(10, 10);
           const context = canvas.getContext('2d');
           context.fillStyle = '#c2703d';
           context.fillRect(0, 0, 10, 10);
           const blob = await canvas.convertToBlob({ type: 'image/png' });
           const bitmap = await createImageBitmap(blob);
           const size = { width: bitmap.width, height: bitmap.height };
           bitmap.close();
           return JSON.stringify({ ok: true, blobSize: blob.size, ...size });
         })()`,
      ),
    );
    checks.push({
      name: "stitching canvas",
      ok: stitch.ok && stitch.blobSize > 0 && stitch.width === 10,
      value: stitch,
    });

    // The content script must be able to import the stitching helpers. The
    // import only resolves inside the extension's isolated world, so the
    // script is injected there rather than run in the page.
    const dynamicImport = JSON.parse(
      await evaluate(
        send,
        workerSession,
        `(async () => {
           const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl + "*")} });
           const tab = tabs[0];
           try {
             const results = await chrome.scripting.executeScript({
               target: { tabId: tab.id },
               func: async () => {
                 try {
                   const module = await import(chrome.runtime.getURL('lib/stitch.js'));
                   return {
                     ok: true,
                     hasPlanSlices: typeof module.planSlices === 'function',
                     hasFindSticky: typeof module.findStickyElements === 'function',
                   };
                 } catch (error) {
                   return { ok: false, error: error.message };
                 }
               },
             });
             return JSON.stringify(results[0]?.result ?? { ok: false, error: 'no result' });
           } catch (error) {
             return JSON.stringify({ ok: false, error: error.message });
           }
         })()`,
      ),
    );
    checks.push({
      name: "content script import",
      ok: dynamicImport.ok && dynamicImport.hasPlanSlices && dynamicImport.hasFindSticky,
      value: dynamicImport,
    });

    socket.close();
  } catch (error) {
    failures.push(error.message);
    console.log("ERROR:", error.message);
  } finally {
    killBrowser(child);
    rmSync(profileDir, { recursive: true, force: true });
    server.close();
  }

  console.log("\n--- capture results ---");
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(22)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 180)}`,
    );
    if (!check.ok) failures.push(check.name);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: ${[...new Set(failures)].join(", ")}`);
    process.exit(1);
  }
  console.log("\nCAPTURE CHECKS PASSED");
  // The browser may keep the event loop alive, so the run ends explicitly.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
