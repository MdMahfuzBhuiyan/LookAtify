/**
 * Check whether the heatmap blur can run in a worker.
 *
 * The native canvas blur takes about 0.4 seconds for a full-page map, which
 * still blocks the viewer. A worker would keep the interface responsive.
 *
 * This checks that the pieces a worker needs are actually available:
 *
 *   1. OffscreenCanvas in a worker
 *   2. the canvas `filter` property on an OffscreenCanvas context
 *   3. getImageData and putImageData on an OffscreenCanvas context
 *   4. how long the whole rebuild takes in the worker
 *
 * Usage:
 *   node scripts/check-heatmap-worker.mjs [chromiumPath]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const profileDir = mkdtempSync(join(tmpdir(), "lookatify-worker-"));
const port = 9600 + Math.floor(Math.random() * 90);

const chrome = spawnBrowser(
  binary,
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

async function evaluateJson(send, sessionId, expression) {
  const response = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, timeout: 300000 },
    sessionId,
  );
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || "failed");
  }
  const value = response.result?.value;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function main() {
  const { socket, send } = await connect();

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  const result = await evaluateJson(
    send,
    sessionId,
    `(async () => {
      const WIDTH = 1440;
      const HEIGHT = 13316;

      // The worker source, as a blob so this test needs no server.
      const workerSource = \`
        self.onmessage = (event) => {
          const { pixels, sigma, threshold } = event.data;
          const width = pixels.width;
          const height = pixels.height;

          const source = new OffscreenCanvas(width, height);
          const sctx = source.getContext('2d', { willReadFrequently: true });
          sctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), width, height), 0, 0);

          const padding = Math.ceil(sigma * 3);
          const padded = new OffscreenCanvas(width + padding * 2, height + padding * 2);
          const pctx = padded.getContext('2d');
          pctx.drawImage(source, padding, padding);
          pctx.drawImage(source, 0, 0, width, 1, padding, 0, width, padding);
          pctx.drawImage(source, 0, height - 1, width, 1, padding, padding + height, width, padding);
          pctx.drawImage(source, 0, 0, 1, height, 0, padding, padding, height);
          pctx.drawImage(source, width - 1, 0, 1, height, padding + width, padding, padding, height);
          pctx.drawImage(source, 0, 0, 1, 1, 0, 0, padding, padding);
          pctx.drawImage(source, width - 1, 0, 1, 1, padding + width, 0, padding, padding);
          pctx.drawImage(source, 0, height - 1, 1, 1, 0, padding + height, padding, padding);
          pctx.drawImage(source, width - 1, height - 1, 1, 1, padding + width, padding + height, padding, padding);

          const target = new OffscreenCanvas(padded.width, padded.height);
          const tctx = target.getContext('2d');
          tctx.filter = 'blur(' + sigma + 'px)';
          tctx.drawImage(padded, 0, 0);
          tctx.filter = 'none';

          const blurred = tctx.getImageData(padding, padding, width, height);

          // Threshold and colormap in the same pass.
          const cutoff = Math.round(threshold * 255);
          const out = new Uint8ClampedArray(blurred.data.length);
          for (let i = 0; i < blurred.data.length; i += 4) {
            const gray = blurred.data[i];
            if (gray < cutoff) { out[i] = 0; out[i+1] = 0; out[i+2] = 0; out[i+3] = 0; }
            else { out[i] = gray; out[i+1] = gray; out[i+2] = gray; out[i+3] = gray; }
          }
          self.postMessage({ out: out.buffer, width, height, ms: performance.now() });
        };
      \`;

      const supportsOffscreen = typeof OffscreenCanvas !== 'undefined';
      const supportsWorker = typeof Worker !== 'undefined';

      // Build a realistic map on the main thread and hand it to the worker.
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.createImageData(WIDTH, HEIGHT);
      for (let i = 0; i < imageData.data.length; i += 4) {
        const v = 40 + ((i * 2654435761) % 180);
        imageData.data[i] = v; imageData.data[i+1] = v; imageData.data[i+2] = v; imageData.data[i+3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
      const source = ctx.getImageData(0, 0, WIDTH, HEIGHT);

      if (!supportsOffscreen || !supportsWorker) {
        return JSON.stringify({ supportsOffscreen, supportsWorker, ok: false, error: 'not available' });
      }

      const blob = new Blob([workerSource], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'worker timed out' }), 60000);
        worker.onerror = (event) => {
          clearTimeout(timer);
          resolve({ ok: false, error: 'worker error: ' + (event.message || 'unknown') });
        };
        worker.onmessage = (event) => {
          clearTimeout(timer);
          const data = event.data;
          // Check the worker actually produced a blurred, padded image.
          const out = new Uint8ClampedArray(data.out);
          const at = (x, y) => {
            const i = (y * data.width + x) * 4;
            return { gray: out[i], alpha: out[i+3] };
          };
          resolve({
            ok: true,
            ms: Math.round(data.ms),
            centre: at(720, 6600),
            topLeft: at(0, 0),
            bottomRight: at(WIDTH - 1, HEIGHT - 1),
          });
        };
        const start = performance.now();
        worker.postMessage({
          pixels: { data: source.data.buffer, width: WIDTH, height: HEIGHT },
          sigma: 8,
          threshold: 0.2,
        });
        worker.__start = start;
      });

      worker.terminate();
      URL.revokeObjectURL(url);
      return JSON.stringify({ supportsOffscreen, supportsWorker, ...result });
    })()`,
  );

  console.log("Worker feasibility:\n");
  console.log(`  OffscreenCanvas available: ${result.supportsOffscreen}`);
  console.log(`  Worker available:          ${result.supportsWorker}`);
  console.log(`  result ok:                 ${result.ok}`);
  if (result.error) {
    console.log(`  error:                     ${result.error}`);
  } else {
    console.log(`  worker round trip:         ${result.ms} ms`);
    console.log(`  centre sample:             gray=${result.centre.gray} alpha=${result.centre.alpha}`);
    console.log(`  topLeft sample:            gray=${result.topLeft.gray} alpha=${result.topLeft.alpha}`);
    console.log(`  bottomRight sample:        gray=${result.bottomRight.gray} alpha=${result.bottomRight.alpha}`);
  }

  socket.close();
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
