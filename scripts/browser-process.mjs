/**
 * Helpers for driving a browser from a verification script.
 *
 * A browser started with `spawn` forks a whole tree of helper processes
 * (zygotes, renderers, GPU and network services). Killing only the direct
 * child leaves that tree behind, and a few dozen orphaned browsers are enough
 * to saturate the machine and slow every later run down. The helper puts the
 * browser in its own process group and kills the group, so nothing survives.
 */

import { spawn } from "node:child_process";

/**
 * Start a browser in its own process group.
 *
 * @param {string} binary The browser executable.
 * @param {string[]} args The command line arguments.
 * @param {Object} [options] Extra options for `spawn`.
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnBrowser(binary, args, options = {}) {
  return spawn(binary, args, {
    stdio: ["ignore", "ignore", "pipe"],
    // A new process group means the whole browser tree can be signalled at
    // once, and Ctrl+C in the terminal does not reach it by accident.
    detached: true,
    ...options,
  });
}

/**
 * Kill a browser and every process it started.
 *
 * @param {import("node:child_process").ChildProcess|null} child
 * @returns {void}
 */
export function killBrowser(child) {
  if (!child || child.pid === undefined) return;

  // The negative pid addresses the whole process group.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone, or the child was never detached.
    try {
      child.kill("SIGKILL");
    } catch {
      // Nothing left to kill.
    }
  }
}
