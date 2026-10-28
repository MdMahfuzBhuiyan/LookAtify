#!/usr/bin/env node
/**
 * Run the LookAtify browser compatibility suite.
 *
 * The suite checks the extension in every browser that is installed on the
 * machine:
 *
 *   - the popup, options and viewer pages render
 *   - the capture pipeline produces the expected slices
 *   - the background service worker has the APIs the flow needs
 *
 * Chromium-based browsers are driven through the DevTools protocol.
 * Firefox is driven through geckodriver, which needs
 * MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 to reach the extension's own pages.
 *
 * Usage:
 *   node scripts/verify-all-browsers.mjs [extensionDir]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  findBrave,
  findChromium,
  findFirefox,
  findGeckodriver,
} from "./browser-paths.mjs";

const extensionDir = resolve(process.argv[2] || "extension");

/** The Chromium-based browsers and their binaries. */
const CHROMIUM_BROWSERS = [
  ["Chromium", findChromium()],
  ["Chrome", "/usr/bin/google-chrome"],
  ["Brave", findBrave()],
];

const GECKODRIVER = findGeckodriver();
const FIREFOX = findFirefox();

/**
 * Run a command and capture its output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Object} env
 * @returns {Promise<{code: number, output: string}>}
 */
function run(command, args, env = {}) {
  return new Promise((resolve_) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => resolve_({ code: code ?? 1, output }));
  });
}

const results = [];

/** The Chromium-based browsers. */
for (const [name, binary] of CHROMIUM_BROWSERS) {
  if (!existsSync(binary)) {
    results.push({ name, status: "skipped", reason: "not installed" });
    continue;
  }

  const capture = await run(
    "node",
    ["scripts/verify-capture.mjs", binary, extensionDir],
  );
  const pages = await run(
    "node",
    ["scripts/verify-browsers.mjs", extensionDir],
  );

  results.push({
    name,
    status: capture.code === 0 && pages.code === 0 ? "passed" : "failed",
    capture: capture.code === 0,
    pages: pages.code === 0,
    output: capture.code === 0 ? "" : capture.output.slice(-1500),
  });
}

/** Firefox. */
if (existsSync(GECKODRIVER) && existsSync(FIREFOX)) {
  const capture = await run(
    "node",
    ["scripts/verify-capture-firefox.mjs", extensionDir],
    { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  );
  const pages = await run("node", ["scripts/verify-firefox.mjs", extensionDir], {
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
  });

  results.push({
    name: "Firefox",
    status: capture.code === 0 && pages.code === 0 ? "passed" : "failed",
    capture: capture.code === 0,
    pages: pages.code === 0,
    output: capture.code === 0 ? "" : capture.output.slice(-1500),
  });
} else {
  results.push({ name: "Firefox", status: "skipped", reason: "not installed" });
}

console.log("\n=== browser compatibility ===");
for (const result of results) {
  const detail =
    result.status === "passed"
      ? "capture + pages"
      : (result.output || result.reason || "").split("\n").slice(-4).join(" | ");
  console.log(`${result.name.padEnd(10)} ${result.status.padEnd(8)} ${detail}`);
}

const failed = results.filter((result) => result.status === "failed");
if (failed.length > 0) {
  console.error(`\n${failed.length} browser(s) failed`);
  process.exit(1);
}
console.log("\nALL BROWSERS PASSED");
