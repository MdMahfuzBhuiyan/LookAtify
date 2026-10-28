/**
 * Check that the viewer stays responsive while the blur and threshold sliders
 * are moved.
 *
 * The bug this guards against: the heatmap was rebuilt on the main thread on
 * every slider tick. On a full-page map the JavaScript blur took seconds, so
 * the whole tab froze and the sliders appeared to hang.
 *
 * This drives the real production modules in Chrome and measures:
 *
 *   1. how long the main thread is blocked during a rebuild
 *   2. whether the worker path produces the same result as the main thread
 *   3. how long a worker round trip takes
 *
 * The extension directory is served over HTTP, because a module worker
 * cannot be loaded from a `file://` page.
 *
 * Usage:
 *   node scripts/check-viewer-responsiveness.mjs [chromiumPath]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const extensionDir = resolve("extension");

const MIME_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Serve the extension directory so its modules can be imported. */
function startServer() {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    const filePath = join(extensionDir, path);

    if (!filePath.startsWith(extensionDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(readFileSync(filePath));
  });

  return new Promise((resolve_) => {
    server.listen(0, "127.0.0.1", () => {
      resolve_({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
      });
    });
  });
}

const server = await startServer();

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-viewer-"));
const port = 9400 + Math.floor(Math.random() * 90);

const chrome = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1400,900",
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
  const server = await startServer();
  const { socket, send } = await connect();

  const { targetId } = await send("Target.createTarget", { url: `${server.origin}/viewer/` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  // A page that loads the real modules.
  await send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        window.chrome = {
          storage: { local: { get: async () => ({}), set: async () => {} } },
          runtime: { getURL: (path) => path },
        };
      `,
    },
    sessionId,
  );

  await send("Page.navigate", { url: `${server.origin}/viewer/` }, sessionId);
  await new Promise((r) => setTimeout(r, 800));

  const result = await evaluateJson(
    send,
    sessionId,
    `(async () => {
      const WIDTH = 1440;
      const HEIGHT = 13316;

      const colormaps = await import('/lib/colormaps.js');

      // A realistic saliency map.
      const source = document.createElement('canvas');
      source.width = WIDTH;
      source.height = HEIGHT;
      const sctx = source.getContext('2d', { willReadFrequently: true });
      const imageData = sctx.createImageData(WIDTH, HEIGHT);
      for (let i = 0; i < imageData.data.length; i += 4) {
        const row = Math.floor((i / 4) / WIDTH);
        const band = (row % 900 < 60) ? 220 : 30 + ((row * 7) % 60);
        imageData.data[i] = band;
        imageData.data[i+1] = band;
        imageData.data[i+2] = band;
        imageData.data[i+3] = 255;
      }
      sctx.putImageData(imageData, 0, 0);
      const pixels = sctx.getImageData(0, 0, WIDTH, HEIGHT);

      // How long the main thread is blocked, measured from inside a timer.
      // A free main thread keeps these gaps small.
      let gaps = [];
      let last = performance.now();
      let running = true;
      const tick = () => {
        if (!running) return;
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        setTimeout(tick, 16);
      };
      setTimeout(tick, 16);

      /** Start measuring the main-thread stalls from now. */
      const resetGaps = () => {
        gaps = [];
        last = performance.now();
      };

      // The old JavaScript blur, for comparison.
      function jsBlur(data, sigma) {
        const radius = Math.max(1, Math.ceil(sigma * 3));
        const kernel = new Float32Array(radius * 2 + 1);
        let sum = 0;
        for (let o = -radius; o <= radius; o += 1) {
          const v = Math.exp(-(o * o) / (2 * sigma * sigma));
          kernel[o + radius] = v; sum += v;
        }
        for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;

        const src = new Uint8ClampedArray(data.data);
        const out = new Uint8ClampedArray(src.length);
        const horizontal = new Float32Array(src.length);
        for (let y = 0; y < HEIGHT; y += 1) {
          for (let x = 0; x < WIDTH; x += 1) {
            let total = 0;
            for (let o = -radius; o <= radius; o += 1) {
              const sx = Math.min(WIDTH - 1, Math.max(0, x + o));
              total += src[(y * WIDTH + sx) * 4] * kernel[o + radius];
            }
            horizontal[(y * WIDTH + x) * 4] = total;
          }
        }
        for (let y = 0; y < HEIGHT; y += 1) {
          for (let x = 0; x < WIDTH; x += 1) {
            let total = 0;
            for (let o = -radius; o <= radius; o += 1) {
              const sy = Math.min(HEIGHT - 1, Math.max(0, y + o));
              total += horizontal[(sy * WIDTH + x) * 4] * kernel[o + radius];
            }
            out[(y * WIDTH + x) * 4] = total;
          }
        }
        for (let i = 0; i < out.length; i += 4) {
          out[i+1] = out[i]; out[i+2] = out[i]; out[i+3] = src[i+3];
        }
        return new ImageData(out, WIDTH, HEIGHT);
      }

      const timings = {};

      // The old way, on the main thread. This is the baseline the test
      // measures against, so the stall counter is reset afterwards.
      let start = performance.now();
      jsBlur(pixels, 4);
      timings.oldJsBlurSigma4 = Math.round(performance.now() - start);

      // The new way, on the main thread.
      start = performance.now();
      colormaps.blurGrayscale(pixels, 4);
      timings.nativeBlurSigma4 = Math.round(performance.now() - start);

      // From here on the main thread must stay free: the worker does the work.
      resetGaps();

      // The new way, in the worker.
      const worker = new Worker('/viewer/heatmap-worker.js', { type: 'module' });
      const workerReady = await new Promise((resolve) => {
        const id = 1;
        const handler = (event) => {
          if (event.data?.id !== id) return;
          worker.removeEventListener('message', handler);
          resolve(event.data);
        };
        worker.addEventListener('message', handler);
        const copy = new Uint8ClampedArray(pixels.data);
        worker.postMessage({
          type: 'SET_SOURCE', id,
          pixels: copy.buffer, width: WIDTH, height: HEIGHT,
        }, [copy.buffer]);
      });
      timings.sourceAccepted = workerReady.type === 'SOURCE_READY';

      // Build through the worker and time the round trip.
      start = performance.now();
      const built = await new Promise((resolve) => {
        const id = 2;
        const handler = (event) => {
          if (event.data?.id !== id) return;
          worker.removeEventListener('message', handler);
          resolve(event.data);
        };
        worker.addEventListener('message', handler);
        worker.postMessage({
          type: 'BUILD_HEATMAP', id, sigma: 4, threshold: 0.2, colormap: 'jet',
        });
      });
      timings.workerRoundTrip = Math.round(performance.now() - start);
      timings.workerOk = built.type === 'HEATMAP_READY';

      // The worker result must match the main-thread result.
      const mainBlurred = colormaps.blurGrayscale(pixels, 4);
      const mainResult = colormaps.applyColormap(
        colormaps.applyThreshold(mainBlurred, 0.2), 'jet');
      const workerResult = new Uint8ClampedArray(built.rgba);
      let maxDiff = 0;
      for (let i = 0; i < mainResult.length; i += 4) {
        const d = Math.abs(mainResult[i] - workerResult[i]);
        if (d > maxDiff) maxDiff = d;
      }
      timings.workerMatchesMainThread = maxDiff;

      // How long the main thread was blocked during all of this.
      running = false;
      const maxGap = Math.max(...gaps);
      timings.maxMainThreadGap = Math.round(maxGap);
      timings.gapCount = gaps.length;

      worker.terminate();
      return JSON.stringify({ timings });
    })()`,
  );

  const t = result.timings;
  console.log(`map: 1440 x 13316 (19,175,040 pixels)\n`);
  console.log("  timings:");
  console.log(`    old JS blur sigma 4 (main thread): ${String(t.oldJsBlurSigma4).padStart(6)} ms   <- the freeze`);
  console.log(`    new native blur sigma 4:          ${String(t.nativeBlurSigma4).padStart(6)} ms`);
  console.log(`    worker round trip:                 ${String(t.workerRoundTrip).padStart(6)} ms`);
  console.log(`    worker took the source:            ${t.sourceAccepted}`);
  console.log(`    worker produced a heatmap:         ${t.workerOk}`);
  console.log(`    worker vs main thread, max diff:   ${t.workerMatchesMainThread} (0 means identical)`);
  console.log(`    longest main-thread stall:         ${String(t.maxMainThreadGap).padStart(6)} ms`);
  console.log(`    timer ticks observed:              ${t.gapCount}`);

  const speedup = t.oldJsBlurSigma4 / t.nativeBlurSigma4;
  console.log(`\n  speedup at sigma 4: ${speedup.toFixed(1)}x`);

  let failed = 0;
  if (!t.workerOk) {
    console.error("\nFAIL: the worker did not produce a heatmap");
    failed += 1;
  }
  if (t.workerMatchesMainThread !== 0) {
    console.error(`\nFAIL: the worker result differs from the main thread (${t.workerMatchesMainThread})`);
    failed += 1;
  }
  if (t.maxMainThreadGap > 1500) {
    console.error(`\nFAIL: the main thread stalled for ${t.maxMainThreadGap} ms`);
    failed += 1;
  }

  socket.close();
  if (failed > 0) process.exit(1);

  // The keep-alive sockets of the fetch calls and the HTTP server hold the
  // event loop open, so the process is ended explicitly.
  console.log("\nVIEWER RESPONSIVENESS CHECKS PASSED");
  process.exit(0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    killBrowser(chrome);
    rmSync(profileDir, { recursive: true, force: true });
    server.close();
  });
