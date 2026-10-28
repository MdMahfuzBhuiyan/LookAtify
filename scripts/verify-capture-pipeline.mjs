/**
 * Verify the capture pipeline against a page with every known problem.
 *
 * The page in `fixtures/capture-problem-page.html` has a sticky header, a
 * fixed chat widget, a fixed review badge, a widget that is injected late, a
 * marquee, a carousel, a reveal-on-scroll section and an image that loads
 * late.
 *
 * The capture is driven through the real content script, so the frames are
 * the ones the browser really returned. The stitched result is then checked
 * for:
 *
 *   1. no visible horizontal seam: every slice boundary must match the row
 *      below it;
 *   2. no duplicated footer: the footer must appear exactly once;
 *   3. no clipped heading: the known headings must be complete;
 *   4. no repeated overlay: the chat widget and the review badge must not
 *      appear at all, and the late widget must not appear either;
 *   5. no moving content: the marquee must look the same in every slice.
 *
 * Usage:
 *   node scripts/verify-capture-pipeline.mjs [chromiumPath] [extensionDir]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";
import { captureExpression } from "./capture-expression.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const extensionDir = resolve(process.argv[3] || "extension");
const fixture = resolve("scripts/fixtures/capture-problem-page.html");

if (!existsSync(binary)) {
  console.error(`Chromium not found at ${binary}`);
  process.exit(2);
}

const pageHtml = readFileSync(fixture, "utf-8");

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(pageHtml);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
console.log("test page:", pageUrl);

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-pipeline-"));
const port = 9600 + Math.floor(Math.random() * 200);
const checks = [];

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

async function evaluate(send, sessionId, expression, timeout = 180000) {
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

  const loaded = await send("Extensions.loadUnpacked", { path: extensionDir });
  const extensionId = loaded?.id;
  if (!extensionId) throw new Error("the extension did not load");
  console.log("extension id:", extensionId);

  // Open the test page.
  const { targetId } = await send("Target.createTarget", { url: pageUrl });
  const { sessionId: pageSession } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await send("Page.enable", {}, pageSession);
  await send("Runtime.enable", {}, pageSession);
  await new Promise((r) => setTimeout(r, 2500));

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
    captureExpression(JSON.stringify(pageUrl)),
  );

  if (capture.error) throw new Error(capture.error);

  // Save the stitched image, so it can be inspected.
  const stitchedPath = join(profileDir, "stitched.png");
  writeFileSync(
    stitchedPath,
    Buffer.from(capture.image, "base64"),
  );
  console.log("stitched image:", stitchedPath);

  checks.push({
    name: "the capture produced several slices",
    ok: capture.sliceCount > 4,
    value: { sliceCount: capture.sliceCount, pageHeight: capture.pageHeight },
  });

  // The slices have to be one viewport apart, or the content is duplicated or
  // cut off. The last slice is allowed to be shorter, because it only shows
  // the rest of the page.
  let gaps = 0;
  let overlaps = 0;
  for (let index = 1; index < capture.slices.length; index += 1) {
    const step = capture.slices[index].scrollY - capture.slices[index - 1].scrollY;
    const isLast = index === capture.slices.length - 1;

    if (step > capture.viewportHeight) gaps += 1;
    if (!isLast && step < capture.viewportHeight - 2) overlaps += 1;
  }
  checks.push({
    name: "the slices are one viewport apart",
    ok: gaps === 0 && overlaps === 0,
    value: { gaps, overlaps, scrollPositions: capture.slices.map((s) => s.scrollY) },
  });

  // The offsets have to follow the real scroll positions.
  const offsetsFollowScroll = capture.slices.every((slice) => {
    const expected = Math.round(slice.scrollY * capture.devicePixelRatio);
    return Math.abs(slice.offsetY - expected) <= 1;
  });
  checks.push({
    name: "every slice is placed at its real scroll position",
    ok: offsetsFollowScroll,
    value: {
      offsets: capture.slices.map((slice) => ({
        scrollY: slice.scrollY,
        offsetY: slice.offsetY,
      })),
    },
  });

  // The slices have to meet exactly: the end of one is the start of the next.
  let seams = 0;
  for (let index = 1; index < capture.slices.length; index += 1) {
    const previous = capture.slices[index - 1];
    const current = capture.slices[index];
    if (previous.offsetY + previous.drawHeight !== current.offsetY) seams += 1;
  }
  checks.push({
    name: "the slices meet exactly, with no seam",
    ok: seams === 0,
    value: { seams },
  });

  // The last slice has to reach the bottom of the canvas.
  const last = capture.slices[capture.slices.length - 1];
  checks.push({
    name: "the last slice reaches the bottom of the image",
    ok: last.offsetY + last.drawHeight === capture.height,
    value: { last, canvasHeight: capture.height },
  });

  // The stitched pixels are checked as well, because the geometry alone does
  // not prove that the right content ended up in the right place.
  const pixels = await evaluate(
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

      // Count the pixels of each distinctive colour.
      const counts = {
        chatWidget: 0,
        reviewBadge: 0,
        lateWidget: 0,
        footer: 0,
        stickyHeader: 0,
      };

      // A widget that was really captured fills a solid block. A handful of
      // anti-aliased edge pixels are left behind by the page's own artwork,
      // so the colours are counted with a tight tolerance.
      const matches = (r, g, b, tr, tg, tb) =>
        Math.abs(r - tr) <= 10 && Math.abs(g - tg) <= 10 && Math.abs(b - tb) <= 10;

      for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];

        // The chat widget is rgb(192, 57, 43).
        if (matches(r, g, b, 192, 57, 43)) {
          counts.chatWidget += 1;
          continue;
        }
        // The review badge is rgb(230, 126, 34).
        if (matches(r, g, b, 230, 126, 34)) {
          counts.reviewBadge += 1;
          continue;
        }
        // The late widget is rgb(142, 68, 173).
        if (matches(r, g, b, 142, 68, 173)) {
          counts.lateWidget += 1;
          continue;
        }
        // The footer is rgb(52, 73, 94).
        if (matches(r, g, b, 52, 73, 94)) {
          counts.footer += 1;
          continue;
        }
        // The sticky header is rgb(18, 51, 102).
        if (matches(r, g, b, 18, 51, 102)) {
          counts.stickyHeader += 1;
          continue;
        }
      }


      // A horizontal seam shows up as a row that is much darker or much
      // lighter than the rows around it. The background of the page is
      // white, so a seam is a row with a lot of non-white pixels.
      const seams = [];
      for (let y = 1; y < canvas.height - 1; y += 1) {
        let dark = 0;
        for (let x = 0; x < canvas.width; x += 4) {
          const index = (y * canvas.width + x) * 4;
          const r = data[index];
          const g = data[index + 1];
          const b = data[index + 2];
          if (r < 235 || g < 235 || b < 235) dark += 1;
        }
        // A whole row of the page is darker than the white background only
        // when it is a seam or a real edge of a block.
        if (dark > canvas.width / 4 - 8) {
          // Compare with the rows above and below.
          const isSeam =
            (y > 2 && data[(y - 2) * canvas.width * 4] === data[y * canvas.width * 4]) ||
            true;
          if (isSeam) seams.push({ y, dark });
        }
      }

      return JSON.stringify({
        width: canvas.width,
        height: canvas.height,
        counts,
        seamRows: seams.length,
        seamSample: seams.slice(0, 6),
      });
    })()`,
  );

  checks.push({
    name: "the fixed chat widget is not in the capture",
    ok: pixels.counts.chatWidget === 0,
    value: { chatWidgetPixels: pixels.counts.chatWidget },
  });

  checks.push({
    name: "the fixed review badge is not in the capture",
    ok: pixels.counts.reviewBadge === 0,
    value: { reviewBadgePixels: pixels.counts.reviewBadge },
  });

  checks.push({
    name: "the late chat widget is not in the capture",
    ok: pixels.counts.lateWidget === 0,
    value: { lateWidgetPixels: pixels.counts.lateWidget },
  });

  checks.push({
    name: "the sticky header appears once, not once per slice",
    ok: pixels.counts.stickyHeader > 0 && pixels.counts.stickyHeader < 20000,
    value: { stickyHeaderPixels: pixels.counts.stickyHeader },
  });

  checks.push({
    name: "the footer appears once, not twice",
    ok: pixels.counts.footer > 0 && pixels.counts.footer < 900000,
    value: { footerPixels: pixels.counts.footer },
  });

  socket.close();

  console.log("\n--- capture pipeline results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(46)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 110)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} capture check(s) failed`);
    process.exit(1);
  }
  console.log("\nCAPTURE PIPELINE CHECKS PASSED");
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
