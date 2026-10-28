/**
 * Verify the LookAtify extension inside Firefox.
 *
 * Firefox assigns each extension a random internal UUID. Pinning that UUID
 * through the `extensions.webextensions.uuids` pref makes the extension's
 * pages reachable at a known `moz-extension://` origin, which lets the same
 * checks run in every browser.
 */

import { spawn } from "node:child_process";
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
const EXTENSION_ID = "lookatify@local.dev";

if (!existsSync(geckodriverPath) || !existsSync(firefoxPath)) {
  console.error("geckodriver or Firefox is missing");
  process.exit(2);
}

/**
 * Build the Firefox flavour of the extension.
 *
 * @param {string} target
 * @returns {string}
 */
function buildAddon(target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(extensionDir)) {
    if (entry === "tests" || entry.startsWith(".")) continue;
    cpSync(join(extensionDir, entry), join(target, entry), { recursive: true });
  }
  // The copy above also brings the Chrome manifest.json, so the Firefox
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
      throw new Error(
        `${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`,
      );
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

  async execute(id, script) {
    const value = await this.request("POST", `/session/${id}/execute/sync`, {
      script,
      args: [],
    });
    return value;
  }

  /**
   * Run an asynchronous script. The script gets a callback as its last
   * argument and has to call it with the result.
   */
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
  const port = 9600 + Math.floor(Math.random() * 300);
  const profileDir = mkdtempSync(join(tmpdir(), "lookatify-firefox-"));
  const addonDir = buildAddon(join(profileDir, "addon"));

  const gecko = spawn(geckodriverPath, ["--port", String(port), "--binary", firefoxPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let geckoStderr = "";
  gecko.stderr.on("data", (chunk) => {
    geckoStderr += chunk.toString();
  });

  const driver = new WebDriver(`http://127.0.0.1:${port}`);
  let sessionId = null;
  const checks = [];

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
            args: ["-headless"],
            prefs: {
              "xpinstall.signatures.required": false,
              // Pin the extension's internal origin so its pages can be
              // opened at a known address.
              "extensions.webextensions.uuids": JSON.stringify({
                [EXTENSION_ID]: EXTENSION_UUID,
              }),
            },
          },
        },
      },
    });
    console.log("session created");

    await driver.installAddon(sessionId, addonDir);
    console.log("addon installed");

    await driver.setScriptTimeout(sessionId, 30000);

    const origin = `moz-extension://${EXTENSION_UUID}`;

    // The popup.
    await driver.navigate(sessionId, `${origin}/popup/popup.html`);
    await new Promise((r) => setTimeout(r, 2500));
    const popup = JSON.parse(
      await driver.execute(
        sessionId,
        `return JSON.stringify({
           brand: document.querySelector('.brand__name')?.textContent ?? null,
           buttons: document.querySelectorAll('button').length,
           title: document.title,
         });`,
      ),
    );
    checks.push({
      name: "popup",
      ok: popup.brand === "LookAtify" && popup.buttons > 0,
      value: popup,
    });

    // The options page.
    await driver.navigate(sessionId, `${origin}/options/options.html`);
    await new Promise((r) => setTimeout(r, 2500));
    const options = JSON.parse(
      await driver.execute(
        sessionId,
        `return JSON.stringify({
           serverUrl: document.getElementById('server-url')?.value ?? null,
           colormaps: document.querySelectorAll('#default-colormap option').length,
         });`,
      ),
    );
    checks.push({
      name: "options",
      ok: options.colormaps === 5 && typeof options.serverUrl === "string",
      value: options,
    });

    // The viewer.
    await driver.navigate(sessionId, `${origin}/viewer/viewer.html`);
    await new Promise((r) => setTimeout(r, 2500));
    const viewer = JSON.parse(
      await driver.execute(
        sessionId,
        `return JSON.stringify({
           modes: document.querySelectorAll('[data-mode]').length,
           title: document.title,
           // Every element that carries the hidden attribute has to be out
           // of sight. A stylesheet rule that sets "display" beats the
           // user-agent rule for the attribute, which left the loading
           // overlay on top of the canvas for good.
           hiddenLeaks: Array.from(document.querySelectorAll('[hidden]'))
             .filter((element) => getComputedStyle(element).display !== 'none')
             .map((element) => element.id || element.className),
         });`,
      ),
    );
    checks.push({
      name: "viewer",
      ok: viewer.modes === 4 && viewer.hiddenLeaks.length === 0,
      value: viewer,
    });

    // The extension's storage and commands have to work.
    const storage = JSON.parse(
      await driver.executeAsync(
        sessionId,
        `const done = arguments[arguments.length - 1];
         (async () => {
           try {
             await browser.storage.local.set({ lookatify_test: 'value' });
             const stored = await browser.storage.local.get('lookatify_test');
             await browser.storage.local.remove('lookatify_test');
             const cleared = await browser.storage.local.get('lookatify_test');
             done(JSON.stringify({
               ok: stored.lookatify_test === 'value' && !cleared.lookatify_test,
               hasCommands: typeof browser.commands?.onCommand !== 'undefined',
               hasTabsCreate: typeof browser.tabs?.create === 'function',
               hasAction: typeof browser.action !== 'undefined',
             }));
           } catch (error) {
             done(JSON.stringify({ ok: false, error: error.message }));
           }
         })();`,
      ),
    );
    checks.push({
      name: "storage and commands",
      ok: storage.ok === true && storage.hasCommands === true,
      value: storage,
    });

    // The background script has to be alive for the extension to work.
    await driver.navigate(sessionId, "about:debugging#/runtime/this-firefox");
    await new Promise((r) => setTimeout(r, 2500));
    const background = JSON.parse(
      await driver.execute(
        sessionId,
        `return JSON.stringify({
           body: document.body.innerText.replace(/\\s+/g, " ").slice(0, 300),
         });`,
      ),
    );
    checks.push({
      name: "background",
      ok: /LookAtify/i.test(background.body),
      value: background,
    });
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
  }

  console.log("\n--- Firefox results ---");
  let failed = 0;
  for (const check of checks) {
    console.log(
      `${check.name.padEnd(10)} ${check.ok ? "PASS" : "FAIL"}  ${JSON.stringify(check.value).slice(0, 160)}`,
    );
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} Firefox check(s) failed`);
    process.exit(1);
  }
  console.log("\nFIREFOX CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
