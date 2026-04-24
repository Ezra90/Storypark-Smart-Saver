/**
 * debug.js — Developer diagnostic capture
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  The developer-facing diagnostic log: raw API response capture,    │
 * │  room extraction miss tracking, face matching borderline logging,  │
 * │  and optional disk dump to Database/debug_log.json.               │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  User-facing activity log → lib/log-manager.js                     │
 * │  debugCaptureMode persistence → background.js (chrome.storage)     │
 * │  The actual API call → lib/api-client.js (calls captureApiResponse)│
 * └────────────────────────────────────────────────────────────────────┘
 *
 * SEPARATION FROM ACTIVITY LOG:
 *   Activity log  = user-facing history ("3 photos downloaded")
 *   Debug log     = developer traces (raw API JSON, decision details)
 *
 * WHEN IS THIS USED?
 *   - Only populated when debugCaptureMode = true (toggle in Settings → Debug)
 *   - Normal use: stays empty, zero performance impact
 *   - Debug use: captures every API response + internal decision point
 *   - File grows large quickly — cleared when debug mode is disabled
 *
 * Database/debug_log.json structure:
 *   {
 *     "capturedAt": "2026-04-24T08:00:00Z",
 *     "debugCaptureMode": true,
 *     "entries": [ DiagnosticEntry, ... ]
 *   }
 *
 * EXPORTS:
 *   initDebugLogger(opts)           — inject debugCaptureMode getter
 *   captureApiResponse(url, data)   — capture a raw API response
 *   captureDecision(tag, data)      — capture an internal decision point
 *   getDiagnosticLog()              — return all entries
 *   clearDiagnosticLog()            — empty the buffer
 *   isDebugMode()                   — check if debug mode is active
 *   DEBUG_LOG_FILENAME              — disk filename constant
 *   DIAG_LOG_MAX_NORMAL             — cap when debug mode is OFF
 *   DIAG_LOG_MAX_DEBUG              — cap when debug mode is ON
 */

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

/**
 * Disk filename for the debug log.
 * Written to: <linked folder>/Storypark Smart Saver/Database/debug_log.json
 * ONLY when debug mode is active.  Cleared when debug mode is disabled.
 */
export const DEBUG_LOG_FILENAME = "debug_log.json";

/**
 * In-memory cap when debug mode is OFF.
 * Small cap so the array doesn't grow unchecked if called accidentally.
 */
export const DIAG_LOG_MAX_NORMAL = 50;

/**
 * In-memory cap when debug mode is ON.
 * Large enough to capture a full scan without losing entries.
 * At ~2KB per entry, 1000 entries ≈ 2 MB — acceptable for debug use.
 */
export const DIAG_LOG_MAX_DEBUG = 1000;

/* ================================================================== */
/*  Decision point tags — for classifying entries                     */
/* ================================================================== */

/**
 * Standard tags for captureDecision() entries.
 * Add new tags here when adding new diagnostic capture points.
 *
 * @readonly
 * @enum {string}
 */
export const DEBUG_TAGS = {
  /** extractRoomFromTitle() found "in X" but X had no known room suffix */
  ROOM_EXTRACTION_UNRECOGNISED: "room_extraction_unrecognised",
  /** extractRoomFromTitle() title had "in" but didn't match the regex */
  ROOM_EXTRACTION_MISS:         "room_extraction_miss",
  /** story.community_name and all fallbacks were empty */
  CENTRE_NAME_EMPTY:            "centre_name_empty",
  /** story.community_name differed from the expected centre fallback */
  CENTRE_NAME_MISMATCH:         "centre_name_mismatch",
  /** story.user.display_name and all educator fallbacks were empty */
  EDUCATOR_NAME_EMPTY:          "educator_name_empty",
  /** Face match score within ±5% of autoThreshold or minThreshold */
  MATCH_BORDERLINE:             "match_borderline",
  /** Room name was resolved and the source logged for audit */
  ROOM_NAME_RESOLVED:           "room_name_resolved",
  /** Generic API response capture (tag = the API path) */
  API_RESPONSE:                 "api_response",
};

/* ================================================================== */
/*  Module state                                                       */
/* ================================================================== */

/** @type {import('./types.js').DiagnosticEntry[]} */
const _log = [];

/** Whether debug capture mode is currently active. */
let _debugModeGetter = () => false;

/* ================================================================== */
/*  Init                                                               */
/* ================================================================== */

/**
 * Inject the debugCaptureMode getter from background.js.
 * Must be called once at startup before any capture functions.
 *
 * @param {Object} opts
 * @param {Function} opts.getDebugMode  — () => boolean
 */
export function initDebugLogger({ getDebugMode }) {
  if (typeof getDebugMode === "function") {
    _debugModeGetter = getDebugMode;
  }
}

/* ================================================================== */
/*  Public API                                                         */
/* ================================================================== */

/**
 * Check whether debug capture mode is currently active.
 * @returns {boolean}
 */
export function isDebugMode() {
  return _debugModeGetter();
}

/**
 * Capture a raw Storypark API response.
 * Only records if debug mode is ON (zero-cost when OFF).
 *
 * Called by lib/api-client.js after every successful apiFetch().
 *
 * @param {string} url  — The API endpoint URL
 * @param {*}      data — The parsed JSON response body
 */
export function captureApiResponse(url, data) {
  if (!_debugModeGetter()) return;
  _addEntry({ url, timestamp: new Date().toISOString(), data, tag: DEBUG_TAGS.API_RESPONSE });
}

/**
 * Capture an internal decision point (room extraction miss, face matching
 * borderline, centre name empty, etc.).
 * Only records if debug mode is ON (zero-cost when OFF).
 *
 * @param {string} tag  — One of DEBUG_TAGS values (or any descriptive string)
 * @param {*}      data — Any context-relevant data (object, string, etc.)
 */
export function captureDecision(tag, data) {
  if (!_debugModeGetter()) return;
  _addEntry({ url: tag, timestamp: new Date().toISOString(), data, tag });
}

/**
 * Return a copy of all diagnostic entries.
 *
 * @returns {import('./types.js').DiagnosticEntry[]}
 */
export function getDiagnosticLog() {
  return _log.slice();
}

/**
 * Clear all diagnostic entries from memory.
 * Also clears the chrome.storage persistent copy if any was saved.
 */
export function clearDiagnosticLog() {
  _log.length = 0;
}

/* ================================================================== */
/*  Internal helpers                                                   */
/* ================================================================== */

/**
 * Add an entry to the in-memory log, trimming the oldest entries when
 * the cap is reached.
 *
 * @param {import('./types.js').DiagnosticEntry} entry
 */
function _addEntry(entry) {
  const cap = _debugModeGetter() ? DIAG_LOG_MAX_DEBUG : DIAG_LOG_MAX_NORMAL;
  _log.push(entry);
  if (_log.length > cap) {
    _log.splice(0, _log.length - cap);
  }
}

/* ================================================================== */
/*  Disk flush (called from dashboard when "Download Debug Log" hit)  */
/* ================================================================== */

/**
 * Write the current diagnostic log to Database/debug_log.json via FSA.
 *
 * Unlike activity_log.jsonl (append-only), debug_log.json is overwritten
 * on each save — it represents the CURRENT debug session, not history.
 *
 * INVARIANT: Only callable from the dashboard page context (FSA access).
 *
 * @param {FileSystemDirectoryHandle} folderHandle
 * @param {boolean} [prettify=false] — Pretty-print the JSON (larger file)
 * @returns {Promise<{ written: number }>}
 */
export async function flushDebugLogToDisk(folderHandle, prettify = false) {
  if (!folderHandle || _log.length === 0) return { written: 0 };
  try {
    const dbFolder = await folderHandle
      .getDirectoryHandle("Storypark Smart Saver", { create: true })
      .then(sss => sss.getDirectoryHandle("Database", { create: true }));

    const fileHandle = await dbFolder.getFileHandle(DEBUG_LOG_FILENAME, { create: true });
    const writable   = await fileHandle.createWritable();

    const payload = {
      capturedAt: new Date().toISOString(),
      debugCaptureMode: _debugModeGetter(),
      entryCount: _log.length,
      entries: _log,
    };
    await writable.write(prettify ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
    await writable.close();

    return { written: _log.length };
  } catch (err) {
    console.warn("[debug] Disk flush failed (non-fatal):", err.message);
    return { written: 0 };
  }
}

/**
 * Generate a downloadable JSON blob URL for the debug log.
 * Used by the "Download Debug Log" button in the dashboard Settings tab.
 * The URL must be revoked by the caller after the download starts.
 *
 * @param {Object}  [centreLocations={}]  — Include centreLocations for context
 * @returns {{ blobUrl: string, filename: string }}
 */
export function createDebugDownloadBlob(centreLocations = {}) {
  const payload = {
    capturedAt: new Date().toISOString(),
    debugCaptureMode: _debugModeGetter(),
    centreLocations,
    apiResponses: _log,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const blobUrl = URL.createObjectURL(blob);
  const filename = `storypark_debug_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
  return { blobUrl, filename };
}
