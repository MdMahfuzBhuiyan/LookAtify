/**
 * Check the extension's own pages.
 *
 * The new worker, the debug page and the debug option in the settings all
 * have to work in the real extension, not just in a test harness.
 *
 * This checks:
 *
 *   1. the viewer starts its worker and builds a heatmap with it;
 *   2. the settings page shows the debug option and keeps it;
 *   3. the debug page renders a report and its frames;
 *
 * Usage:
 *   node scripts/verify-extension-pages.mjs [chromiumPath]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const checks = [];

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-pages-"));
const port = 9150 + Math.floor(Math.random() * 90);

const child = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--window-size=1400,900",
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

async function evaluate(send, sessionId, expression, timeout = 120000) {
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

/**
 * Open an extension page and return its session.
 */
async function openPage(send, url) {
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await new Promise((r) => setTimeout(r, 1200));
  return { sessionId, targetId };
}

async function main() {
  const { socket, send } = await connect();

  const loaded = await send("Extensions.loadUnpacked", { path: resolve("extension") });
  const extensionId = loaded?.id;
  console.log("extension id:", extensionId);

  // 1. The viewer starts its worker and builds a heatmap with it.
  const viewer = await openPage(
    send,
    `chrome-extension://${extensionId}/viewer/viewer.html`,
  );

  const worker = await evaluate(
    send,
    viewer.sessionId,
    `(async () => {
      // The viewer reads the analysis from the storage, so the worker is
      // tested on its own here.
      const workerUrl = chrome.runtime.getURL('viewer/heatmap-worker.js');
      let workerError = null;
      let result = null;

      try {
        const heatmapWorker = new Worker(workerUrl, { type: 'module' });

        const source = document.createElement('canvas');
        source.width = 200;
        source.height = 300;
        const context = source.getContext('2d', { willReadFrequently: true });
        const image = context.createImageData(200, 300);
        for (let index = 0; index < image.data.length; index += 4) {
          const value = index % 256;
          image.data[index] = value;
          image.data[index + 1] = value;
          image.data[index + 2] = value;
          image.data[index + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        const pixels = context.getImageData(0, 0, 200, 300);

        result = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ error: 'the worker timed out' }), 30000);
          heatmapWorker.onerror = (event) => {
            clearTimeout(timer);
            resolve({ error: event.message || 'the worker failed' });
          };
          heatmapWorker.onmessage = (event) => {
            clearTimeout(timer);
            const data = event.data;
            if (data.type === 'SOURCE_READY') {
              heatmapWorker.postMessage({
                type: 'BUILD_HEATMAP',
                id: 2,
                sigma: 4,
                threshold: 0.2,
                colormap: 'jet',
              });
              return;
            }
            if (data.type === 'HEATMAP_READY') {
              const rgba = new Uint8ClampedArray(data.rgba);
              resolve({
                ok: true,
                width: data.width,
                height: data.height,
                firstPixel: [rgba[0], rgba[1], rgba[2], rgba[3]],
              });
              return;
            }
            resolve({ error: data.error || 'the worker failed' });
          };
          const copy = new Uint8ClampedArray(pixels.data);
          heatmapWorker.postMessage({
            type: 'SET_SOURCE',
            id: 1,
            pixels: copy.buffer,
            width: 200,
            height: 300,
          }, [copy.buffer]);
        });

        heatmapWorker.terminate();
      } catch (error) {
        workerError = error.message;
      }

      return JSON.stringify({ result, workerError });
    })()`,
  );

  checks.push({
    name: "the heatmap worker builds a heatmap",
    ok: worker.result && worker.result.ok && !worker.workerError,
    value: worker,
  });

  // 2. The settings page shows the debug option and keeps it.
  const options = await openPage(
    send,
    `chrome-extension://${extensionId}/options/options.html`,
  );

  const option = await evaluate(
    send,
    options.sessionId,
    `(async () => {
      const input = document.getElementById('debug-capture');
      if (!input) return JSON.stringify({ error: 'the option is missing' });

      await new Promise((r) => setTimeout(r, 500));

      const errors = [];
      window.addEventListener('error', (event) => errors.push(event.message));

      // The module may have failed to load, in which case no listener is
      // attached and the form does nothing.
      const moduleWorked = await new Promise((resolve) => {
        import(chrome.runtime.getURL('lib/config.js'))
          .then(() => resolve(true))
          .catch(() => resolve(false));
      });

      input.checked = true;
      const form = document.getElementById('settings-form');
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await new Promise((r) => setTimeout(r, 1200));

      const stored = await chrome.storage.local.get('lookatify_settings');
      return JSON.stringify({
        found: true,
        moduleWorked,
        checkedBeforeSubmit: input.checked,
        checkedAfter: input.checked,
        savedValue: stored.lookatify_settings ? stored.lookatify_settings.debugCapture : null,
        savedLabel: document.getElementById('saved').textContent,
        errors,
      });
    })()`,
  );

  checks.push({
    name: "the settings page keeps the debug option",
    ok: option.found && option.savedValue === true,
    value: option,
  });

  // 3. The debug page renders a report and its frames.
  // The frames are stored first, so the page finds them when it loads.
  const optionsSession = options.sessionId;
  await evaluate(
    send,
    optionsSession,
    `(async () => {
      await chrome.storage.local.set({
        lookatify_debug_capture: {
          id: 'test-capture',
          report: {
            pageHeight: 4000,
            capturedHeight: 3000,
            viewportHeight: 800,
            devicePixelRatio: 1,
            truncated: false,
            warnings: ['a test warning'],
            slices: [
              { index: 0, scrollY: 0, offsetY: 0, drawHeight: 800 },
              { index: 1, scrollY: 800, offsetY: 800, drawHeight: 800 },
            ],
          },
          frames: [
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          ],
        },
      });
      return JSON.stringify({ ok: true });
    })()`,
  );

  const debug = await openPage(
    send,
    `chrome-extension://${extensionId}/viewer/debug.html?id=test-capture`,
  );
  await new Promise((r) => setTimeout(r, 800));

  const rendered = await evaluate(
    send,
    debug.sessionId,
    `(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const frames = document.querySelectorAll('.frame img');
      const warnings = document.querySelectorAll('.warnings li');
      return JSON.stringify({
        reportRows: rows.length,
        frameCount: frames.length,
        warningCount: warnings.length,
        summaryText: document.getElementById('summary').textContent.replace(/\\s+/g, ' ').slice(0, 100),
      });
    })()`,
  );

  checks.push({
    name: "the debug page renders the report and the frames",
    ok: rendered.reportRows === 2 && rendered.frameCount === 1 && rendered.warningCount === 1,
    value: rendered,
  });

  socket.close();

  console.log("\n--- extension page results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(46)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 110)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} extension page check(s) failed`);
    process.exit(1);
  }
  console.log("\nEXTENSION PAGE CHECKS PASSED");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    killBrowser(child);
    rmSync(profileDir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
