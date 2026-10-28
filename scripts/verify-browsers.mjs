/**
 * Cross-browser compatibility check for the LookAtify extension.
 *
 * Runs the same checks against every Chromium-based browser that is
 * installed and reports which ones pass:
 *
 *   - the extension loads
 *   - the popup, options and viewer pages render
 *
 * Firefox is checked separately by `verify-firefox.mjs`, because it needs
 * geckodriver and a different installation mechanism.
 *
 * Usage:
 *   node scripts/verify-browsers.mjs [extensionDir]
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killBrowser, spawnBrowser } from "./browser-process.mjs";
import { findBrave, findChromium } from "./browser-paths.mjs";

const extensionDir = resolve(process.argv[2] || "extension");

/** The Chromium-based browsers to test. */
const BROWSERS = [
  { name: "Chromium", binary: findChromium() },
  { name: "Chrome", binary: "/usr/bin/google-chrome" },
  { name: "Brave", binary: findBrave() },
];

/**
 * Start a browser and wait for its DevTools endpoint.
 *
 * @param {Object} browser
 * @param {string} profileDir
 * @param {number} port
 * @returns {Promise<import("node:child_process").ChildProcess>}
 */
async function launch(browser, profileDir, port) {
  const child = spawnBrowser(
    browser.binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return child;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  killBrowser(child);
  throw new Error(`${browser.name} did not start.\n${stderr.slice(-400)}`);
}

/**
 * Load the unpacked extension over the DevTools protocol.
 *
 * Chrome 137 and newer ignore the `--load-extension` command line switch, so
 * the extension is installed through CDP instead, which every Chromium build
 * supports.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} port
 * @returns {Promise<string|null>} The extension id.
 */
async function loadExtension(port) {
  const { socket, send } = await connect(port);
  try {
    // The CDP reply is { id, result: { id: "<extension id>" } } and the
    // connection helper already unwraps the outer result.
    const response = await send("Extensions.loadUnpacked", { path: extensionDir });
    return response?.id ?? null;
  } finally {
    socket.close();
  }
}

/**
 * Find the extension's service worker and read its id.
 *
 * @param {number} port
 * @returns {Promise<string|null>}
 */
async function findExtensionId(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const match = targets.find(
        (target) =>
          target.url.includes("/background/service-worker.js") ||
          target.url.includes("/background.html"),
      );
      if (match) return new URL(match.url).host;
    } catch {
      // Not ready yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * Connect to the DevTools endpoint.
 *
 * @param {number} port
 */
async function connect(port) {
  const browserUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
    .webSocketDebuggerUrl;
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
      pending.get(message.id)(message.result ?? message.error);
      pending.delete(message.id);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve_, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        if (result?.error) reject(new Error(`${method}: ${result.error.message}`));
        else resolve_(result);
      });
      socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });

  return { socket, send };
}

/**
 * Navigate and let the page settle.
 */
async function openPage(send, sessionId, url, settleMs = 2000) {
  await send("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, settleMs));
}

/**
 * Evaluate an expression in the page.
 */
async function evaluate(send, sessionId, expression) {
  const result = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "evaluation failed");
  }
  return result.result?.value;
}

/**
 * Run the checks against one browser.
 *
 * @param {Object} browser
 */
async function testBrowser(browser) {
  if (!existsSync(browser.binary)) {
    return { name: browser.name, status: "skipped", reason: "not installed" };
  }

  const profileDir = mkdtempSync(join(tmpdir(), `lookatify-${browser.name}-`));
  const port = 9200 + Math.floor(Math.random() * 500);
  let child;

  try {
    child = await launch(browser, profileDir, port);

    let extensionId = null;
    try {
      extensionId = await loadExtension(port);
    } catch (error) {
      // Older builds allow the command line switch, so that is the fallback.
      extensionId = await findExtensionId(port);
      if (!extensionId) {
        return {
          name: browser.name,
          status: "failed",
          reason: `the extension did not load (${error.message})`,
        };
      }
    }

    // The service worker target confirms that the background code is running.
    const workerId = await findExtensionId(port);
    if (!workerId) {
      return {
        name: browser.name,
        status: "failed",
        reason: "the background service worker did not start",
      };
    }
    extensionId = extensionId ?? workerId;

    const { socket, send } = await connect(port);
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);

    const checks = [];
    const origin = `chrome-extension://${extensionId}`;

    // The popup.
    await openPage(send, sessionId, `${origin}/popup/popup.html`);
    const popup = JSON.parse(
      await evaluate(
        send,
        sessionId,
        `JSON.stringify({
           brand: document.querySelector('.brand__name')?.textContent ?? null,
           buttons: document.querySelectorAll('button').length,
           title: document.title,
         })`,
      ),
    );
    checks.push({
      name: "popup",
      ok: popup.brand === "LookAtify" && popup.buttons > 0,
      value: popup,
    });

    // The options page.
    await openPage(send, sessionId, `${origin}/options/options.html`);
    const options = JSON.parse(
      await evaluate(
        send,
        sessionId,
        `JSON.stringify({
           serverUrl: document.getElementById('server-url')?.value ?? null,
           colormaps: document.querySelectorAll('#default-colormap option').length,
         })`,
      ),
    );
    checks.push({
      name: "options",
      ok: options.colormaps === 5 && typeof options.serverUrl === "string",
      value: options,
    });

    // The viewer.
    await openPage(send, sessionId, `${origin}/viewer/viewer.html`);
    const viewer = JSON.parse(
      await evaluate(
        send,
        sessionId,
        `JSON.stringify({
           modes: document.querySelectorAll('[data-mode]').length,
           title: document.title,
           // Every element that carries the hidden attribute has to be out
           // of sight. A stylesheet rule that sets "display" beats the
           // user-agent rule for the attribute, which left the loading
           // overlay on top of the canvas for good.
           hiddenLeaks: Array.from(document.querySelectorAll('[hidden]'))
             .filter((element) => getComputedStyle(element).display !== 'none')
             .map((element) => element.id || element.className),
         })`,
      ),
    );
    checks.push({
      name: "viewer",
      ok: viewer.modes === 4 && viewer.hiddenLeaks.length === 0,
      value: viewer,
    });

    // The extension's storage and commands have to work.
    const storage = JSON.parse(
      await evaluate(
        send,
        sessionId,
        `(async () => {
           await chrome.storage.local.set({ lookatify_test: 'value' });
           const stored = await chrome.storage.local.get('lookatify_test');
           await chrome.storage.local.remove('lookatify_test');
           const cleared = await chrome.storage.local.get('lookatify_test');
           return JSON.stringify({
             ok: stored.lookatify_test === 'value' && !cleared.lookatify_test,
             hasCommands: typeof chrome.commands?.onCommand !== 'undefined',
             hasTabsCreate: typeof chrome.tabs?.create === 'function',
             hasAction: typeof chrome.action !== 'undefined',
           });
         })()`,
      ),
    );
    checks.push({
      name: "storage and commands",
      ok: storage.ok === true && storage.hasCommands === true,
      value: storage,
    });

    socket.close();

    const passed = checks.filter((check) => check.ok).length;
    return {
      name: browser.name,
      status: passed === checks.length ? "passed" : "failed",
      extensionId,
      checks,
      passed,
      total: checks.length,
      reason:
        passed === checks.length
          ? undefined
          : checks
              .filter((check) => !check.ok)
              .map((check) => `${check.name}: ${JSON.stringify(check.value).slice(0, 120)}`)
              .join("; "),
    };
  } catch (error) {
    return { name: browser.name, status: "failed", reason: error.message };
  } finally {
    killBrowser(child);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

/**
 * Run a test with a hard timeout, so a browser that hangs cannot stall the
 * whole run.
 *
 * @param {Function} fn
 * @param {number} ms
 */
async function withTimeout(fn, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), guard]);
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const browser of BROWSERS) {
  process.stdout.write(`Testing ${browser.name}... `);
  const result = await withTimeout(() => testBrowser(browser), 120000);
  results.push(result);

  if (result.status === "passed") {
    console.log(`PASSED (${result.passed}/${result.total})`);
    for (const check of result.checks) {
      if (!check.ok) console.log(`  ${check.name}: ${JSON.stringify(check.value).slice(0, 200)}`);
    }
  }
  else if (result.status === "skipped") console.log(`SKIPPED (${result.reason})`);
  else console.log(`FAILED (${result.reason})`);
}

console.log("\n--- summary ---");
for (const result of results) {
  const detail =
    result.status === "passed"
      ? `${result.passed}/${result.total} checks`
      : (result.reason ?? "");
  console.log(`${result.name.padEnd(10)} ${result.status.padEnd(8)} ${detail}`);
}

const failed = results.filter((result) => result.status === "failed");
process.exit(failed.length > 0 ? 1 : 0);
