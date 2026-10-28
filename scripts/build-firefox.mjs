/**
 * Build the Firefox flavour of the extension.
 *
 * Firefox's "Load Temporary Add-on" dialog expects a single `manifest.json`
 * file, and Firefox rejects a manifest that declares a background service
 * worker. This script copies the extension into `dist/firefox/` and writes
 * the Firefox manifest as its `manifest.json`.
 *
 * Usage:
 *   node scripts/build-firefox.mjs [extensionDir] [outputDir]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const extensionDir = resolve(process.argv[2] || "extension");
const outputDir = resolve(process.argv[3] || "dist/firefox");

const sourceManifest = join(extensionDir, "manifest.firefox.json");
if (!existsSync(sourceManifest)) {
  console.error(`The Firefox manifest is missing: ${sourceManifest}`);
  process.exit(1);
}

// The Firefox manifest declares `background.scripts` instead of a service
// worker, and drops the Chromium-only command shortcut for macOS.
const manifest = JSON.parse(readFileSync(sourceManifest, "utf8"));

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

for (const entry of ["background", "content", "popup", "viewer", "options", "lib", "icons"]) {
  const source = join(extensionDir, entry);
  if (!existsSync(source)) continue;
  cpSync(source, join(outputDir, entry), { recursive: true });
}

// The brand artwork lives at the repository root, but the manifest exposes it
// as `assets/brand/*`, so it is copied into the build.
const brandSource = join(extensionDir, "..", "assets", "brand");
if (existsSync(brandSource)) {
  mkdirSync(join(outputDir, "assets"), { recursive: true });
  cpSync(brandSource, join(outputDir, "assets", "brand"), { recursive: true });
}

writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Firefox extension built at ${outputDir}`);
console.log("Load it via about:debugging → This Firefox → Load Temporary Add-on");
console.log(`Select the file: ${join(outputDir, "manifest.json")}`);
