/**
 * log-manager.js — Activity log engine
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  The user-facing activity log: in-memory buffer, batched flush to  │
 * │  chrome.storage.local, and optional disk dump to                   │
 * │  Database/activity_log.jsonl (via FSA from dashboard context).     │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Developer/API diagnostic capture → lib/debug.js                   │
 * │  DOM log rendering → dashboard-log.js                              │
 * │  Scan progress bar → dashboard-job.js                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * TWO LOG STORES:
 *   1. chrome.storage.local.activityLog[]  (fast, capped at LOG_MAX_ENTRIES)
 *      → Read by GET_ACTIVITY_LOG message for in-app display
 *
 *   2. Database/activity_log.jsonl  (unlimited, append-only, plain text)
 *      → Written by flushToDisk() after each operation completes
 *      → dashboard.js calls flushToDisk() after scan/audit/etc. finishes
 *      → JSON Lines format: one ActivityLogEntry per line
 *      → Can be opened in VS Code, grep'd, imported into Excel
 *
 * USAGE (background.js):
 *   import { createLogger } from './lib/log-manager.js';
 *   const logger = createLogger();           // factory creates a bound instance
 *   logger("INFO", "Scanning Hugo Hill…");   // existing call signature unchanged
 *
 * EXPORTS:
 *   createLogger()          — returns a logger function (background.js)
 *   LOG_MAX_ENTRIES         — storage cap constant
 *   ACTIVITY_LOG_FILENAME   — disk filename constant
 */

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

/**
 * Maximum number of entries kept in chrome.storage.local.activityLog.
 * At ~300 bytes per entry, 5000 entries ≈ 1.5 MB (well within 10 MB quota).
 * Older entries are trimmed from the front when this limit is reached.
 */
export const LOG_MAX_ENTRIES = 5000;

/**
 * Disk filename for the append-only JSON Lines log.
 * Written to: <linked folder>/Storypark Smart Saver/Database/activity_log.jsonl
 */
export const ACTIVITY_LOG_FILENAME = "activity_log.jsonl";

/**
 * Milliseconds between batched chrome.storage.local flushes.
 * Coalesces rapid log lines (e.g. one per image during a scan) into a
 * single write, reducing storage I/O from hundreds per scan to ~2/second.
 */
const FLUSH_INTERVAL_MS = 500;

/* ================================================================== */
/*  Logger factory                                                     */
/* ================================================================== */

/**
 * Create a logger function bound to this module's buffer.
 * Called once at background.js startup; the returned function replaces
 * the original `logger()` with an identical call signature.
 *
 * @param {Object} [opts]
 * @param {string} [opts.jobName=""]  — Default job name tag for all entries
 * @returns {LoggerFn} — async (level, message, storyDate?, meta?) => void
 *
 * @typedef {Function} LoggerFn
 * @param {"INFO"|"SUCCESS"|"WARNING"|"ERROR"} level
 * @param {string}   message
 * @param {string}   [storyDate]  — YYYY-MM-DD for story-specific lines
 * @param {Object}   [meta]       — Structured metadata for pill display
 * @returns {Promise<void>}       — Resolved Promise (for await compatibility)
 */
export function createLogger(opts = {}) {
  const _buffer = [];
  let _flushTimer = null;
  let _currentJobName = opts.jobName || "";

  /**
   * Update the job name tag for subsequent log entries.
   * Call this when a new operation starts (e.g. "scan", "audit").
   * @param {string} jobName
   */
  function setJobName(name) {
    _currentJobName = name || "";
  }

  /**
   * Schedule a batched flush of _buffer to chrome.storage.local.
   * Coalesces multiple rapid calls into a single storage write.
   */
  function _scheduleFlush() {
    if (_flushTimer !== null) return;
    _flushTimer = setTimeout(async () => {
      _flushTimer = null;
      if (_buffer.length === 0) return;
      const batch = _buffer.splice(0);
      try {
        const { activityLog = [] } = await chrome.storage.local.get("activityLog");
        activityLog.push(...batch);
        // Trim from the front to stay within storage cap
        if (activityLog.length > LOG_MAX_ENTRIES) {
          activityLog.splice(0, activityLog.length - LOG_MAX_ENTRIES);
        }
        await chrome.storage.local.set({ activityLog });
      } catch (err) {
        // Non-fatal: entries were already broadcast to the dashboard in real-time.
        // Logging failures must never crash the extension.
        console.warn("[log-manager] Storage flush failed (non-fatal):", err.message);
      }
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * The logger function returned to background.js.
   * Call signature is identical to the original background.js logger().
   *
   * @param {"INFO"|"SUCCESS"|"WARNING"|"ERROR"} level
   * @param {string}   message
   * @param {string?}  storyDate  — YYYY-MM-DD
   * @param {Object?}  meta       — Structured data for Activity Log pills
   * @returns {Promise<void>}
   */
  async function log(level, message, storyDate = null, meta = null) {
    /** @type {import('./types.js').ActivityLogEntry} */
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (_currentJobName) entry.jobName = _currentJobName;
    if (storyDate)  entry.storyDate = storyDate;
    if (meta)       entry.meta      = meta;

    // Buffer for batched storage write
    _buffer.push(entry);
    _scheduleFlush();

    // Broadcast to dashboard in real-time (fire-and-forget)
    chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }).catch(() => {});

    // Return a resolved Promise so existing `await logger(…)` call-sites work
    return Promise.resolve();
  }

  // Expose setJobName on the function object so callers can tag operations
  log.setJobName = setJobName;
  log.getBuffer  = () => _buffer.slice(); // for testing / disk flush

  return log;
}

/* ================================================================== */
/*  Disk flush (called from dashboard.js after operations complete)   */
/* ================================================================== */

/**
 * Append the current chrome.storage.local.activityLog to
 * Database/activity_log.jsonl via the File System Access API.
 *
 * Call this from dashboard.js after a scan, audit, or other long
 * operation completes (when the FSA folder handle is available).
 *
 * The file uses JSON Lines format (.jsonl): one JSON object per line.
 * Each call APPENDS to the existing file — entries are never deleted.
 * Opening the file in VS Code shows the full history.
 *
 * INVARIANT: This function is only callable from the dashboard page
 * context (has FSA access).  It is NOT available in the service worker.
 *
 * @param {FileSystemDirectoryHandle} folderHandle — Linked SSS folder
 * @param {import('./types.js').ActivityLogEntry[]} [entries] — Override entries; defaults to chrome.storage.local.activityLog
 * @returns {Promise<{ written: number }>}
 */
export async function flushActivityLogToDisk(folderHandle, entries = null) {
  if (!folderHandle) return { written: 0 };
  try {
    // Get entries from storage if not provided
    if (!entries) {
      const data = await chrome.storage.local.get("activityLog");
      entries = data.activityLog || [];
    }
    if (entries.length === 0) return { written: 0 };

    // Navigate to Database/ folder (create if not exists)
    const dbFolder = await folderHandle.getDirectoryHandle("Storypark Smart Saver", { create: true })
      .then(sss => sss.getDirectoryHandle("Database", { create: true }));

    // Append-only write to activity_log.jsonl
    const fileHandle = await dbFolder.getFileHandle(ACTIVITY_LOG_FILENAME, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: true });

    // Seek to end of file
    const existing = await fileHandle.getFile();
    await writable.seek(existing.size);

    // Write new entries as JSON Lines (one per line)
    const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
    await writable.write(lines);
    await writable.close();

    return { written: entries.length };
  } catch (err) {
    console.warn("[log-manager] Disk flush failed (non-fatal):", err.message);
    return { written: 0 };
  }
}

/* ================================================================== */
/*  Utility: get all log entries from storage                         */
/* ================================================================== */

/**
 * Retrieve the full activity log from chrome.storage.local.
 * Returns newest-first if `newestFirst` is true.
 *
 * @param {boolean} [newestFirst=false]
 * @returns {Promise<import('./types.js').ActivityLogEntry[]>}
 */
export async function getActivityLog(newestFirst = false) {
  const { activityLog = [] } = await chrome.storage.local.get("activityLog");
  return newestFirst ? activityLog.slice().reverse() : activityLog;
}

/**
 * Clear the activity log from chrome.storage.local.
 * Does NOT affect the disk file (Database/activity_log.jsonl).
 *
 * @returns {Promise<void>}
 */
export async function clearActivityLog() {
  await chrome.storage.local.set({ activityLog: [] });
}

/**
 * Delete the activity log file from disk (Database/activity_log.jsonl).
 * Also clears chrome.storage.local.activityLog.
 *
 * INVARIANT: Only callable from the dashboard page context (has FSA access).
 *
 * @param {FileSystemDirectoryHandle} folderHandle — Linked SSS folder
 * @returns {Promise<{ deleted: boolean }>}
 */
export async function deleteActivityLogFromDisk(folderHandle) {
  if (!folderHandle) return { deleted: false };
  try {
    const dbFolder = await folderHandle.getDirectoryHandle("Storypark Smart Saver", { create: false })
      .then(sss => sss.getDirectoryHandle("Database", { create: false }))
      .catch(() => null);

    if (dbFolder) {
      try {
        await dbFolder.removeEntry(ACTIVITY_LOG_FILENAME);
      } catch { /* file may not exist */ }
    }

    // Also clear chrome.storage.local
    await chrome.storage.local.set({ activityLog: [] });
    return { deleted: true };
  } catch (err) {
    console.warn("[log-manager] deleteActivityLogFromDisk failed (non-fatal):", err.message);
    return { deleted: false };
  }
}
