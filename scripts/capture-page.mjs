/**
 * Capture a full-page screenshot of a real URL with headless Chrome.
 *
 * Used to produce a realistic fixture for the saliency pipeline: a real
 * news page has the hero, headlines and footer that the synthetic test
 * pages only approximate.
 *
 * Usage:
 *   node scripts/capture-page.mjs <url> <output.png>
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const url = process.argv[2] || "https://www.bbc.com/";
const output = process.argv[3] || "/tmp/page.png";
const port = 9333;

const chrome = spawn(
  "/usr/bin/google-chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--remote-debugging-port=" + port,
    "--window-size=1440,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function endpoint() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // The browser is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chrome did not expose a debugging target");
}

const socket = new WebSocket(await endpoint());
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (message) =>
      message.error ? reject(new Error(message.error.message)) : resolve(message.result),
    );
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

await send("Page.navigate", { url });
await sleep(9000);

// Scroll through the page so lazy content loads, then return to the top.
const { result } = await send("Runtime.evaluate", {
  expression:
    "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)",
  returnByValue: true,
});
const pageHeight = result.value;
console.log("page height:", pageHeight);

for (let y = 0; y < pageHeight; y += 800) {
  await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${y})` });
  await sleep(250);
}
await send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
await sleep(1500);

const metrics = await send("Page.getLayoutMetrics");
const contentHeight = Math.ceil(metrics.cssContentSize.height);
console.log("content height:", contentHeight);

const shot = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: 1440, height: contentHeight, scale: 1 },
});
writeFileSync(output, Buffer.from(shot.data, "base64"));
console.log("wrote", output);

socket.close();
chrome.kill("SIGKILL");
process.exit(0);
