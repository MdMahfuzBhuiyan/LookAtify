/**
 * Compare the ways of padding the map for the native blur.
 *
 * The native canvas blur samples the pixels outside the drawn area, which
 * are transparent, so the border of the result fades out. The map therefore
 * has to be padded with edge-extended pixels first.
 *
 * This measures the cost of the candidates on a realistic full-page map:
 *
 *   1. plain     — no padding (fast, but the edges fade)
 *   2. tiled     — the whole source drawn nine or more times
 *   3. edgeOnly  — only the border strips are repeated
 *
 * Usage:
 *   node scripts/benchmark-blur-padding.mjs [chromiumPath]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const profileDir = mkdtempSync(join(tmpdir(), "lookatify-pad-"));
const port = 9700 + Math.floor(Math.random() * 90);

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

      const source = document.createElement('canvas');
      source.width = WIDTH;
      source.height = HEIGHT;
      const sctx = source.getContext('2d', { willReadFrequently: true });
      const imageData = sctx.createImageData(WIDTH, HEIGHT);
      for (let i = 0; i < imageData.data.length; i += 4) {
        const v = 40 + ((i * 2654435761) % 180);
        imageData.data[i] = v; imageData.data[i+1] = v; imageData.data[i+2] = v; imageData.data[i+3] = 255;
      }
      sctx.putImageData(imageData, 0, 0);

      // 1. No padding.
      function plain(sigma) {
        const dst = document.createElement('canvas');
        dst.width = WIDTH; dst.height = HEIGHT;
        const ctx = dst.getContext('2d');
        ctx.filter = 'blur(' + sigma + 'px)';
        ctx.drawImage(source, 0, 0);
        ctx.filter = 'none';
        return ctx.getImageData(0, 0, WIDTH, HEIGHT);
      }

      // 2. Padding by tiling the whole source.
      function tiled(sigma) {
        const padding = Math.ceil(sigma * 3);
        const padded = document.createElement('canvas');
        padded.width = WIDTH + padding * 2;
        padded.height = HEIGHT + padding * 2;
        const pctx = padded.getContext('2d');
        const hTiles = Math.ceil(padding / WIDTH) + 1;
        const vTiles = Math.ceil(padding / HEIGHT) + 1;
        for (let ty = -vTiles; ty <= vTiles; ty += 1) {
          for (let tx = -hTiles; tx <= hTiles; tx += 1) {
            pctx.drawImage(source, padding + tx * WIDTH, padding + ty * HEIGHT);
          }
        }
        const dst = document.createElement('canvas');
        dst.width = padded.width; dst.height = padded.height;
        const ctx = dst.getContext('2d');
        ctx.filter = 'blur(' + sigma + 'px)';
        ctx.drawImage(padded, 0, 0);
        ctx.filter = 'none';
        return ctx.getImageData(padding, padding, WIDTH, HEIGHT);
      }

      // 3. Padding by repeating only the border strips.
      function edgeOnly(sigma) {
        const padding = Math.ceil(sigma * 3);
        const padded = document.createElement('canvas');
        padded.width = WIDTH + padding * 2;
        padded.height = HEIGHT + padding * 2;
        const pctx = padded.getContext('2d');

        // The image itself.
        pctx.drawImage(source, padding, padding);
        // The top and bottom rows, stretched out.
        pctx.drawImage(source, 0, 0, WIDTH, 1, padding, 0, WIDTH, padding);
        pctx.drawImage(source, 0, HEIGHT - 1, WIDTH, 1, padding, padding + HEIGHT, WIDTH, padding);
        // The left and right columns, stretched out.
        pctx.drawImage(source, 0, 0, 1, HEIGHT, 0, padding, padding, HEIGHT);
        pctx.drawImage(source, WIDTH - 1, 0, 1, HEIGHT, padding + WIDTH, padding, padding, HEIGHT);
        // The four corners.
        pctx.drawImage(source, 0, 0, 1, 1, 0, 0, padding, padding);
        pctx.drawImage(source, WIDTH - 1, 0, 1, 1, padding + WIDTH, 0, padding, padding);
        pctx.drawImage(source, 0, HEIGHT - 1, 1, 1, 0, padding + HEIGHT, padding, padding);
        pctx.drawImage(source, WIDTH - 1, HEIGHT - 1, 1, 1, padding + WIDTH, padding + HEIGHT, padding, padding);

        const dst = document.createElement('canvas');
        dst.width = padded.width; dst.height = padded.height;
        const ctx = dst.getContext('2d');
        ctx.filter = 'blur(' + sigma + 'px)';
        ctx.drawImage(padded, 0, 0);
        ctx.filter = 'none';
        return ctx.getImageData(padding, padding, WIDTH, HEIGHT);
      }

      const time = (fn) => {
        const start = performance.now();
        fn();
        return { ms: Math.round(performance.now() - start) };
      };

      const results = [];
      for (const sigma of [2, 8, 30]) {
        results.push({ label: 'plain    sigma ' + sigma, ...time(() => plain(sigma)) });
        results.push({ label: 'tiled    sigma ' + sigma, ...time(() => tiled(sigma)) });
        results.push({ label: 'edgeOnly sigma ' + sigma, ...time(() => edgeOnly(sigma)) });
      }

      // Check that the edge-only padding matches the tiled padding.
      const a = tiled(8);
      const b = edgeOnly(8);
      let maxDiff = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d = Math.abs(a.data[i] - b.data[i]);
        if (d > maxDiff) maxDiff = d;
      }

      // Check that the edge-only padding keeps the border opaque.
      const at = (data, x, y) => {
        const i = (y * WIDTH + x) * 4;
        return { gray: data.data[i], alpha: data.data[i + 3] };
      };
      const borders = {
        topLeft: at(b, 0, 0),
        topMid: at(b, 720, 0),
        leftMid: at(b, 0, 6000),
        bottomRight: at(b, WIDTH - 1, HEIGHT - 1),
      };

      return JSON.stringify({ results, maxDiff, borders });
    })()`,
  );

  console.log(`map: 1440 x 13316\n`);
  for (const entry of result.results) {
    console.log(`  ${entry.label.padEnd(20)} ${String(entry.ms).padStart(6)} ms`);
  }
  console.log(
    `\n  edgeOnly vs tiled, max gray difference: ${result.maxDiff} (0 means identical)`,
  );
  console.log("  edgeOnly border samples (alpha must be 255):");
  for (const [where, value] of Object.entries(result.borders)) {
    const flag = value.alpha < 250 ? "  <-- faded" : "";
    console.log(
      `    ${where.padEnd(13)} gray=${String(value.gray).padStart(3)} alpha=${String(value.alpha).padStart(3)}${flag}`,
    );
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
