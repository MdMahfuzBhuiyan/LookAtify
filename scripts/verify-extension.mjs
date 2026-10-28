/**
 * Load the LookAtify extension into headless Chromium and verify that the
 * popup, options and viewer pages render and behave correctly.
 *
 * The extension is installed over the DevTools protocol, because Chrome 137
 * and newer ignore the `--load-extension` command line switch.
 *
 * Usage:
 *   node scripts/verify-extension.mjs [extensionDir] [chromiumPath]
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";
import { findChromium } from "./browser-paths.mjs";

const extensionDir = resolve(process.argv[2] || "extension");
const chromiumPath = process.argv[3] || findChromium();
const profileDir = mkdtempSync(join(tmpdir(), "lookatify-profile-"));
const port = 9700 + Math.floor(Math.random() * 400);

if (!existsSync(chromiumPath)) {
  console.error(
    `Chromium not found at ${chromiumPath}.\n` +
      "Install one with:\n" +
      "  npx @puppeteer/browsers install chromium@latest --path /tmp/pptr-browsers",
  );
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
    "--window-size=1200,800",
    "about:blank",
  ],
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

/** Wait for the DevTools endpoint. */
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
  throw new Error(`Chromium did not start.\n${stderr.slice(-800)}`);
}

/** Find our extension's service worker and read its id. */
async function findExtensionId() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const match = targets.find(
      (target) =>
        target.type === "service_worker" &&
        target.url.includes("/background/service-worker.js"),
    );
    if (match) return new URL(match.url).host;
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
  return null;
}

/** Connect to the browser and open a page target. */
async function connect() {
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
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve_(result);
      });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });
  };

  return { socket, send };
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(send, sessionId, expression) {
  const result = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "evaluation failed");
  }
  return result.result?.value;
}

/** Navigate and wait for the page to finish loading. */
async function openPage(send, sessionId, url, settleMs = 2500) {
  await send("Page.navigate", { url }, sessionId);
  await new Promise((resolve_) => setTimeout(resolve_, settleMs));
}

async function main() {
  if (!existsSync(join(extensionDir, "manifest.json"))) {
    throw new Error(`No manifest.json in ${extensionDir}`);
  }

  const { socket, send } = await connect();

  // Install the extension over the DevTools protocol.
  const loaded = await send("Extensions.loadUnpacked", { path: extensionDir });
  if (!loaded?.id) throw new Error("The extension did not load.");

  const extensionId = await findExtensionId();
  if (!extensionId) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const target of list) console.log(" ", target.type, "|", target.url.slice(0, 90));
    throw new Error("The extension did not load.");
  }
  console.log("extension id:", extensionId);

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  const failures = [];

  /** Check a page and report the result. */
  async function check(name, url, expression, expectations) {
    await openPage(send, sessionId, url);
    const value = await evaluate(send, sessionId, expression);
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    console.log(`${name}:`, JSON.stringify(parsed));

    for (const [key, expected] of Object.entries(expectations)) {
      const actual = parsed[key];
      const ok = typeof expected === "function" ? expected(actual) : actual === expected;
      if (!ok) {
        failures.push(`${name}.${key} = ${JSON.stringify(actual)} (expected ${expected})`);
      }
    }
  }

  await check(
    "popup",
    `chrome-extension://${extensionId}/popup/popup.html`,
    `JSON.stringify({
      brand: document.querySelector('.brand__name')?.textContent,
      buttons: document.querySelectorAll('button').length,
      status: document.getElementById('status-dot')?.dataset.state,
    })`,
    { brand: "LookAtify", buttons: 3 },
  );

  await check(
    "options",
    `chrome-extension://${extensionId}/options/options.html`,
    `JSON.stringify({
      serverUrl: document.getElementById('server-url')?.value,
      mode: document.getElementById('default-mode')?.value,
      opacity: document.getElementById('default-opacity')?.value,
      colormap: document.getElementById('default-colormap')?.value,
      colormaps: document.querySelectorAll('#default-colormap option').length,
    })`,
    {
      serverUrl: "http://127.0.0.1:8001",
      mode: "blended",
      opacity: "55",
      colormap: "jet",
      colormaps: 5,
    },
  );

  await check(
    "viewer",
    `chrome-extension://${extensionId}/viewer/viewer.html`,
    `JSON.stringify({
      modes: document.querySelectorAll('[data-mode]').length,
      emptyHidden: document.getElementById('empty-state')?.hidden,
      error: document.getElementById('error-detail')?.textContent?.slice(0, 40),
      colormaps: document.querySelectorAll('#colormap option').length,
    })`,
    {
      modes: 4,
      colormaps: 5,
      // With no stored analysis the viewer hides the empty state and shows the
      // error state instead.
      emptyHidden: true,
    },
  );

  // Exercise the viewer reducer through the real module.
  const reducerCheck = await evaluate(
    send,
    sessionId,
    `(async () => {
       const m = await import(chrome.runtime.getURL('lib/state.js'));
       const s = m.createViewerState();
       const zoomed = m.applyViewerAction(s, { type: 'ZOOM_IN' });
       const split = m.applyViewerAction(s, { type: 'SET_MODE', mode: 'split' });
       return JSON.stringify({
         mode: split.mode,
         zoomedIn: zoomed.zoom > s.zoom,
         fit: m.fitScale({ contentWidth: 1000, contentHeight: 3000, viewportWidth: 500, viewportHeight: 500, mode: 'width' }),
       });
     })()`,
  );
  console.log("viewer reducer:", reducerCheck);
  const reducer = JSON.parse(reducerCheck);
  if (reducer.mode !== "split" || !reducer.zoomedIn || reducer.fit !== 0.5) {
    failures.push(`viewer reducer returned ${reducerCheck}`);
  }

  socket.close();
  killBrowser(chrome);
  rmSync(profileDir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error("FAILURES:");
    for (const failure of failures) console.error("  -", failure);
    process.exit(1);
  }
  console.log("ALL EXTENSION CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  killBrowser(chrome);
  rmSync(profileDir, { recursive: true, force: true });
  process.exit(1);
});
