/**
 * Compare the stitched capture with the page itself.
 *
 * A few pixels of one colour survived the capture. The question is whether
 * they come from the page — in which case they are content, not a capture
 * fault — or from an overlay that was not hidden.
 *
 * This script captures the page with the real pipeline and then renders the
 * same region of the live page, so the two can be compared.
 *
 * Usage:
 *   node scripts/check-pixel-source.mjs [chromiumPath]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";
import { captureExpression } from "./capture-expression.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const fixture = resolve("scripts/fixtures/capture-problem-page.html");
const pageHtml = readFileSync(fixture, "utf-8");

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(pageHtml);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-source-"));
const port = 9350 + Math.floor(Math.random() * 90);

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

  const loaded = await send("Extensions.loadUnpacked", { path: resolve("extension") });
  const extensionId = loaded?.id;

  const { targetId } = await send("Target.createTarget", { url: pageUrl });
  const { sessionId: pageSession } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await send("Page.enable", {}, pageSession);
  await send("Runtime.enable", {}, pageSession);
  await new Promise((r) => setTimeout(r, 2000));

  // The capture, through the service worker.
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
  await send("Runtime.enable", {}, workerSession);

  const capture = await evaluate(
    send,
    workerSession,
    captureExpression(JSON.stringify(pageUrl)),
  );
  if (capture.error) throw new Error(capture.error);

  // What is at the position of the surviving pixels, in the live page?
  const source = await evaluate(
    send,
    pageSession,
    `(() => {
      const points = [[25, 1326], [35, 1326], [65, 1326], [81, 1337], [25, 3990]];

      // Find the element at each point.
      const found = points.map(([x, y]) => {
        const element = document.elementFromPoint(x, y - window.scrollY);
        return {
          x,
          y,
          tag: element ? element.tagName : null,
          id: element ? element.id : null,
          className: element ? element.className : null,
          text: element ? (element.textContent || '').slice(0, 40) : null,
        };
      });

      // Where is the review badge, and what does it look like?
      const badge = document.getElementById('review-badge');
      const rect = badge.getBoundingClientRect();

      return JSON.stringify({
        found,
        badgeRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      });
    })()`,
  );

  console.log("\nwhat is at the position of the surviving pixels:");
  console.log(source);

  socket.close();
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
