/**
 * LookAtify popup — triggers an analysis and shows the progress steps.
 */

import {
  CAPTURE_STEPS,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  normaliseServerUrl,
  withDefaults,
} from "../lib/config.js";

/** @type {HTMLElement|null} */
const statusDot = document.getElementById("status-dot");
const fullPageButton = /** @type {HTMLButtonElement} */ (document.getElementById("analyze-full"));
const viewportButton = /** @type {HTMLButtonElement} */ (document.getElementById("analyze-viewport"));
const progress = document.getElementById("progress");
const progressSteps = document.getElementById("progress-steps");
const progressFill = document.getElementById("progress-fill");
const cancelButton = document.getElementById("cancel");
const message = document.getElementById("message");
const elapsedLabel = document.getElementById("elapsed");
const openSettings = document.getElementById("open-settings");
const openHistory = document.getElementById("open-history");

/** @type {chrome.runtime.Port|null} */
let activePort = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let statusTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let elapsedTimer = null;
/** Whether the current run finished on its own. */
let finished = false;

/** Show a message under the buttons. */
function showMessage(text, tone = "info") {
  if (!message) return;
  message.textContent = text;
  message.dataset.tone = tone;
  message.hidden = !text;
}

/** Mark a capture step as active, done or pending. */
function setStepState(stepId, state) {
  const item = progressSteps.querySelector(`li[data-step="${stepId}"]`);
  if (item) item.dataset.state = state;
}

/** Reset the progress UI to its initial state. */
function resetProgress() {
  progress.hidden = true;
  progressFill.style.width = "0%";
  for (const step of CAPTURE_STEPS) setStepState(step.id, "pending");
}

/** Update the progress bar for a step index (0-based). */
function setProgress(index) {
  const clamped = Math.max(0, Math.min(index, CAPTURE_STEPS.length - 1));
  progress.hidden = false;
  CAPTURE_STEPS.forEach((step, stepIndex) => {
    if (stepIndex < clamped) setStepState(step.id, "done");
    else if (stepIndex === clamped) setStepState(step.id, "active");
    else setStepState(step.id, "pending");
  });
  progressFill.style.width = `${((clamped + 1) / CAPTURE_STEPS.length) * 100}%`;
}

/** Enable or disable the trigger buttons. */
function setBusy(busy) {
  fullPageButton.disabled = busy;
  viewportButton.disabled = busy;
}

/**
 * Show how long the current step has been running.
 *
 * Analysing a long page takes a while on the CPU, and a progress bar that
 * does not move looks like a hang. The elapsed time makes it clear that the
 * work is still going.
 */
function startElapsedTimer() {
  const startedAt = Date.now();

  stopElapsedTimer();
  const tick = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    elapsedLabel.textContent = `${seconds}s`;
  };

  tick();
  elapsedTimer = setInterval(tick, 1000);
}

/** Stop the elapsed-time counter. */
function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  elapsedLabel.textContent = "";
}

/** Read the stored settings, falling back to the defaults. */
async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return withDefaults(stored[STORAGE_KEYS.settings]);
}

/** Check the backend and update the status dot. */
async function refreshStatus() {
  const settings = await getSettings();
  const serverUrl = normaliseServerUrl(settings.serverUrl);
  if (!serverUrl) {
    statusDot.dataset.state = "offline";
    statusDot.title = "No server URL configured";
    return;
  }
  try {
    const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
    statusDot.dataset.state = response.ok ? "online" : "offline";
    statusDot.title = response.ok ? `Backend online (${serverUrl})` : `Backend error (${response.status})`;
  } catch {
    statusDot.dataset.state = "offline";
    statusDot.title = `Cannot reach ${serverUrl}`;
  }
}

/** Start an analysis run and stream progress from the service worker. */
function startAnalysis(viewportOnly) {
  setBusy(true);
  resetProgress();
  showMessage("");
  setProgress(0);
  startElapsedTimer();
  finished = false;

  activePort = chrome.runtime.connect({ name: "lookatify-capture" });

  activePort.onMessage.addListener((event) => {
    if (!event || typeof event !== "object") return;

    if (event.type === "LOOKATIFY_PROGRESS") {
      const index = CAPTURE_STEPS.findIndex((step) => step.id === event.step);
      if (index >= 0) setProgress(index);
      if (event.message) showMessage(event.message);
      return;
    }

    if (event.type === "LOOKATIFY_DONE") {
      finished = true;
      setProgress(CAPTURE_STEPS.length - 1);
      progressFill.style.width = "100%";
      setBusy(false);
      stopElapsedTimer();
      activePort?.disconnect();
      activePort = null;
      showMessage("Analysis ready.");
      window.close();
      return;
    }

    if (event.type === "LOOKATIFY_ERROR") {
      finished = true;
      setBusy(false);
      stopElapsedTimer();
      resetProgress();
      showMessage(event.message || "The analysis failed.", "error");
      activePort?.disconnect();
      activePort = null;
    }
  });

  activePort.onDisconnect.addListener(() => {
    // A disconnect without a DONE or ERROR message means the service worker
    // went away mid-run — Chrome suspends it after about thirty seconds of
    // inactivity, which a long analysis can trigger. Say so instead of
    // leaving the popup stuck on the last progress message.
    if (activePort && !finished) {
      showMessage(
        "The analysis was interrupted — the browser suspended the extension. "
          + "Try again, or analyse a shorter page.",
        "error",
      );
    }
    activePort = null;
    setBusy(false);
    stopElapsedTimer();
  });

  activePort.postMessage({ type: "LOOKATIFY_ANALYZE", viewportOnly });
}

fullPageButton.addEventListener("click", () => startAnalysis(false));
viewportButton.addEventListener("click", () => startAnalysis(true));

cancelButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "LOOKATIFY_CANCEL" }).catch(() => {});
  activePort?.disconnect();
  activePort = null;
  setBusy(false);
  resetProgress();
  showMessage("Cancelled.");
});

openSettings.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

openHistory.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") });
  window.close();
});

refreshStatus();
statusTimer = setInterval(refreshStatus, 30000);
window.addEventListener("unload", () => {
  if (statusTimer) clearInterval(statusTimer);
});
