/**
 * Measure the cost of the viewer's heatmap rebuild.
 *
 * The blur and threshold sliders rebuild the whole heatmap on every input
 * event. On a long page that map has ~19 million pixels, and the old pure
 * JavaScript blur did about 7 billion operations per tick, which froze
 * the viewer.
 *
 * This script measures the candidates in a real browser:
 *
 *   1. the old JavaScript blur
 *   2. the native canvas blur (`ctx.filter`)
 *   3. the threshold and colormap pass over the pixels
 *
 * Usage:
 *   node scripts/benchmark-heatmap.mjs [chromiumPath]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");

/** A page that looks like a long one. */
const PAGE = `<!doctype html><html><body style="margin:0"><canvas id="c"></canvas></body></html>`;

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-bench-"));
const port = 9900 + Math.floor(Math.random() * 90);

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

      // A grayscale saliency map of the real size.
      const source = document.createElement('canvas');
      source.width = WIDTH;
      source.height = HEIGHT;
      const sctx = source.getContext('2d', { willReadFrequently: true });
      const imageData = sctx.createImageData(WIDTH, HEIGHT);
      for (let i = 0; i < imageData.data.length; i += 4) {
        const v = (i * 2654435761) % 256;
        imageData.data[i] = v;
        imageData.data[i + 1] = v;
        imageData.data[i + 2] = v;
        imageData.data[i + 3] = 255;
      }
      sctx.putImageData(imageData, 0, 0);
      const pixels = sctx.getImageData(0, 0, WIDTH, HEIGHT);

      // 1. The old JavaScript blur.
      function jsBlur(data, sigma) {
        const radius = Math.max(1, Math.ceil(sigma * 3));
        const kernel = new Float32Array(radius * 2 + 1);
        let sum = 0;
        for (let o = -radius; o <= radius; o += 1) {
          const v = Math.exp(-(o * o) / (2 * sigma * sigma));
          kernel[o + radius] = v;
          sum += v;
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
          out[i + 1] = out[i];
          out[i + 2] = out[i];
          out[i + 3] = src[i + 3];
        }
        return new ImageData(out, WIDTH, HEIGHT);
      }

      // 2. The native canvas blur.
      function nativeBlur(data, sigma) {
        const source2 = document.createElement('canvas');
        source2.width = WIDTH;
        source2.height = HEIGHT;
        source2.getContext('2d').putImageData(data, 0, 0);

        const target = document.createElement('canvas');
        target.width = WIDTH;
        target.height = HEIGHT;
        const tctx = target.getContext('2d');
        tctx.filter = 'blur(' + sigma + 'px)';
        tctx.drawImage(source2, 0, 0);
        tctx.filter = 'none';
        return tctx.getImageData(0, 0, WIDTH, HEIGHT);
      }

      // 3. The threshold and colormap pass.
      function thresholdAndColormap(data, threshold) {
        const out = new Uint8ClampedArray(data.data);
        const cutoff = Math.round(threshold * 255);
        for (let i = 0; i < out.length; i += 4) {
          if (out[i] < cutoff) {
            out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
          } else {
            out[i + 3] = out[i];
          }
        }
        return new ImageData(out, WIDTH, HEIGHT);
      }

      const time = (label, fn) => {
        const start = performance.now();
        fn();
        return { label, ms: Math.round(performance.now() - start) };
      };

      const results = [];
      // The JavaScript blur is only measured at a small sigma; at sigma 30 it
      // takes minutes, which is exactly the freeze the users reported.
      results.push(time('js blur sigma 2', () => jsBlur(pixels, 2)));
      results.push(time('js blur sigma 8', () => jsBlur(pixels, 8)));
      results.push(time('native blur sigma 2', () => nativeBlur(pixels, 2)));
      results.push(time('native blur sigma 8', () => nativeBlur(pixels, 8)));
      results.push(time('native blur sigma 30', () => nativeBlur(pixels, 30)));
      results.push(time('threshold + colormap', () => thresholdAndColormap(pixels, 0.2)));

      return JSON.stringify({ pixels: WIDTH * HEIGHT, results });
    })()`,
  );

  console.log(`map: ${result.pixels.toLocaleString()} pixels\n`);
  for (const entry of result.results) {
    console.log(`  ${entry.label.padEnd(26)} ${String(entry.ms).padStart(7)} ms`);
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
