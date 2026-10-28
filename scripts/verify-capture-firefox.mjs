/**
 * End-to-end capture test for the LookAtify extension in Firefox.
 *
 * Firefox is driven through geckodriver, and the extension is installed as a
 * temporary add-on. The test exercises the capture pipeline, which relies on
 * `browser.tabs.captureVisibleTab`, `browser.scripting.executeScript` and
 * dynamic imports inside a content script — the APIs that differ most
 * between Chromium and Gecko.
 *
 * Usage:
 *   node scripts/verify-capture-firefox.mjs [extensionDir] [geckodriver] [firefox]
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findFirefox, findGeckodriver } from "./browser-paths.mjs";

const extensionDir = resolve(process.argv[2] || "extension");
const geckodriverPath = process.argv[3] || findGeckodriver();
const firefoxPath = process.argv[4] || findFirefox();

/** The pinned internal origin of the extension. */
const EXTENSION_UUID = "9c2f4e17-6b83-4d5a-9e01-7f4c2b8d6a30";

const TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>LookAtify capture test</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  nav { position: sticky; top: 0; padding: 16px 24px; color: #fff; background: #241f23; }
  header { padding: 48px 24px; }
  h1 { margin: 0 0 12px; font-size: 38px; }
  .hero { height: 500px; margin: 24px; background: linear-gradient(120deg, #d7e3f0, #7fa8d0); }
  section { padding: 36px 24px; border-top: 1px solid #eee; }
  footer { padding: 60px 24px; color: #999; background: #241f23; }
</style></head>
<body>
  <nav>nav</nav>
  <header><h1>Capture test</h1><p>Subtitle copy.</p></header>
  <div class="hero"></div>
  <section><h2>One</h2><p>Copy.</p></section>
  <section><h2>Two</h2><p>Copy.</p></section>
  <section><h2>Three</h2><p>Copy.</p></section>
  <footer>footer</footer>
</body></html>`;

/**
 * Build the Firefox flavour of the extension.
 *
 * @param {string} target
 */
function buildAddon(target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(extensionDir)) {
    if (entry === "tests" || entry.startsWith(".")) continue;
    cpSync(join(extensionDir, entry), join(target, entry), { recursive: true });
  }

  // A source directory holds a Chrome manifest as well, so the Firefox
  // manifest has to be written afterwards. A build directory already has
  // the Firefox manifest in place.
  const firefoxManifest = join(extensionDir, "manifest.firefox.json");
  if (existsSync(firefoxManifest)) {
    const manifest = JSON.parse(readFileSync(firefoxManifest, "utf8"));
    writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest));
  }
  return target;
}

/**
 * A small WebDriver HTTP client.
 */
class WebDriver {
  constructor(base) {
    this.base = base;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { value: text };
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    return payload?.value;
  }

  async newSession(capabilities) {
    const value = await this.request("POST", "/session", capabilities);
    return value?.sessionId ?? value;
  }

  deleteSession(id) {
    return this.request("DELETE", `/session/${id}`);
  }

  navigate(id, url) {
    return this.request("POST", `/session/${id}/url`, { url });
  }

  /**
   * Open a new tab and select it, so the next navigation lands in it.
   */
  async newTab(id) {
    const created = await this.request("POST", `/session/${id}/window/new`, { type: "tab" });
    const handle = created?.handle ?? created;
    await this.request("POST", `/session/${id}/window`, { handle });
    return handle;
  }

  selectWindow(id, handle) {
    return this.request("POST", `/session/${id}/window`, { handle });
  }

  async execute(id, script) {
    return this.request("POST", `/session/${id}/execute/sync`, { script, args: [] });
  }

  async executeAsync(id, script) {
    return this.request("POST", `/session/${id}/execute/async`, { script, args: [] });
  }

  setScriptTimeout(id, ms) {
    return this.request("POST", `/session/${id}/timeouts`, { script: ms });
  }

  installAddon(id, path) {
    return this.request("POST", `/session/${id}/moz/addon/install`, {
      path,
      temporary: true,
    });
  }
}

async function main() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(TEST_PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  console.log(`test page: ${pageUrl}`);

  const port = 9500 + Math.floor(Math.random() * 300);
  const profileDir = mkdtempSync(join(tmpdir(), "lookatify-fx-capture-"));
  const addonDir = buildAddon(join(profileDir, "addon"));

  const gecko = spawn(geckodriverPath, ["--port", String(port), "--binary", firefoxPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  const driver = new WebDriver(`http://127.0.0.1:${port}`);
  const checks = [];
  const failures = [];
  let sessionId = null;
  let extensionHandle = null;

  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`);
        if (response.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    sessionId = await driver.newSession({
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            binary: firefoxPath,
            args: ["-headless", "--width=1280", "--height=900"],
            prefs: {
              "xpinstall.signatures.required": false,
              "extensions.webextensions.uuids": JSON.stringify({
                "lookatify@local.dev": EXTENSION_UUID,
              }),
            },
          },
        },
      },
    });
    console.log("session created");

    await driver.installAddon(sessionId, addonDir);
    console.log("addon installed");

    await driver.setScriptTimeout(sessionId, 120000);

    // The extension page has the full extension API, so the checks run there.
    // The options page is used because the popup closes itself when it is
    // opened as a regular tab.
    const origin = `moz-extension://${EXTENSION_UUID}`;
    await driver.navigate(sessionId, `${origin}/options/options.html`);
    await new Promise((r) => setTimeout(r, 2000));

    const handles = await driver.request("GET", `/session/${sessionId}/window/handles`);
    extensionHandle = handles[0];

    // The test page goes into a second tab, so both pages stay loaded.
    await driver.newTab(sessionId);
    await driver.navigate(sessionId, pageUrl);
    await new Promise((r) => setTimeout(r, 2500));

    const pageInfo = JSON.parse(
      await driver.execute(
        sessionId,
        `return JSON.stringify({
           title: document.title,
           height: document.documentElement.scrollHeight,
           width: window.innerWidth,
         });`,
      ),
    );
    checks.push({ name: "page loads", ok: pageInfo.height > 900, value: pageInfo });

    // Back to the extension page for the remaining checks.
    await driver.selectWindow(sessionId, extensionHandle);
    await new Promise((r) => setTimeout(r, 500));

    // The extension APIs must all be present in Firefox.
    const apis = JSON.parse(
      await driver.execute(
        sessionId,
        `try {
           return JSON.stringify({
             hasTabs: typeof browser.tabs?.captureVisibleTab === 'function',
             hasScripting: typeof browser.scripting?.executeScript === 'function',
             hasStorage: typeof browser.storage?.local?.get === 'function',
             hasOffscreenCanvas: typeof OffscreenCanvas === 'function',
             hasCreateImageBitmap: typeof createImageBitmap === 'function',
           });
         } catch (error) {
           return JSON.stringify({ error: error.message });
         }`,
      ),
    );
    checks.push({
      name: "background APIs",
      ok:
        apis.hasTabs === true &&
        apis.hasScripting === true &&
        apis.hasStorage === true &&
        apis.hasOffscreenCanvas === true &&
        apis.hasCreateImageBitmap === true,
      value: apis,
    });

    // The analyses are kept in IndexedDB, because the screenshots are far
    // too large for the storage area. Firefox has to support the same
    // database in its background context.
    const database = JSON.parse(
      await driver.executeAsync(
        sessionId,
        `const done = arguments[arguments.length - 1];
         (async () => {
           try {
             const module = await import('moz-extension://9c2f4e17-6b83-4d5a-9e01-7f4c2b8d6a30/lib/storage.js');
             const blob = new Blob([new Uint8Array(4096)], { type: 'image/png' });
             await module.writeAnalysis({
               analysisId: 'firefox-storage-test',
               hostname: 'example.com',
               imageBlob: blob,
               saliencyBlob: blob,
               width: 1280,
               height: 2400,
               topPoints: [],
               stats: {},
               timingMs: {},
               warnings: [],
               capturedAt: 1700000000000,
             });
             const read = await module.readAnalysis('firefox-storage-test');
             await module.clearAnalyses();
             done(JSON.stringify({
               ok: read?.imageBlob?.size === 4096,
               imageBytes: read?.imageBlob?.size ?? 0,
             }));
           } catch (error) {
             done(JSON.stringify({ ok: false, error: error.message }));
           }
         })();`,
      ),
    );
    checks.push({
      name: "IndexedDB stores the analyses",
      ok: database.ok === true,
      value: database,
    });

    // Find the test page's tab.
    const tabInfo = JSON.parse(
      await driver.executeAsync(
        sessionId,
        `const done = arguments[arguments.length - 1];
         browser.tabs.query({}).then((tabs) => {
           const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(pageUrl)}));
           if (!tab) {
             return done(JSON.stringify({
               ok: false,
               error: "the test tab was not found",
               urls: tabs.map((t) => t.url),
             }));
           }
           done(JSON.stringify({ ok: true, tabId: tab.id, windowId: tab.windowId }));
         }).catch((error) => done(JSON.stringify({ ok: false, error: error.message })));`,
      ),
    );
    checks.push({ name: "test tab found", ok: tabInfo.ok === true, value: tabInfo });
    if (!tabInfo.ok) {
      throw new Error(`the test tab was not found: ${tabInfo.error}`);
    }

    // Inject the content script.
    const injected = JSON.parse(
      await driver.executeAsync(
        sessionId,
        `const done = arguments[arguments.length - 1];
         browser.scripting.executeScript({
           target: { tabId: ${tabInfo.tabId} },
           files: ["/content/capture.js"],
         }).then(
           () => done(JSON.stringify({ ok: true })),
           (error) => done(JSON.stringify({ ok: false, error: error.message })),
         );`,
      ),
    );
    checks.push({ name: "content script injected", ok: injected.ok === true, value: injected });

    // Run the capture. The visible-tab capture grabs the active tab of the
    // focused window, so the test page's window is focused first.
    const capture = JSON.parse(
      await driver.executeAsync(
        sessionId,
        `const done = arguments[arguments.length - 1];
         (async () => {
           try {
             await browser.windows.update(${tabInfo.windowId}, { focused: true });
             await new Promise((r) => setTimeout(r, 900));

             const result = await browser.tabs.sendMessage(${tabInfo.tabId}, {
               type: "LOOKATIFY_CAPTURE_START",
               viewportOnly: false,
             });

             if (!result || !result.ok) {
               return done(JSON.stringify({
                 ok: false,
                 error: (result && result.error) || "capture failed",
               }));
             }

             const first = result.slices[0] || {};
             done(JSON.stringify({
               ok: true,
               slices: result.slices.length,
               width: result.width,
               height: result.height,
               pageHeight: result.pageHeight,
               isPng: typeof first.dataUrl === 'string' && first.dataUrl.startsWith('data:image/png'),
               dataUrlLength: (first.dataUrl || '').length,
             }));
           } catch (error) {
             done(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
           }
         })();`,
      ),
    );
    checks.push({
      name: "capture pipeline",
      ok: capture.ok && capture.slices > 0 && capture.isPng && capture.dataUrlLength > 1000,
      value: capture,
    });

    // The full page capture scrolls through the page, so it produces more
    // than one slice.
    checks.push({
      name: "full page slices",
      ok: capture.ok && capture.slices > 1 && capture.height > capture.pageHeight * 0.5,
      value: {
        slices: capture.slices,
        height: capture.height,
        pageHeight: capture.pageHeight,
      },
    });

    // The stitching canvas must work.
    const stitch = JSON.parse(
      await driver.executeAsync(
        sessionId,
        `const done = arguments[arguments.length - 1];
         (async () => {
           try {
             const canvas = new OffscreenCanvas(10, 10);
             const context = canvas.getContext('2d');
             context.fillStyle = '#c2703d';
             context.fillRect(0, 0, 10, 10);
             const blob = await canvas.convertToBlob({ type: 'image/png' });
             const bitmap = await createImageBitmap(blob);
             const size = { width: bitmap.width, height: bitmap.height };
             bitmap.close();
             done(JSON.stringify({ ok: true, blobSize: blob.size, ...size }));
           } catch (error) {
             done(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
           }
         })();`,
      ),
    );
    checks.push({
      name: "stitching canvas",
      ok: stitch.ok && stitch.blobSize > 0 && stitch.width === 10,
      value: stitch,
    });

    // The content script must be able to import the stitching helpers.
    const dynamicImport = JSON.parse(
      await driver.executeAsync(
        sessionId,
        `const done = arguments[arguments.length - 1];
         browser.scripting.executeScript({
           target: { tabId: ${tabInfo.tabId} },
           func: async () => {
             try {
               const module = await import(browser.runtime.getURL('lib/stitch.js'));
               return {
                 ok: true,
                 hasPlanSlices: typeof module.planSlices === 'function',
                 hasFindSticky: typeof module.findStickyElements === 'function',
               };
             } catch (error) {
               return { ok: false, error: error.message };
             }
           },
         }).then(
           (results) => done(JSON.stringify(results[0]?.result ?? { ok: false, error: 'no result' })),
           (error) => done(JSON.stringify({ ok: false, error: error.message })),
         );`,
      ),
    );
    checks.push({
      name: "content script import",
      ok: dynamicImport.ok && dynamicImport.hasPlanSlices && dynamicImport.hasFindSticky,
      value: dynamicImport,
    });
  } catch (error) {
    failures.push(error.message);
    console.log("ERROR:", error.message);
  } finally {
    if (sessionId) {
      try {
        await driver.deleteSession(sessionId);
      } catch {
        // The browser may already be gone.
      }
    }
    gecko.kill("SIGKILL");
    rmSync(profileDir, { recursive: true, force: true });
    server.close();
  }

  console.log("\n--- Firefox capture results ---");
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(24)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 180)}`,
    );
    if (!check.ok) failures.push(check.name);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: ${[...new Set(failures)].join(", ")}`);
    process.exit(1);
  }
  console.log("\nFIREFOX CAPTURE CHECKS PASSED");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
