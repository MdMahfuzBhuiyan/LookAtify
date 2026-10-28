/**
 * Check that the viewer's heatmap shows a hotspot in every band of a page.
 *
 * The server sends a grayscale saliency map and the viewer paints it with
 * its own colormap and alpha ramp. A band of the page can therefore be
 * empty in the viewer even when the server's map is fine, so this checks
 * the pixels the viewer actually produces.
 *
 * The page is analysed for real, the saliency map is fetched from the
 * server, and the viewer's own colormap is applied to it.
 *
 * Usage:
 *   node scripts/check-viewer-bands.mjs [chromiumPath]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const fixture = resolve("scripts/fixtures/capture-problem-page.html");
const pageHtml = readFileSync(fixture, "utf-8");
const BANDS = 10;
const YELLOW = 0.55;

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(pageHtml);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
console.log("test page:", pageUrl);

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-bands-"));
const port = 9050 + Math.floor(Math.random() * 90);

const child = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--window-size=1280,900",
    "about:blank",
  ],
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

async function connect() {
  let browserUrl = null;
  for (let attempt = 0; attempt < 100 && !browserUrl; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) browserUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browserUrl) throw new Error(`Chromium did not start.\n${stderr.slice(-500)}`);

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

async function evaluate(send, sessionId, expression, timeout = 300000) {
  const response = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, timeout },
    sessionId,
  );
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "evaluation failed",
    );
  }
  const value = response.result?.value;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function main() {
  const { socket, send } = await connect();

  const loaded = await send("Extensions.loadUnpacked", { path: resolve("extension") });
  const extensionId = loaded?.id;
  console.log("extension id:", extensionId);

  // A long test page, so the bands are tall enough to judge.
  const longHtml = pageHtml.replace(
    "</body>",
    `<div style="height: 6000px; background: repeating-linear-gradient(180deg, #fff 0 200px, #eee 200px 400px)"></div>
     <h1 style="font-size: 90px">A headline at the bottom</h1>
     <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='400'%3E%3Crect width='800' height='400' fill='%23c33'/%3E%3C/svg%3E">
     </body>`,
  );

  const longServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(longHtml);
  });
  await new Promise((r) => longServer.listen(0, "127.0.0.1", r));
  const longUrl = `http://127.0.0.1:${longServer.address().port}/`;
  console.log("long test page:", longUrl);

  const { targetId } = await send("Target.createTarget", { url: longUrl });
  await send("Target.activateTarget", { targetId });
  await new Promise((r) => setTimeout(r, 1500));

  // The popup runs the analysis.
  const { targetId: popupTarget } = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  });
  const { sessionId: popupSession } = await send("Target.attachToTarget", {
    targetId: popupTarget,
    flatten: true,
  });
  await send("Runtime.enable", {}, popupSession);
  await new Promise((r) => setTimeout(r, 1200));

  await send("Target.activateTarget", { targetId });
  await new Promise((r) => setTimeout(r, 600));

  const analysis = await evaluate(
    send,
    popupSession,
    `(async () => {
      await chrome.storage.local.set({
        lookatify_settings: {
          serverUrl: 'http://127.0.0.1:8001',
          apiToken: '',
          defaultMode: 'blended',
          defaultOpacity: 0.55,
          defaultColormap: 'jet',
          defaultBlurSigma: 0,
          defaultThreshold: 0,
          maxCaptureHeight: 16000,
          requestTimeoutMs: 180000,
        },
      });

      const port = chrome.runtime.connect({ name: 'lookatify-capture' });
      const done = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'TIMEOUT' }), 280000);
        port.onMessage.addListener((event) => {
          if (event && (event.type === 'LOOKATIFY_DONE' || event.type === 'LOOKATIFY_ERROR')) {
            clearTimeout(timer);
            resolve(event);
          }
        });
        port.postMessage({ type: 'LOOKATIFY_ANALYZE', viewportOnly: false });
      });
      port.disconnect();
      return JSON.stringify({ type: done.type, message: done.message || null });
    })()`,
  );
  console.log("analysis:", analysis.type, analysis.message || "");

  if (analysis.type !== "LOOKATIFY_DONE") {
    throw new Error(`the analysis failed: ${analysis.message}`);
  }

  // The viewer is opened and its heatmap layer is inspected.
  const { targetId: viewerTarget } = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/viewer/viewer.html`,
  });
  const { sessionId: viewerSession } = await send("Target.attachToTarget", {
    targetId: viewerTarget,
    flatten: true,
  });
  await send("Runtime.enable", {}, viewerSession);
  await new Promise((r) => setTimeout(r, 6000));

  const bands = await evaluate(
    send,
    viewerSession,
    `(async () => {
      const canvas = document.getElementById('canvas');
      if (!canvas) return JSON.stringify({ error: 'the canvas is missing' });

      // The heatmap layer is the second canvas of the stage.
      const layers = Array.from(document.querySelectorAll('canvas'));
      const heatmap = layers[layers.length - 1];
      const context = heatmap.getContext('2d', { willReadFrequently: true });
      const data = context.getImageData(0, 0, heatmap.width, heatmap.height).data;

      // The alpha of the heatmap layer shows how strongly each pixel is
      // painted. The yellow band of the jet colormap starts at about 0.55
      // of the intensity, so a pixel counts as a hotspot when its colour is
      // in the yellow or red part of the map.
      const bandHeight = Math.floor(heatmap.height / ${BANDS});
      const rows = [];

      for (let band = 0; band < ${BANDS}; band += 1) {
        const top = band * bandHeight;
        const bottom = band === ${BANDS} - 1 ? heatmap.height : top + bandHeight;
        let maxIntensity = 0;
        let hotPixels = 0;
        let painted = 0;

        for (let y = top; y < bottom; y += 1) {
          for (let x = 0; x < heatmap.width; x += 1) {
            const index = (y * heatmap.width + x) * 4;
            const r = data[index];
            const g = data[index + 1];
            const b = data[index + 2];
            const a = data[index + 3];
            if (a < 8) continue;
            painted += 1;
            // The jet colormap turns from green to yellow to red.
            const intensity = Math.max(r, g, b);
            if (intensity > maxIntensity) maxIntensity = intensity;
            if (r > 170 && g > 120 && b < 140) hotPixels += 1;
          }
        }

        rows.push({
          band,
          maxIntensity: Math.round(maxIntensity),
          hotPixels,
          painted,
        });
      }

      return JSON.stringify({
        height: heatmap.height,
        width: heatmap.width,
        rows,
      });
    })()`,
  );

  console.log(`\nheatmap layer: ${bands.width}x${bands.height}`);
  console.log("  band  maxIntensity  hotPixels  painted");
  let invisible = 0;
  for (const row of bands.rows) {
    const visible = row.hotPixels > 0;
    if (!visible) invisible += 1;
    console.log(
      `  ${String(row.band).padStart(4)}  ${String(row.maxIntensity).padStart(11)}  ` +
        `${String(row.hotPixels).padStart(9)}  ${String(row.painted).padStart(7)}` +
        (visible ? "" : "   <-- no hotspot"),
    );
  }

  socket.close();

  if (invisible > 0) {
    console.error(`\n${invisible} band(s) have no hotspot in the viewer`);
    process.exit(1);
  }
  console.log("\nEVERY BAND HAS A HOTSPOT IN THE VIEWER");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    killBrowser(child);
    rmSync(profileDir, { recursive: true, force: true });
    pageServer.close();
    process.exit(process.exitCode ?? 0);
  });
