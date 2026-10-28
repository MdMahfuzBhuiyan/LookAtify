/**
 * Minimal Chrome DevTools Protocol driver used to verify the LookAtify UI.
 *
 * It launches headless Chrome, navigates to a page, waits for the page to
 * signal readiness, evaluates JavaScript and captures a screenshot.
 *
 * Usage:
 *   node scripts/verify-ui.mjs <url> <output.png> [waitForExpression] [width] [height]
 */

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const url = process.argv[2];
const output = process.argv[3];
const waitFor = process.argv[4] || "document.readyState === 'complete'";
const width = Number(process.argv[5] || 1400);
const height = Number(process.argv[6] || 900);

if (!url || !output) {
  console.error("Usage: node scripts/verify-ui.mjs <url> <output.png> [waitFor] [w] [h]");
  process.exit(1);
}

const userDataDir = mkdtempSync(join(tmpdir(), "lookatify-cdp-"));
const port = 9222 + Math.floor(Math.random() * 500);

const chrome = spawnBrowser(
  "google-chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
);

let chromeStderr = "";
chrome.stderr.on("data", (chunk) => {
  chromeStderr += chunk.toString();
});

/** Wait until the DevTools endpoint answers. */
async function waitForDevTools() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {
      // The browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not start.\n${chromeStderr.slice(-500)}`);
}

/** Send one CDP command and wait for its reply. */
function send(socket, method, params = {}, sessionId) {
  const id = send.nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      send.pending.delete(id);
      reject(new Error(`CDP timeout for ${method}`));
    }, 30000);

    send.pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    socket.send(JSON.stringify(message));
  });
}
send.nextId = 1;
send.pending = new Map();

async function main() {
  const browserUrl = await waitForDevTools();

  const socket = new WebSocket(browserUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && send.pending.has(message.id)) {
      const resolve = send.pending.get(message.id);
      send.pending.delete(message.id);
      resolve(message.result);
    }
  });

  const { targetId } = await send(socket, "Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send(socket, "Target.attachToTarget", { targetId, flatten: true });

  await send(socket, "Page.enable", {}, sessionId);
  await send(socket, "Runtime.enable", {}, sessionId);
  await send(socket, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);

  await send(socket, "Page.navigate", { url }, sessionId);

  // Poll until the page signals that it is ready.
  const deadline = Date.now() + 45000;
  let ready = false;
  let lastError = null;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const result = await send(socket, "Runtime.evaluate", {
        expression: waitFor,
        returnByValue: true,
        awaitPromise: true,
      }, sessionId);
      if (result.result && result.result.value === true) {
        ready = true;
        break;
      }
      lastError = result.exceptionDetails
        ? result.exceptionDetails.text
        : null;
    } catch (error) {
      lastError = error.message;
    }
  }

  if (!ready) {
    console.error(`Page never became ready (${lastError ?? "timeout"}).`);
    const errors = await send(socket, "Runtime.evaluate", {
      expression: "JSON.stringify(window.__errors || [])",
      returnByValue: true,
    }, sessionId);
    console.error("Captured errors:", errors.result?.value);
    socket.close();
    killBrowser(chrome);
    process.exit(2);
  }

  const screenshot = await send(socket, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  }, sessionId);

  writeFileSync(output, Buffer.from(screenshot.data, "base64"));
  console.log(`Saved ${output}`);

  socket.close();
  killBrowser(chrome);
}

main().catch((error) => {
  console.error(error);
  killBrowser(chrome);
  process.exit(1);
});
