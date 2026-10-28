/**
 * Locate the browser binaries that the compatibility checks drive.
 *
 * The Chromium and Firefox builds that the checks use are downloaded into a
 * cache directory, and their versioned folder names change with every
 * release. This module finds the newest build in the cache instead of
 * hardcoding a version, so the checks keep working after an update.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the downloaded browsers live. */
const CACHE_DIR = process.env.PUKU_BROWSER_CACHE || "/tmp/pptr-browsers";

/**
 * Find the newest directory that matches a pattern.
 *
 * @param {string} parent
 * @param {RegExp} pattern
 * @returns {string|null}
 */
function findNewestDirectory(parent, pattern) {
  if (!existsSync(parent)) return null;
  const matches = readdirSync(parent).filter((entry) => pattern.test(entry));
  if (matches.length === 0) return null;

  return matches
    .map((entry) => {
      const full = join(parent, entry);
      let modified = 0;
      try {
        modified = statSync(full).mtimeMs;
      } catch {
        modified = 0;
      }
      return { full, modified };
    })
    .sort((a, b) => b.modified - a.modified)[0].full;
}

/**
 * Find the Chromium binary.
 *
 * @returns {string|null}
 */
export function findChromium() {
  // A system Chromium is preferred, because it is always present.
  for (const candidate of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  const root = findNewestDirectory(join(CACHE_DIR, "chromium"), /^linux-/);
  if (!root) return null;
  const binary = join(root, "chrome-linux", "chrome");
  return existsSync(binary) ? binary : null;
}

/**
 * Find the Firefox binary.
 *
 * @returns {string|null}
 */
export function findFirefox() {
  for (const candidate of ["/usr/bin/firefox", "/usr/bin/firefox-esr"]) {
    if (existsSync(candidate)) return candidate;
  }

  const root = findNewestDirectory(join(CACHE_DIR, "firefox"), /^linux-/);
  if (!root) return null;
  const binary = join(root, "firefox", "firefox");
  return existsSync(binary) ? binary : null;
}

/**
 * Find geckodriver.
 *
 * @returns {string|null}
 */
export function findGeckodriver() {
  for (const candidate of ["/tmp/geckodriver", "/usr/local/bin/geckodriver", "/usr/bin/geckodriver"]) {
    if (existsSync(candidate)) return candidate;
  }

  const root = findNewestDirectory(join(CACHE_DIR, "geckodriver"), /./);
  if (!root) return null;
  const binary = join(root, "geckodriver");
  return existsSync(binary) ? binary : null;
}

/**
 * Find the Brave binary.
 *
 * @returns {string|null}
 */
export function findBrave() {
  const candidate = "/usr/bin/brave-browser";
  return existsSync(candidate) ? candidate : null;
}
