#!/usr/bin/env python3
"""Update verify-extension.mjs to use CDP loading and dynamic path discovery."""

from __future__ import annotations

import pathlib

TARGET = pathlib.Path("/home/mahfuz/LookAtify/scripts/verify-extension.mjs")

REPLACEMENTS = [
    (
        ''' * Branded Google Chrome 154 refuses both `--load-extension` and
 * `--disable-extensions-except`, so the test uses an unbranded Chromium
 * build, which still supports both flags.
 *
 * Usage:
 *   node scripts/verify-extension.mjs [extensionDir] [chromiumPath]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionDir = resolve(process.argv[2] || "extension");
const chromiumPath =
  process.argv[3] || "/tmp/pptr-browsers/chromium/linux-1728030/chrome-linux/chrome";''',
        ''' * The extension is installed over the DevTools protocol, because Chrome 137
 * and newer ignore the `--load-extension` command line switch.
 *
 * Usage:
 *   node scripts/verify-extension.mjs [extensionDir] [chromiumPath]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findChromium } from "./browser-paths.mjs";

const extensionDir = resolve(process.argv[2] || "extension");
const chromiumPath = process.argv[3] || findChromium();''',
    ),
    (
        '''    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--window-size=1200,800",
    "about:blank",''',
        '''    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1200,800",
    "about:blank",''',
    ),
    (
        '''  const { socket, send } = await connect();

  const extensionId = await findExtensionId();''',
        '''  const { socket, send } = await connect();

  // Install the extension over the DevTools protocol.
  const loaded = await send("Extensions.loadUnpacked", { path: extensionDir });
  if (!loaded?.id) throw new Error("The extension did not load.");

  const extensionId = await findExtensionId();''',
    ),
]

source = TARGET.read_text()

for old, new in REPLACEMENTS:
    if old not in source:
        raise SystemExit(f"block not found:\n{old[:120]}")
    source = source.replace(old, new)

TARGET.write_text(source)
print("patched")
