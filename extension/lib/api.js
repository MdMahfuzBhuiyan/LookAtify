/**
 * Backend client for the LookAtify extension.
 *
 * Every function accepts an injectable `fetchImpl` so the error handling can
 * be unit tested without a running server.
 */

/**
 * Fallback deadline for the analysis request, in milliseconds.
 *
 * A full-page screenshot is analysed tile by tile on the CPU, so a long page
 * can take a couple of minutes. The default is generous on purpose; a run that
 * needs longer should say so instead of hanging.
 */
const DEFAULT_TIMEOUT_MS = 180000;

/** Build the request headers for the API. */
export function buildHeaders(settings, { json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (settings && settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }
  return headers;
}

/**
 * Turn a failed response into a readable message.
 *
 * @param {number} status
 * @returns {string}
 */
export function messageForStatus(status) {
  switch (status) {
    case 401:
      return "The API token was rejected. Check the token in Settings.";
    case 403:
      return "The API token was rejected. Check the token in Settings.";
    case 404:
      return "The server URL looks wrong — /analyze was not found.";
    case 413:
      return "The screenshot is too large for the server. Try a shorter page.";
    case 429:
      return "Too many analyses. Wait a minute and try again.";
    case 503:
      return "The server is busy or the model is not loaded. Try again shortly.";
    default:
      if (status >= 500) return "The server hit an error. Check the backend logs.";
      return `The server rejected the request (HTTP ${status}).`;
  }
}

/**
 * Decode a base64 payload into a Blob.
 *
 * @param {string} base64
 * @param {string} [mimeType]
 * @returns {Blob}
 */
export function base64ToBlob(base64, mimeType = "image/png") {
  const clean = String(base64).replace(/^data:[^;]+;base64,/, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Check whether the backend is reachable and the model is loaded.
 *
 * @param {Object} settings
 * @param {Function} [fetchImpl]
 * @returns {Promise<{ok: boolean, status: number|null, body: Object|null, error: string|null}>}
 */
export async function checkHealth(settings, fetchImpl = fetch) {
  if (!settings || !settings.serverUrl) {
    return { ok: false, status: null, body: null, error: "No server URL is configured." };
  }

  try {
    const response = await fetchImpl(`${settings.serverUrl}/health`, {
      method: "GET",
      headers: buildHeaders(settings),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body,
        error: messageForStatus(response.status),
      };
    }
    return { ok: true, status: response.status, body, error: null };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: "Cannot reach the analysis server. Check the server URL and that the server is running.",
    };
  }
}

/**
 * Upload a screenshot and receive the analysis.
 *
 * @param {Object} params
 * @param {Object} params.settings
 * @param {Blob} params.blob The screenshot.
 * @param {Object} [params.options] Analysis options.
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{ok: boolean, data: Object|null, error: string|null, status: number|null}>}
 */
export async function analyzeImage({ settings, blob, options = {}, signal, fetchImpl = fetch }) {
  if (!settings || !settings.serverUrl) {
    return { ok: false, data: null, error: "No server URL is configured.", status: null };
  }

  const form = new FormData();
  form.append("file", blob, "screenshot.png");
  form.append("colormap", options.colormap || "jet");
  form.append("blur_sigma", String(options.blurSigma ?? 0));
  form.append("opacity", String(options.opacity ?? 0.55));
  form.append("return_composite", options.returnComposite ? "true" : "false");
  form.append("viewport_only", options.viewportOnly ? "true" : "false");
  form.append("top_n", String(options.topN ?? 5));

  // A long page takes a while to analyse on the CPU, so the request gets its
  // own deadline. Without one, a backend that stops answering leaves the
  // popup on "Analysing the page…" forever.
  const timeoutMs = settings.requestTimeoutMs || DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetchImpl(`${settings.serverUrl}/analyze`, {
      method: "POST",
      headers: buildHeaders(settings),
      body: form,
      signal: combinedSignal,
    });

    if (!response.ok) {
      let detail = null;
      try {
        detail = await response.json();
      } catch {
        detail = null;
      }
      const serverMessage = extractServerMessage(detail);
      return {
        ok: false,
        data: null,
        status: response.status,
        error: serverMessage || messageForStatus(response.status),
      };
    }

    const data = await response.json();
    return { ok: true, data, error: null, status: response.status };
  } catch (error) {
    if (error && error.name === "AbortError") {
      // The caller's own abort wins over the timeout, so the user can still
      // cancel a run that is merely slow.
      if (signal && signal.aborted) {
        return { ok: false, data: null, status: null, error: "The analysis was cancelled." };
      }
      return {
        ok: false,
        data: null,
        status: null,
        error: `The analysis timed out after ${Math.round(timeoutMs / 1000)}s. `
          + "A long page can take a while on the CPU — try a shorter page, "
          + "or raise the timeout in Settings.",
      };
    }
    return {
      ok: false,
      data: null,
      status: null,
      error: "Cannot reach the analysis server. Check the server URL and that the server is running.",
    };
  }
}

/**
 * Pull a human-readable message out of an error response body.
 *
 * @param {Object|null} body
 * @returns {string|null}
 */
export function extractServerMessage(body) {
  if (!body) return null;
  if (typeof body === "string") return body;
  if (body.error && typeof body.error === "object" && body.error.message) {
    return body.error.message;
  }
  if (body.detail) {
    if (typeof body.detail === "string") return body.detail;
    if (body.detail.message) return body.detail.message;
  }
  if (body.message) return body.message;
  return null;
}
