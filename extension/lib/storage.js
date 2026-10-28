/**
 * LookAtify — analysis storage.
 *
 * The screenshots of a full page are far too large for `chrome.storage.local`,
 * which caps the whole area at 10 MB and a single item at 8 MB. A PNG that
 * is base64 encoded in a data URL is a third larger than the image itself, so
 * a handful of analyses fill the quota and every later run fails with
 * "Resource::kQuotaBytes quota exceeded".
 *
 * The analyses therefore live in IndexedDB, which stores the image as a Blob
 * with no base64 overhead and no quota of its own. Only the small metadata
 * record — the statistics, the peak points and the image dimensions — stays
 * in `chrome.storage.local`, where it is cheap and easy to list.
 *
 * The module is split into two halves: the pure pruning rules, which are
 * unit tested without a browser, and the IndexedDB access, which needs one.
 */

import { STORAGE_KEYS, analysisStorageKey } from "./config.js";

/** The name of the IndexedDB database. */
export const DB_NAME = "lookatify";

/** The version of the IndexedDB schema. */
export const DB_VERSION = 1;

/** The object store that holds the analysis records. */
export const STORE_NAME = "analyses";

/**
 * How many analyses are kept before the oldest ones are removed.
 *
 * Each full-page analysis is a few megabytes, so a handful is plenty for the
 * history the viewer offers and keeps the disk usage bounded.
 */
export const MAX_STORED_ANALYSES = 5;

/**
 * Sort the stored analyses by age, newest first.
 *
 * The records that carry a timestamp come first. A record without one is
 * treated as the oldest, because that is the safe assumption for a record
 * written by an older version of the extension.
 *
 * @param {Array<{id: string, capturedAt?: number}>} records
 * @returns {Array<{id: string, capturedAt?: number}>}
 */
export function sortByNewest(records) {
  return [...records].sort((left, right) => {
    const leftTime = Number(left.capturedAt) || 0;
    const rightTime = Number(right.capturedAt) || 0;
    if (leftTime === rightTime) return String(left.id).localeCompare(String(right.id));
    return rightTime - leftTime;
  });
}

/**
 * Choose the analyses that have to be removed to stay within the limit.
 *
 * The newest analyses are kept and the oldest ones are dropped. The analysis
 * that is currently on screen is never removed, so that opening a result
 * cannot make the viewer lose it.
 *
 * @param {Array<{id: string, capturedAt?: number}>} records
 * @param {{keep?: number, protectId?: string|null}} [options]
 * @returns {string[]} The ids to remove, newest first.
 */
export function selectExpiredIds(records, options = {}) {
  const limit = Number.isFinite(options.keep) ? options.keep : MAX_STORED_ANALYSES;
  const protectId = options.protectId ?? null;

  const ordered = sortByNewest(records);

  const kept = [];
  const expired = [];

  for (const record of ordered) {
    const isProtected = protectId !== null && String(record.id) === String(protectId);
    if (isProtected || kept.length < limit) {
      kept.push(record);
    } else {
      expired.push(record);
    }
  }

  return expired.map((record) => String(record.id));
}

/**
 * Build the small metadata record that is kept in `chrome.storage.local`.
 *
 * The images are deliberately left out: they live in IndexedDB as blobs, and
 * copying them into the settings area is what used to exhaust the quota.
 *
 * @param {Object} analysis The full analysis.
 * @returns {Object}
 */
export function toMetadata(analysis) {
  return {
    analysisId: analysis.analysisId,
    hostname: analysis.hostname,
    width: analysis.width,
    height: analysis.height,
    topPoints: analysis.topPoints || [],
    stats: analysis.stats || {},
    timingMs: analysis.timingMs || {},
    warnings: analysis.warnings || [],
    capturedAt: analysis.capturedAt || Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                            */
/* ------------------------------------------------------------------ */

/**
 * Open the database, creating the object store on the first run.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("capturedAt", "capturedAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The analysis database is blocked by another tab."));
  });
}

/**
 * Run a transaction against the analysis store.
 *
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} action
 * @returns {Promise<any>}
 */
function runTransaction(mode, action) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));

        transaction.oncomplete = () => {
          database.close();
          resolve(request ? request.result : undefined);
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error || new Error("The analysis transaction was aborted."));
        };
      }),
  );
}

/**
 * Read every stored analysis record.
 *
 * @returns {Promise<Array<Object>>}
 */
export function readAllAnalyses() {
  return runTransaction("readonly", (store) => store.getAll());
}

/**
 * Read a single analysis, including its images.
 *
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export function readAnalysis(id) {
  return runTransaction("readonly", (store) => store.get(String(id))).then(
    (record) => record || null,
  );
}

/**
 * Find the field that cannot be copied into the database.
 *
 * IndexedDB stores a structured clone, so a promise or a function in the
 * record makes the write fail with "could not be cloned". The browser does
 * not say which field it was, so the fields are checked one by one.
 *
 * @param {Object} record
 * @returns {string|null} The name of the offending field.
 */
export function findUncloneableField(record) {
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    try {
      structuredClone(value);
    } catch {
      return key;
    }
  }
  return null;
}

/**
 * Save an analysis and its images.
 *
 * The record is written first and the images are added afterwards, so a
 * failure part way through never leaves a half written record behind that
 * the viewer cannot open.
 *
 * @param {Object} analysis The full analysis, including the image blobs.
 * @returns {Promise<string>} The analysis id.
 */
export async function writeAnalysis(analysis) {
  const id = String(analysis.analysisId);
  const record = {
    id,
    analysisId: id,
    hostname: analysis.hostname,
    width: analysis.width,
    height: analysis.height,
    topPoints: analysis.topPoints || [],
    stats: analysis.stats || {},
    timingMs: analysis.timingMs || {},
    warnings: analysis.warnings || [],
    capturedAt: analysis.capturedAt || Date.now(),
    imageBlob: analysis.imageBlob || null,
    saliencyBlob: analysis.saliencyBlob || null,
  };

  const uncloneable = findUncloneableField(record);
  if (uncloneable) {
    throw new Error(
      `The field "${uncloneable}" cannot be stored: ${typeof record[uncloneable]}`,
    );
  }

  await runTransaction("readwrite", (store) => store.put(record));
  return id;
}

/**
 * Remove analyses by id.
 *
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
export async function deleteAnalyses(ids) {
  if (!ids || ids.length === 0) return;
  await runTransaction("readwrite", (store) => {
    for (const id of ids) store.delete(String(id));
    return null;
  });
}

/**
 * Remove every stored analysis.
 *
 * @returns {Promise<void>}
 */
export async function clearAnalyses() {
  await runTransaction("readwrite", (store) => store.clear());
}

/**
 * Remove the analyses that are no longer needed.
 *
 * The newest analyses are kept and the oldest ones are dropped, so the disk
 * usage stays bounded no matter how many pages are analysed.
 *
 * @param {{keep?: number, protectId?: string|null}} [options]
 * @returns {Promise<string[]>} The ids that were removed.
 */
export async function pruneAnalyses(options = {}) {
  const records = await readAllAnalyses();
  const expired = selectExpiredIds(records, options);
  if (expired.length > 0) {
    await deleteAnalyses(expired);
  }
  return expired;
}

/**
 * Keep the metadata in `chrome.storage.local` in step with the database.
 *
 * The metadata is small, so it can live in the settings area. It gives the
 * viewer a way to list the history without reading every image.
 *
 * @param {Object[]} records
 * @returns {Promise<void>}
 */
export async function syncMetadata(records) {
  const wanted = new Set(records.map((record) => analysisStorageKey(record.id)));
  const stored = await chrome.storage.local.get(null);
  const stale = Object.keys(stored).filter(
    (key) => key.startsWith(STORAGE_KEYS.analysisPrefix) && !wanted.has(key),
  );
  if (stale.length > 0) {
    await chrome.storage.local.remove(stale);
  }

  const updates = {};
  for (const record of records) {
    updates[analysisStorageKey(record.id)] = toMetadata(record);
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

/**
 * Remove every trace of an analysis from both stores.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function forgetAnalysis(id) {
  await deleteAnalyses([id]);
  await chrome.storage.local.remove(analysisStorageKey(id));
}

/**
 * Move the analyses written by an older version out of the settings area.
 *
 * Earlier versions stored the screenshots as base64 data URLs in
 * `chrome.storage.local`. That is what filled the 10 MB quota, and a browser
 * that is already over the quota rejects every write — including the write
 * that would store the new analysis. The legacy records are therefore moved
 * into IndexedDB and removed from the settings area, which frees the space
 * again.
 *
 * @returns {Promise<{migrated: number, removed: number}>}
 */
export async function migrateLegacyAnalyses() {
  const stored = await chrome.storage.local.get(null);
  const legacyKeys = Object.keys(stored).filter((key) =>
    key.startsWith(STORAGE_KEYS.analysisPrefix),
  );

  let migrated = 0;
  let removed = 0;

  for (const key of legacyKeys) {
    const payload = stored[key];
    if (!payload || typeof payload !== "object") {
      await chrome.storage.local.remove(key);
      removed += 1;
      continue;
    }

    // A record without images is already in the new format.
    if (!payload.imageDataUrl && !payload.saliencyDataUrl) {
      continue;
    }

    try {
      const [imageBlob, saliencyBlob] = await Promise.all([
        payload.imageDataUrl ? dataUrlToBlob(payload.imageDataUrl) : null,
        payload.saliencyDataUrl ? dataUrlToBlob(payload.saliencyDataUrl) : null,
      ]);

      await writeAnalysis({
        analysisId: payload.analysisId,
        hostname: payload.hostname,
        imageBlob,
        saliencyBlob,
        width: payload.width,
        height: payload.height,
        topPoints: payload.topPoints,
        stats: payload.stats,
        timingMs: payload.timingMs,
        warnings: payload.warnings,
        capturedAt: payload.capturedAt,
      });
      migrated += 1;
    } catch {
      // A record that cannot be moved is dropped rather than kept, because
      // keeping it would leave the quota blocked.
    }

    await chrome.storage.local.remove(key);
    removed += 1;
  }

  return { migrated, removed };
}

/**
 * Turn a data URL into a blob.
 *
 * @param {string} dataUrl
 * @returns {Promise<Blob>}
 */
async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}
