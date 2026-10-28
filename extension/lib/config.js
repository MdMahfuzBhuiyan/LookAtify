/**
 * LookAtify — shared configuration and brand constants.
 *
 * This module is the single source of truth for the brand, default settings
 * and the storage keys used by the popup, service worker and viewer. Keep it
 * dependency-free so it can be imported from a service worker, an extension
 * page or a plain script.
 */

/** Brand identity extracted from the supplied logo artwork. */
export const BRAND = {
  name: 'LookAtify',
  tagline: 'Visual attention heatmaps for web pages',
  primary: '#51454e',
  primarySoft: '#6b5d67',
  accent: '#c2703d',
  logoWordmark: 'assets/brand/lookatify-wordmark.svg',
  logoMonogram: 'assets/brand/lookatify-monogram.svg',
};

/** Defaults applied on a fresh install and used to seed the options page. */
export const DEFAULT_SETTINGS = {
  serverUrl: 'http://127.0.0.1:8001',
  apiToken: '',
  defaultMode: 'blended',
  defaultOpacity: 0.55,
  defaultColormap: 'jet',
  defaultBlurSigma: 0,
  defaultThreshold: 0,
  defaultExportFormat: 'png',
  maxCaptureHeight: 16000,
  viewportOnly: false,
  debugCapture: false,
  requestTimeoutMs: 180000,
};

/** Storage keys. `chrome.storage.local` keeps everything on the device. */
export const STORAGE_KEYS = {
  settings: 'lookatify_settings',
  lastAnalysis: 'lookatify_last_analysis_id',
  analysisPrefix: 'lookatify_analysis_',
};

/** Capture / analysis pipeline steps surfaced in the popup progress bar. */
export const CAPTURE_STEPS = [
  { id: 'capturing', label: 'Capturing' },
  { id: 'uploading', label: 'Uploading' },
  { id: 'analyzing', label: 'Analyzing' },
  { id: 'rendering', label: 'Rendering' },
];

/** Long port used for the capture <-> popup conversation. */
export const CAPTURE_PORT = 'lookatify-capture';

/** View modes supported by the viewer. */
export const VIEW_MODES = ['blended', 'split', 'heatmap', 'original'];

/** Keyboard shortcuts handled by the viewer (see docs/user-guide.md). */
export const VIEWER_SHORTCUTS = {
  '1': 'blended',
  '2': 'split',
  '3': 'heatmap',
  '4': 'original',
};

/** Build the key that stores one analysis payload in chrome.storage.local. */
export function analysisStorageKey(analysisId) {
  return `${STORAGE_KEYS.analysisPrefix}${analysisId}`;
}

/** Merge stored settings over the defaults, ignoring unknown/invalid values. */
export function withDefaults(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  merged.defaultOpacity = clamp(merged.defaultOpacity, 0, 1, DEFAULT_SETTINGS.defaultOpacity);
  merged.defaultBlurSigma = clamp(merged.defaultBlurSigma, 0, 100, DEFAULT_SETTINGS.defaultBlurSigma);
  merged.defaultThreshold = clamp(merged.defaultThreshold, 0, 100, DEFAULT_SETTINGS.defaultThreshold);
  merged.maxCaptureHeight = clamp(
    Math.round(merged.maxCaptureHeight),
    1000,
    32000,
    DEFAULT_SETTINGS.maxCaptureHeight,
  );
  if (!VIEW_MODES.includes(merged.defaultMode)) {
    merged.defaultMode = DEFAULT_SETTINGS.defaultMode;
  }
  return merged;
}

/** Clamp a number into a range with a fallback. */
export function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Normalise a user-entered server URL.
 * @returns {string} URL without a trailing slash, or an empty string when invalid.
 */
export function normaliseServerUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) return '';
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * True when the URL points at a loopback address. Plain HTTP is only allowed
 * for these hosts; everything else must use HTTPS.
 */
export function isLoopbackUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}
