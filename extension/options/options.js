/**
 * LookAtify options page — loads, validates and saves the settings.
 */

import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  isLoopbackUrl,
  normaliseServerUrl,
  withDefaults,
} from "../lib/config.js";
import { clearAnalyses, readAllAnalyses, syncMetadata } from "../lib/storage.js";

const form = /** @type {HTMLFormElement} */ (document.getElementById("settings-form"));
const serverUrlInput = /** @type {HTMLInputElement} */ (document.getElementById("server-url"));
const apiTokenInput = /** @type {HTMLInputElement} */ (document.getElementById("api-token"));
const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById("default-mode"));
const opacityInput = /** @type {HTMLInputElement} */ (document.getElementById("default-opacity"));
const opacityValue = document.getElementById("opacity-value");
const colormapSelect = /** @type {HTMLSelectElement} */ (document.getElementById("default-colormap"));
const exportSelect = /** @type {HTMLSelectElement} */ (document.getElementById("default-export"));
const heightInput = /** @type {HTMLInputElement} */ (document.getElementById("max-height"));
const heightValue = document.getElementById("height-value");
const viewportOnlyInput = /** @type {HTMLInputElement} */ (document.getElementById("viewport-only"));
const debugCaptureInput = /** @type {HTMLInputElement} */ (document.getElementById("debug-capture"));
const savedLabel = document.getElementById("saved");
const connectionResult = document.getElementById("connection-result");
const testButton = /** @type {HTMLButtonElement} */ (document.getElementById("test-connection"));
const resetButton = document.getElementById("reset");
const clearAnalysesButton = /** @type {HTMLButtonElement} */ (
  document.getElementById("clear-analyses")
);
const clearResult = document.getElementById("clear-result");

/** Fill the form from the stored settings. */
async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = withDefaults(stored[STORAGE_KEYS.settings]);

  serverUrlInput.value = settings.serverUrl;
  apiTokenInput.value = settings.apiToken;
  modeSelect.value = settings.defaultMode;
  opacityInput.value = String(Math.round(settings.defaultOpacity * 100));
  colormapSelect.value = settings.defaultColormap;
  exportSelect.value = settings.defaultExportFormat;
  heightInput.value = String(settings.maxCaptureHeight);
  viewportOnlyInput.checked = Boolean(settings.viewportOnly);
  debugCaptureInput.checked = Boolean(settings.debugCapture);

  syncLabels();
}

/** Keep the inline value labels in sync with the sliders. */
function syncLabels() {
  opacityValue.textContent = `${opacityInput.value}%`;
  heightValue.textContent = `${heightInput.value} px`;
}

opacityInput.addEventListener("input", syncLabels);
heightInput.addEventListener("input", syncLabels);

/** Collect the form into a settings object. */
function collectSettings() {
  const serverUrl = normaliseServerUrl(serverUrlInput.value);
  const opacity = Number(opacityInput.value) / 100;
  const maxHeight = Number(heightInput.value);

  return withDefaults({
    ...DEFAULT_SETTINGS,
    serverUrl,
    apiToken: apiTokenInput.value.trim(),
    defaultMode: modeSelect.value,
    defaultOpacity: Number.isFinite(opacity) ? opacity : DEFAULT_SETTINGS.defaultOpacity,
    defaultColormap: colormapSelect.value,
    defaultExportFormat: exportSelect.value,
    maxCaptureHeight: Number.isFinite(maxHeight) ? maxHeight : DEFAULT_SETTINGS.maxCaptureHeight,
    viewportOnly: viewportOnlyInput.checked,
    debugCapture: debugCaptureInput.checked,
  });
}

/** Show a short-lived confirmation. */
function showSaved(text, tone = "success") {
  savedLabel.textContent = text;
  savedLabel.dataset.tone = tone;
  setTimeout(() => {
    savedLabel.textContent = "";
  }, 2500);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = collectSettings();

  if (settings.serverUrl && !isLoopbackUrl(settings.serverUrl) && !settings.serverUrl.startsWith("https://")) {
    showSaved("Remote servers must use HTTPS.", "error");
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  showSaved("Settings saved.");
});

testButton.addEventListener("click", async () => {
  const settings = collectSettings();
  if (!settings.serverUrl) {
    connectionResult.textContent = "Enter a server URL first.";
    connectionResult.dataset.tone = "error";
    return;
  }

  connectionResult.textContent = "Checking…";
  connectionResult.dataset.tone = "";

  try {
    const response = await fetch(`${settings.serverUrl}/health`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      connectionResult.textContent = `Server responded with ${response.status}.`;
      connectionResult.dataset.tone = "error";
      return;
    }
    const body = await response.json();
    const device = body.device || "unknown";
    connectionResult.textContent = `Connected — model ${body.model_name} on ${device}.`;
    connectionResult.dataset.tone = "success";
  } catch {
    connectionResult.textContent = "Cannot reach the server.";
    connectionResult.dataset.tone = "error";
  }
});

resetButton.addEventListener("click", async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
  await loadSettings();
  showSaved("Defaults restored.");
});

clearAnalysesButton.addEventListener("click", async () => {
  clearAnalysesButton.disabled = true;
  clearResult.textContent = "Clearing…";
  clearResult.dataset.tone = "";

  try {
    const removed = (await readAllAnalyses()).length;
    await clearAnalyses();
    await syncMetadata([]);
    await chrome.storage.local.remove(STORAGE_KEYS.lastAnalysis);

    clearResult.textContent =
      removed === 0 ? "There was nothing to clear." : `Cleared ${removed} analysis record(s).`;
    clearResult.dataset.tone = "success";
  } catch (error) {
    clearResult.textContent = `Could not clear the analyses: ${error.message}`;
    clearResult.dataset.tone = "error";
  } finally {
    clearAnalysesButton.disabled = false;
  }
});

loadSettings();
