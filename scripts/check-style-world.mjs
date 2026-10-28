/**
 * Find out whether a style element created in the isolated world reaches the
 * page.
 *
 * The capture hides the fixed elements with a style rule. During the capture
 * the marker attribute was set and the style element was in the document, but
 * the elements were still painted.
 *
 * The content script runs in the isolated world, while the browser paints
 * the main world. This measures what actually crosses the boundary:
 *
 *   1. a style element with an attribute selector
 *   2. an inline style on the element
 *   3. an inline style marked as important
 *
 * The result is read back from the main world, which is the world the
 * browser paints.
 *
 * Usage:
 *   node scripts/check-style-world.mjs [chromiumPath]
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";

const binary = resolve(process.argv[2] || "/usr/bin/google-chrome");

const PAGE = `<!doctype html>
<html><head><style>
  #widget { position: fixed; width: 100px; height: 100px; background: red; }
  #important { position: fixed; width: 100px; height: 100px; background: red; visibility: visible !important; }
  #animated { width: 100px; height: 100px; background: red; animation: spin 2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body>
  <div id="widget">widget</div>
  <div id="important">important</div>
  <div id="animated">animated</div>
</body></html>`;

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(PAGE);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
console.log("test page:", pageUrl);

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-world-"));
const port = 9400 + Math.floor(Math.random() * 90);

const child = spawnBrowser(
  binary,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
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

async function evaluate(send, sessionId, expression) {
  const response = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, timeout: 60000 },
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
  await new Promise((r) => setTimeout(r, 1500));

  // The isolated world: this is where a content script runs.
  const isolated = await send("Target.createTarget", { url: pageUrl });
  const { sessionId: isolatedSession } = await send("Target.attachToTarget", {
    targetId: isolated.targetId,
    flatten: true,
  });
  await send("Runtime.enable", {}, isolatedSession);
  await new Promise((r) => setTimeout(r, 800));

  // Inject into the isolated world, the way a content script does.
  const injected = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      const style = document.createElement('style');
      style.textContent = '[data-hidden] { visibility: hidden !important; }';
      document.head.appendChild(style);
      document.getElementById('widget').setAttribute('data-hidden', '');

      document.getElementById('important').style.setProperty('visibility', 'hidden', 'important');
      document.getElementById('important').setAttribute('data-hidden', '');

      const animStyle = document.createElement('style');
      animStyle.textContent = '*, *::before, *::after { animation: none !important; }';
      document.head.appendChild(animStyle);
    `,
  });

  await send("Page.reload", {}, isolatedSession);
  await new Promise((r) => setTimeout(r, 1200));

  // Read the result from the main world, which is the world the browser
  // paints.
  const result = await evaluate(
    send,
    pageSession,
    `(() => {
      const widget = document.getElementById('widget');
      const important = document.getElementById('important');
      const animated = document.getElementById('animated');
      return JSON.stringify({
        viaStyleElement: getComputedStyle(widget).visibility,
        viaInlineImportant: getComputedStyle(important).visibility,
        animationName: getComputedStyle(animated).animationName,
        attribute: widget.getAttribute('data-hidden'),
      });
    })()`,
  );

  console.log("\nresult, read from the main world:");
  console.log(result);

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
