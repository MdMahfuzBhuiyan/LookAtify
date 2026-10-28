/**
 * Check the stitched capture of a real page for horizontal seams.
 *
 * The seams came from the slice offsets: a slice that was one pixel too long,
 * or placed at the wrong position, shows up as a faint horizontal line across
 * the whole page.
 *
 * This captures a real page through the extension, stitches it with the real
 * code, and then looks for rows that stand out from the rows around them.
 *
 * Usage:
 *   node scripts/check-seams-on-real-page.mjs [chromiumPath] [url]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";
import { captureExpression } from "./capture-expression.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const targetUrl = process.argv[3] || "https://www.bbc.com/";
const checks = [];

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-seams-"));
const port = 9200 + Math.floor(Math.random() * 90);

const child = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--window-size=1440,900",
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

  const { targetId } = await send("Target.createTarget", { url: targetUrl });
  const { sessionId: pageSession } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await send("Page.enable", {}, pageSession);
  await send("Runtime.enable", {}, pageSession);
  await new Promise((r) => setTimeout(r, 6000));

  // Attach to the background service worker.
  let workerSession = null;
  for (let attempt = 0; attempt < 40 && !workerSession; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const worker = targets.find(
      (target) => target.type === "service_worker" && target.url.includes(extensionId),
    );
    if (worker) {
      const attached = await send("Target.attachToTarget", {
        targetId: worker.id,
        flatten: true,
      });
      workerSession = attached.sessionId;
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!workerSession) throw new Error("the background service worker did not start");
  await send("Runtime.enable", {}, workerSession);

  const capture = await evaluate(
    send,
    workerSession,
    captureExpression(JSON.stringify(targetUrl)),
  );
  if (capture.error) throw new Error(capture.error);

  const stitchedPath = join(profileDir, "stitched.png");
  writeFileSync(stitchedPath, Buffer.from(capture.image, "base64"));
  console.log("stitched image:", stitchedPath);
  console.log(
    `page ${capture.pageHeight}px, ${capture.sliceCount} slices, canvas ${capture.width}x${capture.height}`,
  );

  // The seams are looked for in the stitched pixels.
  const seams = await evaluate(
    send,
    pageSession,
    `(async () => {
      const image = new Image();
      image.src = 'data:image/png;base64,${capture.image}';
      await image.decode();

      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

      // The brightness of every row.
      const rows = new Float64Array(canvas.height);
      for (let y = 0; y < canvas.height; y += 1) {
        let total = 0;
        for (let x = 0; x < canvas.width; x += 1) {
          const index = (y * canvas.width + x) * 4;
          total += (data[index] + data[index + 1] + data[index + 2]) / 3;
        }
        rows[y] = total / canvas.width;
      }

      // A seam is a row whose brightness differs sharply from the rows on
      // both sides of it. Real content changes gradually, a seam does not.
      const found = [];
      for (let y = 1; y < canvas.height - 1; y += 1) {
        const before = rows[y - 1];
        const after = rows[y + 1];
        const jump = Math.abs(before - after);
        const level = Math.abs(rows[y] - (before + after) / 2);
        if (jump > 30 && level > 12) {
          found.push({ y, jump: Math.round(jump), level: Math.round(level) });
        }
      }

      return JSON.stringify({
        height: canvas.height,
        seamCount: found.length,
        seams: found.slice(0, 12),
      });
    })()`,
  );

  console.log(`\nseam rows found: ${seams.seamCount}`);
  for (const seam of seams.seams) {
    console.log(`  y=${seam.y}  jump=${seam.jump}  level=${seam.level}`);
  }

  // The rows where the slices meet are the ones that matter.
  const boundaries = capture.slices.slice(1).map((slice) => slice.offsetY);
  const seamsAtBoundaries = seams.seams.filter((seam) =>
    boundaries.some((boundary) => Math.abs(boundary - seam.y) <= 2),
  );

  checks.push({
    name: "no seam at a slice boundary",
    ok: seamsAtBoundaries.length === 0,
    value: { seamsAtBoundaries, boundaries },
  });

  checks.push({
    name: "the slice offsets follow the real scroll positions",
    ok: capture.slices.every((slice) => {
      const expected = Math.round(slice.scrollY * capture.devicePixelRatio);
      return Math.abs(slice.offsetY - expected) <= 1;
    }),
    value: {
      offsets: capture.slices.map((slice) => ({
        scrollY: slice.scrollY,
        offsetY: slice.offsetY,
      })),
    },
  });

  socket.close();

  console.log("\n--- seam results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(46)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 110)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} seam check(s) failed`);
    process.exit(1);
  }
  console.log("\nSEAM CHECKS PASSED");
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
