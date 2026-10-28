/**
 * Check how the native canvas blur behaves at the edges of the map.
 *
 * `ctx.filter = blur(...)` samples the pixels outside the drawn image, which
 * are transparent. The border of the blurred result therefore fades out. On a
 * full-page heatmap that would put a dark frame around the whole page.
 *
 * This script measures the effect and compares three ways of doing the blur:
 *
 *   1. the plain native filter
 *   2. the native filter over a tiled, padded canvas (edge clamping)
 *   3. the old JavaScript kernel, which clamped to the edge
 *
 * Usage:
 *   node scripts/check-blur-edges.mjs [chromiumPath]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const profileDir = mkdtempSync(join(tmpdir(), "lookatify-edges-"));
const port = 9800 + Math.floor(Math.random() * 90);

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
      const W = 64, H = 64, SIGMA = 8;

      // A uniform mid-gray map, so any edge fade shows up as a dip in the value.
      function makeImageData() {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.createImageData(W, H);
        for (let i = 0; i < data.data.length; i += 4) {
          data.data[i] = 200; data.data[i+1] = 200; data.data[i+2] = 200; data.data[i+3] = 255;
        }
        ctx.putImageData(data, 0, 0);
        return data;
      }

      // 1. The plain native filter.
      function plainNative(data) {
        const src = document.createElement('canvas');
        src.width = W; src.height = H;
        src.getContext('2d').putImageData(data, 0, 0);
        const dst = document.createElement('canvas');
        dst.width = W; dst.height = H;
        const ctx = dst.getContext('2d');
        ctx.filter = 'blur(' + SIGMA + 'px)';
        ctx.drawImage(src, 0, 0);
        ctx.filter = 'none';
        return ctx.getImageData(0, 0, W, H);
      }

      // 2. The native filter over a tiled, padded canvas.
      function paddedNative(data) {
        const pad = Math.ceil(SIGMA * 3);
        const src = document.createElement('canvas');
        src.width = W; src.height = H;
        src.getContext('2d').putImageData(data, 0, 0);

        const big = document.createElement('canvas');
        big.width = W + pad * 2; big.height = H + pad * 2;
        const bctx = big.getContext('2d');
        // Tile the source nine times so the blur always has real neighbours.
        for (let ty = -1; ty <= 1; ty += 1) {
          for (let tx = -1; tx <= 1; tx += 1) {
            bctx.drawImage(src, pad + tx * W, pad + ty * H);
          }
        }

        const dst = document.createElement('canvas');
        dst.width = W + pad * 2; dst.height = H + pad * 2;
        const ctx = dst.getContext('2d');
        ctx.filter = 'blur(' + SIGMA + 'px)';
        ctx.drawImage(big, 0, 0);
        ctx.filter = 'none';
        return ctx.getImageData(pad, pad, W, H);
      }

      // 3. The old JavaScript kernel, which clamped to the edge.
      function jsBlur(data) {
        const radius = Math.max(1, Math.ceil(SIGMA * 3));
        const kernel = new Float32Array(radius * 2 + 1);
        let sum = 0;
        for (let o = -radius; o <= radius; o += 1) {
          const v = Math.exp(-(o * o) / (2 * SIGMA * SIGMA));
          kernel[o + radius] = v; sum += v;
        }
        for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;

        const src = new Uint8ClampedArray(data.data);
        const out = new Uint8ClampedArray(src.length);
        const horizontal = new Float32Array(src.length);
        for (let y = 0; y < H; y += 1) {
          for (let x = 0; x < W; x += 1) {
            let total = 0;
            for (let o = -radius; o <= radius; o += 1) {
              const sx = Math.min(W - 1, Math.max(0, x + o));
              total += src[(y * W + sx) * 4] * kernel[o + radius];
            }
            horizontal[(y * W + x) * 4] = total;
          }
        }
        for (let y = 0; y < H; y += 1) {
          for (let x = 0; x < W; x += 1) {
            let total = 0;
            for (let o = -radius; o <= radius; o += 1) {
              const sy = Math.min(H - 1, Math.max(0, y + o));
              total += horizontal[(sy * W + x) * 4] * kernel[o + radius];
            }
            out[(y * W + x) * 4] = total;
          }
        }
        for (let i = 0; i < out.length; i += 4) {
          out[i+1] = out[i]; out[i+2] = out[i]; out[i+3] = src[i+3];
        }
        return new ImageData(out, W, H);
      }

      // Sample the corners, the edges and the centre of each result.
      function sample(data) {
        const at = (x, y) => {
          const i = (y * W + x) * 4;
          return { gray: data.data[i], alpha: data.data[i+3] };
        };
        return {
          centre: at(32, 32),
          topLeft: at(0, 0),
          topMid: at(32, 0),
          leftMid: at(0, 32),
          bottomRight: at(W - 1, H - 1),
        };
      }

      const data = makeImageData();
      return JSON.stringify({
        plain: sample(plainNative(data)),
        padded: sample(paddedNative(data)),
        js: sample(jsBlur(data)),
      });
    })()`,
  );

  console.log("A uniform gray 200 map, blurred with sigma 8.\n");
  console.log("  expected: every sample should stay at gray 200, alpha 255\n");
  for (const [name, sample] of Object.entries(result)) {
    console.log(`  ${name}:`);
    for (const [where, value] of Object.entries(sample)) {
      const flag = value.gray < 190 || value.alpha < 250 ? "  <-- faded" : "";
      console.log(
        `    ${where.padEnd(13)} gray=${String(value.gray).padStart(3)} alpha=${String(value.alpha).padStart(3)}${flag}`,
      );
    }
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
