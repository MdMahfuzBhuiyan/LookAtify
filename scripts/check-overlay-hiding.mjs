/**
 * Check that the capture style really hides the overlays.
 *
 * The capture hides the fixed elements with a marker attribute and a style
 * rule. This checks that the rule reaches the element, and that the browser
 * really paints the element as hidden.
 *
 * Usage:
 *   node scripts/check-overlay-hiding.mjs [chromiumPath]
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
console.log("test page:", pageUrl);

const profileDir = mkdtempSync(join(tmpdir(), "lookatify-overlay-"));
const port = 9500 + Math.floor(Math.random() * 90);

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

  // The state of the overlays, before the capture touches anything.
  const before = await evaluate(
    send,
    pageSession,
    `(() => {
      const widget = document.getElementById('chat-widget');
      const style = window.getComputedStyle(widget);
      return JSON.stringify({
        position: style.position,
        visibility: style.visibility,
        hasAttribute: widget.hasAttribute('data-lookatify-hidden'),
        rect: widget.getBoundingClientRect().toJSON(),
        styleElementExists: Boolean(document.getElementById('lookatify-capture-style')),
      });
    })()`,
  );
  console.log("\nbefore the capture:", before);

  // Run the capture, and report the state of the overlays while it runs.
  const during = await evaluate(
    send,
    pageSession,
    `(async () => {
      const stitch = await import('${`chrome-extension://${extensionId}/lib/stitch.js`}');
      const widget = document.getElementById('chat-widget');

      const style = document.createElement('style');
      style.id = 'lookatify-capture-style';
      style.textContent = stitch.captureStyleText();
      document.head.appendChild(style);

      stitch.hideStickyElements([{ element: widget, position: 'fixed', visibility: '' }]);

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const computed = window.getComputedStyle(widget);
      return JSON.stringify({
        attribute: widget.getAttribute('data-lookatify-hidden'),
        hasAttribute: widget.hasAttribute('data-lookatify-hidden'),
        visibility: computed.visibility,
        display: computed.display,
        opacity: computed.opacity,
        styleText: stitch.captureStyleText(),
      });
    })()`,
  );
  console.log("\nafter hiding:", during);

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
