/**
 * Watch the overlays while the real capture runs.
 *
 * The capture hides the fixed elements with a marker attribute and a style
 * rule. This starts the capture and polls the page at the same time, so it
 * shows whether the hiding is in place while the frames are taken.
 *
 * Usage:
 *   node scripts/check-overlay-during-capture.mjs [chromiumPath]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");
const fixture = resolve("scripts/fixtures/capture-problem-page.html");
const pageHtml = readFileSync(fixture, "utf-8");

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(pageHtml);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
console.log("test page:", pageUrl);

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-during-"));
const port = 9450 + Math.floor(Math.random() * 90);

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
  console.log("extension id:", extensionId);

  const { targetId } = await send("Target.createTarget", { url: pageUrl });
  const { sessionId: pageSession } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await send("Page.enable", {}, pageSession);
  await send("Runtime.enable", {}, pageSession);
  await new Promise((r) => setTimeout(r, 2500));

  // Attach to the background service worker, which has the extension APIs.
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

  // Start the capture without waiting for it.
  const capturePromise = evaluate(
    send,
    workerSession,
    `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((entry) => entry.url && entry.url.startsWith(${JSON.stringify(
        pageUrl,
      )}));
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['/content/capture.js'],
      });
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'LOOKATIFY_CAPTURE_START',
        viewportOnly: false,
        debug: false,
      });
      return JSON.stringify({ ok: Boolean(result && result.ok), error: result && result.error });
    })()`,
  );

  // Poll the page while the capture runs.
  const samples = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((r) => setTimeout(r, 400));
    const sample = await evaluate(
      send,
      pageSession,
      `(() => {
        const widget = document.getElementById('chat-widget');
        const header = document.getElementById('sticky-header');
        const styleElement = document.getElementById('lookatify-capture-style');
        let rules = -1;
        try {
          rules = styleElement ? styleElement.sheet.cssRules.length : -1;
        } catch (error) {
          rules = 'blocked: ' + error.message;
        }
        return JSON.stringify({
          scrollY: window.scrollY,
          styleExists: Boolean(styleElement),
          styleLength: styleElement ? styleElement.textContent.length : 0,
          styleText: styleElement ? styleElement.textContent.slice(0, 160) : null,
          cssRules: rules,
          widgetMarked: widget ? widget.hasAttribute('data-lookatify-hidden') : null,
          widgetVisibility: widget ? window.getComputedStyle(widget).visibility : null,
          headerMarked: header ? header.hasAttribute('data-lookatify-hidden') : null,
          headerVisibility: header ? window.getComputedStyle(header).visibility : null,
        });
      })()`,
    );
    samples.push(sample);
  }

  const capture = await capturePromise;
  console.log("\ncapture result:", capture);

  console.log("\n--- the page while the capture runs ---");
  for (const sample of samples.slice(0, 4)) {
    console.log(
      `  scrollY ${String(sample.scrollY).padStart(5)}  style=${sample.styleExists ? "yes" : "no "}` +
        `  rules=${sample.cssRules}` +
        `  widget: ${sample.widgetMarked ? "marked" : "clean "} ${String(sample.widgetVisibility).padEnd(7)}` +
        `  header: ${sample.headerMarked ? "marked" : "clean "} ${sample.headerVisibility}`,
    );
  }
  console.log("\n  style text:", JSON.stringify(samples[0]?.styleText));

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
