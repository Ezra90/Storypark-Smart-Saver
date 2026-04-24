/**
 * background.js – Service Worker (Manifest V3)
 *
 * Headless API approach: calls Storypark's internal v3 JSON APIs directly.
 * No DOM scraping, no content script.
 *
 * This file owns: scan state, diagnostic/activity log, offscreen lifecycle,
 * profile loading, review approve handler, and the message router.
 *
 * All scan logic → lib/scan-engine.js
 * All API calls  → lib/api-client.js
 * All downloads  → lib/download-pipe.js
 * HTML builders  → lib/html-builders.js
 * Pure helpers   → lib/metadata-helpers.js
 *
 * See ARCHITECTURE.md for the full message protocol table.
 * See AI_RULES.md for invariants all AI agents must follow.
 */

// ── Pure-math face matching (SW-safe — no DOM) ──────────────────────
import { enhancedMatch, buildCentroids, computeCentroid, similarityPct as matchSimilarityPct } from "./lib/matching.js";

// ── IndexedDB layer ──────────────────────────────────────────────────
import {
  getProcessedStories,
  markStoryProcessed,
  getReviewQueue,
  getReviewQueueItem,
  removeFromReviewQueue,
  addToReviewQueue,
  getAllDescriptors,
  getDescriptors,
  saveDescriptor,
  appendDescriptor,
  setDescriptors,
  getChildPhase,
  getAllChildPhases,
  setChildPhase,
  resetChildPhase,
  incrementVerifiedCount,
  advancePhase,
  computeModelConfidence,
  addRejection,
  isRejected,
  clearAllRejections,
  getAllRejections,
  getNegativeDescriptors,
  appendNegativeDescriptor,
  saveScanCheckpoint,
  getScanCheckpoint,
  clearScanCheckpoint,
  getAllScanCheckpoints,
  addPendingDownload,
  getPendingDownloads,
  getAllPendingDownloads,
  removePendingDownload,
  addDownloadedStory,
  getDownloadedStories,
  saveImageFingerprint,
  getImageFingerprint,
  getAllImageFingerprints,
  clearAllImageFingerprints,
  countImageFingerprints,
  cacheStory,
  getCachedStory,
  getAllCachedStories,
  clearAllCachedStories,
  countCachedStories,
  saveChildProfile,
  getChildProfile,
  getAllChildProfiles,
  isChildProfileStale,
  saveCentreProfile,
  getCentreGPS,
  getAllCentreProfiles,
  updateCentreGPS,
  importLegacyCentreLocations,
  saveEducator,
  getAllEducators,
  recordFileDownloaded,
  getActiveDatabaseInfo,
  eagerLoadHotCaches,
  rebuildRejectionsFromFolders,
  getAllDownloadedStories,
} from "./lib/db.js";

// ── Pure helpers — formatDateDMY/formatETA/sanitizeSavePath moved to lib; rest still local ──
import { formatDateDMY, formatETA, sanitizeSavePath } from "./lib/metadata-helpers.js";

// ── Storypark API client + anti-abuse timing ────────────────────────
// apiFetch, smartDelay, STORYPARK_BASE, AuthError, RateLimitError were removed from this file;
// they now live exclusively in lib/api-client.js.
// initApiClient() wires in logger, _diagLog, and cancelRequested so smartDelay respects
// scan cancellations and apiFetch captures debug log entries.
import {
  apiFetch, smartDelay, discoverCentres, geocodeCentre,
  AuthError, RateLimitError, STORYPARK_BASE, DELAY_PROFILES,
  initApiClient,
} from "./lib/api-client.js";

// ── OOM-safe download pipeline ───────────────────────────────────────
// downloadBlob/DataUrl/HtmlFile/VideoFromOffscreen were removed from this file;
// they now live exclusively in lib/download-pipe.js.
// handleDownloadChanged is registered below (ONCE — prevents double-handler bug).
// initDownloadPipe() wires in sendToOffscreen for the blob-URL creation path.
import {
  downloadBlob, downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen,
  MAX_CONCURRENT_DOWNLOADS, handleDownloadChanged, initDownloadPipe,
} from "./lib/download-pipe.js";

// Wire up lib modules with runtime context.
// Function declarations (_diagLog, logger, sendToOffscreen) are hoisted so calling them
// here is safe.  The () => cancelRequested closure defers the read until scan time,
// safely after the `let cancelRequested = false` declaration is evaluated.
initApiClient({
  diagLog: _diagLog,
  logger,
  getCancelRequested: () => cancelRequested,
});
initDownloadPipe({ sendToOffscreen });

// ── Message handler modules (domain-specific, imported for thin router) ─
import {
  handleAuditStories, runAuditAndRepair, handleAuditAndRepair,
  handleRepairStory, handleRebuildRejections,
  handleSyncProcessedFromManifest, handleSyncProcessedFromDisk,
} from "./lib/handlers-audit.js";
import {
  handleBuildHtmlStructure, handleBuildIndexPages, handleBatchDownloadApproved,
  handleRegenerateFromDisk, handleGenerateStoryCardsAll, rebuildIndexPages,
} from "./lib/handlers-html.js";
import { handleFullBackupExport, handleFullBackupImport } from "./lib/handlers-backup.js";
import {
  handleGetChildPhase, handleGetAllChildPhases, handleAdvancePhase, handleRestorePhase,
  handleForcePhaseAdvance, handleGetModelConfidence, handleGetAutoThreshold,
  handleProcessTrainingImage, handleSaveTrainingDescriptor, handleResetFaceData,
} from "./lib/handlers-phase.js";
// handlers-review.js — aliased to avoid name conflict with local handleReviewApprove function
import {
  handleGetReviewQueue,
  handleReviewApprove as _handlerReviewApprove,
  handleReviewReject as _handlerReviewReject,
  handleReviewTrainOnly as _handlerReviewTrainOnly,
  handleUndoLastReview as _handlerUndoLastReview,
  handleGetPendingDownloadsCount,
  handleReEvaluateQueue, handleFinalVerification,
} from "./lib/handlers-review.js";
import {
  handleGetDiagnosticLog, handleClearDiagnosticLog, handleSetDebugCaptureMode,
  handleRunAttendanceDiagnostic,
} from "./lib/handlers-debug.js";
import {
  handleTestConnection, handleDiscoverCentres, handleGetDownloadedStories,
  handleAddFileToManifest, handleGetCacheStats, handleClearCaches,
  handleClearAllRejections, handleRecycleOffscreen, handleActiveDatabaseInfo,
  handleGetActivityLog, handleClearActivityLog, handleLogToActivity,
  handleRewriteExifOnly, handleGenerateStoryCard,
} from "./lib/handlers-misc.js";

// ── Small helpers needed by message handlers (not worth a full module) ──
const _extractFilenameFromUrl = (url) => (url.split("/").pop() || "").split("?")[0];
const _isVideoMedia = (item) => {
  const ct = (item.content_type || item.type || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  const fn = item.filename || _extractFilenameFromUrl(item.original_url || "");
  return /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(fn);
};


/* ================================================================== */
/*  Scan state                                                         */
/* ================================================================== */

// Declare ALL volatile scan-state variables here, BEFORE any chrome.storage
// calls, to avoid a Temporal Dead Zone (TDZ) ReferenceError when the service
// worker restarts and the restore .then() runs before the declarations below.

let isScanning      = false;
let cancelRequested = false;

/**
 * Temporary history of the last reviewed item for undo support.
 * Stores { action: "approve"|"reject", item, descriptor? }
 */
let lastReviewAction = null;

/** Global request counter for coffee-break logic. */
let _requestCount = 0;

/** Number of requests before the next Coffee Break. Re-randomised after each break. */
let _coffeeBreakAt = Math.floor(Math.random() * 11) + 15; // 15–25

// Restore volatile scan state from session storage in case the service worker
// was suspended and re-activated (e.g. during a Coffee Break idle period).
// This must run after all variable declarations above to avoid TDZ errors.
chrome.storage.session
  .get(["isScanning", "cancelRequested", "_requestCount", "_coffeeBreakAt", "lastReviewAction"])
  .then((data) => {
    isScanning        = data.isScanning      ?? false;
    cancelRequested   = data.cancelRequested ?? false;
    _requestCount     = data._requestCount   ?? 0;
    lastReviewAction  = data.lastReviewAction ?? null;

    // Safety check: if the restored _coffeeBreakAt is stale (already exceeded
    // by the restored counter, or not set), reset it to a fresh random value
    // so the next Coffee Break fires at the correct time.
    const restored = data._coffeeBreakAt ?? null;
    if (restored !== null && restored > _requestCount) {
      _coffeeBreakAt = restored;
    } else {
      _coffeeBreakAt = Math.floor(Math.random() * 11) + 15;
    }
  })
  .catch(() => {});

/* ================================================================== */
/*  Diagnostic API Log                                                 */
/* ================================================================== */

/**
 * In-memory store for raw API responses captured during profile/centre
 * discovery.  Kept in memory only (not persisted) so it is fresh on each
 * service-worker activation.  Consumers can retrieve it via the
 * GET_DIAGNOSTIC_LOG message handler.
 *
 * Each entry: { url, timestamp, data }
 */
const _diagnosticLog = [];

/**
 * Maximum number of entries kept in _diagnosticLog.  Raised to 500 when
 * debugCaptureMode is active so a full scan can be captured without trimming.
 * NOTE: This is a temporary debug feature — disable during normal use to save memory.
 */
const DIAG_LOG_MAX_NORMAL = 50;
const DIAG_LOG_MAX_DEBUG  = 500;

/**
 * When true, every apiFetch() response is captured in _diagnosticLog.
 * Loaded from chrome.storage.local and toggled via SET_DEBUG_CAPTURE_MODE.
 * Disabled by default — only enable when actively debugging API structure.
 */
let debugCaptureMode = false;

// Load persisted debugCaptureMode on startup.
chrome.storage.local.get("debugCaptureMode", ({ debugCaptureMode: stored }) => {
  if (stored === true) debugCaptureMode = true;
});

/**
 * Append a raw API response to the diagnostic log.
 * @param {string} url  – the API endpoint that was called
 * @param {*} data      – the parsed JSON response body
 */
function _diagLog(url, data) {
  const max = debugCaptureMode ? DIAG_LOG_MAX_DEBUG : DIAG_LOG_MAX_NORMAL;
  _diagnosticLog.push({ url, timestamp: new Date().toISOString(), data });
  if (_diagnosticLog.length > max) {
    _diagnosticLog.splice(0, _diagnosticLog.length - max);
  }
}

/* ================================================================== */
/*  Activity Log                                                       */
/* ================================================================== */

const LOG_MAX_ENTRIES = 200;

/**
 * In-memory buffer for log entries pending a storage flush.
 * Entries accumulate here and are flushed to chrome.storage.local in a
 * single batched write every LOG_FLUSH_INTERVAL_MS, reducing the number
 * of sequential read–write round-trips during large scans from one per
 * log line to roughly one per flush interval.
 */
const _logBuffer   = [];
let   _logFlushTimer = null;
const LOG_FLUSH_INTERVAL_MS = 500;

function _scheduleLogFlush() {
  if (_logFlushTimer !== null) return;
  _logFlushTimer = setTimeout(async () => {
    _logFlushTimer = null;
    if (_logBuffer.length === 0) return;
    const batch = _logBuffer.splice(0);
    try {
      const { activityLog = [] } = await chrome.storage.local.get("activityLog");
      activityLog.push(...batch);
      if (activityLog.length > LOG_MAX_ENTRIES) {
        activityLog.splice(0, activityLog.length - LOG_MAX_ENTRIES);
      }
      await chrome.storage.local.set({ activityLog });
    } catch {
      // Non-fatal: entries were already broadcast to the popup in real-time.
    }
  }, LOG_FLUSH_INTERVAL_MS);
}

/**
 * Log a message at the given severity level.
 * Buffers entries and flushes to chrome.storage.local every 500 ms to
 * avoid a storage write-storm during large scans, while still broadcasting
 * each entry to the popup in real-time.
 *
 * @param {"INFO"|"SUCCESS"|"WARNING"|"ERROR"} level
 * @param {string} message
 * @param {string} [storyDate] Optional story date in YYYY-MM-DD format.
 *   When provided it is formatted as DD/MM/YYYY and stored on the entry so
 *   the popup can display the story's own date instead of the wall-clock date.
 */
function logger(level, message, storyDate = null, meta = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (storyDate) entry.storyDate = formatDateDMY(storyDate);
  // Structured metadata for Activity Log display (childName, centreName, roomName, etc.)
  if (meta) entry.meta = meta;

  // Buffer for batched storage write
  _logBuffer.push(entry);
  _scheduleLogFlush();

  // Broadcast to popup (fire-and-forget)
  chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }).catch(() => {});

  // Return a resolved promise so existing `await logger(…)` call-sites
  // continue to work without changes.
  return Promise.resolve();
}

// formatDateDMY, formatETA → lib/metadata-helpers.js

// DELAY_PROFILES, smartDelay, STORYPARK_BASE, AuthError, RateLimitError, apiFetch → lib/api-client.js
// NOTE: apiFetch + smartDelay are still called below (they work via imports above)

/* ================================================================== */
/*  Offscreen document                                                 */
/* ================================================================== */

let offscreenReady    = false;
let offscreenCreating = null;

async function ensureOffscreen() {
  if (offscreenReady) return;
  // If another concurrent call is already creating the document, wait for it
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = (async () => {
    const exists = await chrome.offscreen.hasDocument().catch(() => false);
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["BLOBS"],
        justification: "Face recognition and EXIF processing for Storypark images",
      });
    }
    offscreenReady = true;
  })().finally(() => {
    offscreenCreating = null;
  });
  await offscreenCreating;
}

/**
 * Send a message to the offscreen document and await its response.
 * If the document has crashed or not yet finished initializing (connection
 * error / message port closed), reset the ready flag, wait briefly for the
 * new document to boot, and retry up to two times before giving up.
 *
 * @param {Object}  message
 * @param {number}  [_retryCount=0]  Internal retry counter — do not pass externally.
 */
async function sendToOffscreen(message, _retryCount = 0) {
  await ensureOffscreen();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || "";
        const isConnErr =
          errMsg.includes("Could not establish connection") ||
          errMsg.includes("The message port closed");
        // Retry up to 2 times with an increasing back-off to give the offscreen
        // document time to finish loading its module scripts after (re-)creation.
        if (_retryCount < 2 && isConnErr) {
          offscreenReady = false;
          const delayMs = 500 * (_retryCount + 1); // 500 ms, then 1000 ms
          setTimeout(() => {
            sendToOffscreen(message, _retryCount + 1).then(resolve).catch(reject);
          }, delayMs);
        } else {
          reject(new Error(errMsg));
        }
      } else if (!response || response.ok === false) {
        reject(new Error(response?.error || "Unknown offscreen error"));
      } else {
        resolve(response);
      }
    });
  });
}

// sanitizeSavePath → lib/metadata-helpers.js (imported above)

// ── Download pipeline → lib/download-pipe.js (imported above) ──────────────
// Register the download changed handler (ONCE - prevents double-handler bug)
chrome.downloads.onChanged.addListener(handleDownloadChanged);

// Internal helpers still needed locally (sendToOffscreen uses these in the background pipeline)
let   _activeDownloads = 0;
const _downloadQueue   = [];
const _pendingDownloadIds = new Map();
function _releaseDownloadSlot() {
  _activeDownloads = Math.max(0, _activeDownloads - 1);
  const next = _downloadQueue.shift();
  if (next) next();
}

// downloadBlob, downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen → lib/download-pipe.js (imported)
// _dataUrlToBlob, _enqueueDownload are internal to download-pipe.js

/* ================================================================== */
/*  Memory instrumentation (passive — logs only, no behaviour change)  */
/* ================================================================== */

/**
 * Report service-worker memory usage at a point in time.
 * Uses performance.memory (Chrome-only, non-standard but widely available
 * in extension service workers). Falls back to navigator.deviceMemory if
 * performance.memory is unavailable. Silent if neither is available.
 *
 * Logged at INFO level only — never WARNING — so it doesn't pollute the
 * Activity Log. Also prints to console for DevTools inspection.
 */
async function logMemorySnapshot(contextLabel) {
  try {
    let line = `[MEM] ${contextLabel}`;
    if (typeof performance !== "undefined" && performance.memory) {
      const used  = (performance.memory.usedJSHeapSize  / 1048576).toFixed(1);
      const total = (performance.memory.totalJSHeapSize / 1048576).toFixed(1);
      const limit = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0);
      line += ` — JS heap ${used}/${total} MB (limit ${limit} MB)`;
    }
    line += ` — downloads active=${_activeDownloads} queued=${_downloadQueue.length}`;
    console.log(line);
  } catch {
    // Non-fatal — instrumentation must never break a scan.
  }
}

/**
 * Yield the microtask queue and give V8 a chance to run GC between stories.
 * A short setTimeout (not setImmediate) is used because service workers don't
 * expose setImmediate — but the 10 ms delay is enough for any pending
 * microtasks to drain and for the GC to reclaim per-story allocations.
 */
function idleYield(ms = 10) {
  return new Promise(r => setTimeout(r, ms));
}


/* ================================================================== */
/*  Profile & children                                                 */
/* ================================================================== */

/**
 * Fetch the Storypark user profile, extract the children list, and cache
 * it in chrome.storage.local as { children: [{id, name}] }.
 *
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function loadAndCacheProfile() {
  try {
    const meUrl = `${STORYPARK_BASE}/api/v3/users/me`;
    const data = await apiFetch(meUrl);
    _diagLog(meUrl, data);

    const rawChildren = data.user?.children || data.children || [];
    const children = rawChildren.map((c) => ({
      id: String(c.id),
      name: c.name || c.display_name || `Child ${c.id}`,
    }));
    const totalStoryCount =
      data.user?.administered_family_children_teacher_stories ??
      data.administered_family_children_teacher_stories ??
      null;
    const storageUpdate = { children };
    if (totalStoryCount !== null) storageUpdate.totalStoryCount = totalStoryCount;
    await chrome.storage.local.set(storageUpdate);

    // Auto-discover centres/communities from the profile response.
    // The API may include them under various keys; we merge whatever we find.
    const rawCommunities =
      data.user?.communities  ||
      data.communities        ||
      data.user?.services     ||
      data.services           ||
      [];
    const namesFromArray = rawCommunities
      .map((c) => c.name || c.display_name || c.community_name || c.service_name || "")
      .filter(Boolean);

    // Also capture any scalar centre/service name exposed directly on the user object.
    const scalarNames = [
      data.user?.community_name,
      data.user?.service_name,
      data.user?.centre_name,
    ].filter(Boolean);

    const names = [...new Set([...namesFromArray, ...scalarNames])];
    if (names.length > 0) {
      await discoverCentres(names);
      // Persist the first community as the active centre name for use as a
      // fallback when individual stories do not carry a community_name field.
      const { activeCentreName } = await chrome.storage.local.get("activeCentreName");
      if (!activeCentreName) {
        await chrome.storage.local.set({ activeCentreName: names[0] });
      }
    }

    // Fetch institutions from the user profile if present, and try the
    // dedicated /api/v3/institutions/{id} endpoint for each one.
    const userInstitutions =
      data.user?.institutions ||
      data.institutions       ||
      [];
    await _fetchAndDiscoverInstitutions(userInstitutions);

    // Also fetch each child's individual profile to extract companies[].name.
    // Many accounts don't expose centre names at the /users/me level, but the
    // child profile endpoint reliably includes them under child.companies[].
    // Fetched sequentially to avoid concurrent requests that could trigger
    // rate-limit (429/403) responses.
    const childCentreNames = [];
    for (const child of children) {
      try {
        const childUrl  = `${STORYPARK_BASE}/api/v3/children/${child.id}`;
        const childData = await apiFetch(childUrl);
        _diagLog(childUrl, childData);

        const childObj  = childData.child || childData;
        const companies = childObj.companies || childObj.services || [];
        for (const co of companies) {
          const n = co.name || co.display_name || "";
          if (n) childCentreNames.push(n);
        }

        // Also look for institutions on the child profile.
        const childInstitutions = childObj.institutions || childObj.institution;
        if (childInstitutions) {
          await _fetchAndDiscoverInstitutions(
            Array.isArray(childInstitutions) ? childInstitutions : [childInstitutions]
          );
        }
      } catch (err) {
        // Non-fatal — skip this child if the fetch fails
        console.warn(`Failed to fetch profile for child ${child.id}:`, err.message);
      }
    }
    if (childCentreNames.length > 0) {
      await discoverCentres([...new Set(childCentreNames)]);
      const { activeCentreName } = await chrome.storage.local.get("activeCentreName");
      if (!activeCentreName) {
        await chrome.storage.local.set({ activeCentreName: childCentreNames[0] });
      }
    }

    // Also attempt to fetch centres directly from the dedicated /api/v3/centres
    // endpoint.  This returns structured {name, address, suburb, state} objects
    // for every centre linked to the user's account, which is more reliable than
    // inferring names from child/profile data alone.
    await fetchAndDiscoverCentresFromApi();

    // For family accounts, the centres are often found at /api/v3/family_centres
    await fetchAndDiscoverFamilyCentresFromApi();

    return children;
  } catch (err) {
    await logger("ERROR", `Profile fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch centre details from the Storypark /api/v3/centres endpoint and merge
 * any newly-discovered centres into centreLocations storage.
 * Extracts both name and address (when available) and auto-geocodes using
 * the Nominatim OSM API.  Non-fatal — silently skips on auth or network errors.
 */
async function fetchAndDiscoverCentresFromApi() {
  try {
    const centresUrl = `${STORYPARK_BASE}/api/v3/centres`;
    const data = await apiFetch(centresUrl);
    _diagLog(centresUrl, data);

    const centres = data.centres || data.services || [];
    if (!centres.length) return;

    const entries = centres
      .map((c) => {
        const name = (c.name || c.display_name || "").trim();
        if (!name) return null;
        // Build a human-readable address string from whatever fields the API returns.
        const addrParts = [c.address, c.suburb, c.state, c.postcode].filter(Boolean);
        const address = addrParts.length > 0 ? addrParts.join(", ") : null;
        return { name, address };
      })
      .filter(Boolean);

    if (entries.length > 0) {
      await discoverCentres(entries);
    }
  } catch (err) {
    // Non-fatal — /api/v3/centres may not be accessible for all account types
    console.warn("[centres] /api/v3/centres fetch failed:", err.message);
  }
}

/**
 * Fetch centre details from the Storypark /api/v3/family_centres endpoint.
 * This is often where family accounts have their centres listed.
 */
async function fetchAndDiscoverFamilyCentresFromApi() {
  // Try both URL variants: /api/v3/family/centres (slash) and /api/v3/family_centres (underscore)
  // Different Storypark account types may use one or the other.
  let data = null;
  for (const path of ["/api/v3/family/centres", "/api/v3/family_centres"]) {
    try {
      const centresUrl = `${STORYPARK_BASE}${path}`;
      data = await apiFetch(centresUrl);
      _diagLog(centresUrl, data);
      break; // success — use this response
    } catch {
      // Try the next path variant
    }
  }
  try {
    if (!data) return;

    const centres = data.centres || data.services || [];
    if (!centres.length) return;

    const entries = centres
      .map((c) => {
        const name = (c.name || c.display_name || "").trim();
        if (!name) return null;
        const addrParts = [c.address, c.suburb, c.state, c.postcode].filter(Boolean);
        const address = addrParts.length > 0 ? addrParts.join(", ") : null;
        return { name, address };
      })
      .filter(Boolean);

    if (entries.length > 0) {
      await discoverCentres(entries);
      
      // Also set activeCentreName if not set
      const { activeCentreName } = await chrome.storage.local.get("activeCentreName");
      if (!activeCentreName && entries[0].name) {
        await chrome.storage.local.set({ activeCentreName: entries[0].name });
      }
    }
  } catch (err) {
    console.warn("[centres] /api/v3/family_centres fetch failed:", err.message);
  }
}

/**
 * Given an array of institution objects (each expected to have at least an
 * `id` field), fetch `/api/v3/institutions/{id}` for each one and merge the
 * resulting name+address into centreLocations.  Non-fatal — errors are
 * logged to the console and skipped.
 *
 * @param {Array<{id: string|number, name?: string}>} institutions
 */
async function _fetchAndDiscoverInstitutions(institutions) {
  if (!Array.isArray(institutions) || institutions.length === 0) return;
  const entries = [];
  for (const inst of institutions) {
    const id = inst?.id;
    if (!id) continue;
    try {
      const instUrl  = `${STORYPARK_BASE}/api/v3/institutions/${id}`;
      const instData = await apiFetch(instUrl);
      _diagLog(instUrl, instData);

      const obj  = instData.institution || instData;
      const name = (obj.name || obj.display_name || "").trim();
      if (!name) continue;
      const addrParts = [obj.address, obj.suburb, obj.state, obj.postcode].filter(Boolean);
      const address   = addrParts.length > 0 ? addrParts.join(", ") : null;
      entries.push({ name, address });
    } catch (err) {
      console.warn(`[institutions] fetch failed for id ${id}:`, err.message);
    }
  }
  if (entries.length > 0) {
    await discoverCentres(entries);
  }
}

// geocodeCentre, discoverCentres → lib/api-client.js (imported above)

/* ================================================================== */
/*  Story feed pagination — local copy for runExtraction              */
/* ================================================================== */
// NOTE: fetchStorySummaries and all scan helpers below are called by
// the LOCAL runExtraction function. They will be removed when
// runExtraction is fully moved to lib/scan-engine.js.
// TODO: Remove this entire section in the next refactoring pass.

/* ================================================================== */
/*  Story feed pagination                                              */
/* ================================================================== */

/**
 * Fetch story summaries for a child, paginating until either the end of
 * the feed or (in EXTRACT_LATEST mode) a previously seen story is found.
 *
 * @param {string} childId
 * @param {"EXTRACT_LATEST"|"DEEP_RESCAN"} mode
 * @param {string} [childName]
 * @returns {Promise<Array<{id, created_at}>>}
 */
/**
 * Fetch story summaries for a child, with optional date cutoff.
 *
 * Stories are returned newest-first by the Storypark API.  When cutoffDate
 * is provided, pagination stops as soon as the oldest story on a page is
 * older than the cutoff — so a "last 30 days" scan only fetches 1-2 pages
 * instead of walking years of history.  This dramatically reduces both RAM
 * usage and API calls for date-limited scans.
 *
 * @param {string}    childId
 * @param {string}    mode         "EXTRACT_LATEST" | "DEEP_RESCAN"
 * @param {string}    childName    For log messages
 * @param {Date|null} cutoffDate   Stop collecting stories older than this date.
 *                                 null = no cutoff (all time).
 */
async function fetchStorySummaries(childId, mode, childName, cutoffDate = null, toDate = null) {
  // In EXTRACT_LATEST, always re-check stories from today and yesterday.
  // This picks up: (1) routines added to a story after the first scan,
  // (2) story text or photos added by the educator later in the day.
  // Stories from more than 2 days ago that are already processed are skipped normally.
  const _today     = new Date().toISOString().split("T")[0];
  const _yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
  const knownIds   = mode === "EXTRACT_LATEST"
    ? new Set(
        (await getProcessedStories())
          .filter(s => s.date !== _today && s.date !== _yesterday) // re-check last 2 days
          .map(s => s.storyId)
      )
    : new Set();

  const summaries = [];
  let pageToken   = null;
  let pageNum     = 0;

  while (true) {
    // Honour cancellation requests during long pagination runs.
    if (cancelRequested) break;

    const url = new URL(
      `${STORYPARK_BASE}/api/v3/children/${childId}/stories`
    );
    url.searchParams.set("sort_by", "updated_at");
    url.searchParams.set("story_type", "all");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const data    = await apiFetch(url.toString());
    const stories = data.stories || data.items || [];

    let hitKnown  = false;
    let hitCutoff = false;
    for (const s of stories) {
      const id = String(s.id);
      if (knownIds.has(id)) {
        hitKnown = true;
        break;
      }
      // Date cutoff: stories arrive newest-first, so the first story older
      // than the cutoff means all subsequent stories are also older — stop.
      if (cutoffDate && s.created_at && new Date(s.created_at) < cutoffDate) {
        hitCutoff = true;
        break;
      }
      summaries.push({ id, created_at: s.created_at, title: s.title || s.excerpt || "" });
    }

    pageToken = data.next_page_token || null;
    pageNum++;

    // Show running count + date range so the user sees real progress
    const oldest     = summaries.length > 0 ? summaries[summaries.length - 1].created_at : null;
    const oldestDate = oldest ? formatDateDMY(oldest.split("T")[0]) : "";
    const dateRange  = oldestDate ? ` (back to ${oldestDate})` : "";
    const cutoffNote = cutoffDate ? ` [cutoff: ${formatDateDMY(cutoffDate.toISOString().split("T")[0])}]` : "";
    await logger("INFO", `Scanning${childName ? ` ${childName}` : ""}… found ${summaries.length} stories${dateRange}${cutoffNote}`);

    if (hitKnown || hitCutoff || !pageToken) break;

    await smartDelay("FEED_SCROLL");
  }

  const cutoffMsg = cutoffDate ? ` (date cutoff: ${formatDateDMY(cutoffDate.toISOString().split("T")[0])})` : "";
  await logger("INFO", `Found ${summaries.length} stories to process${childName ? ` for ${childName}` : ""}${cutoffMsg}.`);
  return summaries;
}

/* ================================================================== */
/*  Daily routine data                                                 */
/* ================================================================== */

// Cache routine summaries by date string to avoid duplicate fetches
const routineCache = new Map();

async function fetchRoutineSummary(childId, dateStr) {
  const cacheKey = `${childId}:${dateStr}`;
  if (routineCache.has(cacheKey)) return routineCache.get(cacheKey);

  try {
    await smartDelay("FEED_SCROLL");

    // Try the v3 daily_routines endpoint first (confirmed from captures).
    // This returns { daily_routines: [{ date, events: [...] }], next_page_token }
    // We paginate to find the routine matching `dateStr`.
    let summary = "";
    try {
      summary = await _fetchRoutineV3(childId, dateStr);
    } catch {
      // Fallback: try the legacy /children/{id}/routines.json endpoint
      try {
        const url  = `${STORYPARK_BASE}/children/${childId}/routines.json?date=${dateStr}`;
        const data = await apiFetch(url);
        summary = _buildRoutineSummaryLegacy(data);
      } catch {
        // Both endpoints failed — return empty
      }
    }

    routineCache.set(cacheKey, summary);
    return summary;
  } catch {
    return { summary: "", detailed: "" };
  }
}

/**
 * Fetch daily routine events for a specific date using the v3 API.
 * The endpoint is paginated: /api/v3/children/{id}/daily_routines?page_token=null
 * Each page returns { daily_routines: [{ date, events: [...] }], next_page_token }.
 * We search through pages until we find the matching date or run out of pages.
 */
async function _fetchRoutineV3(childId, dateStr) {
  let pageToken = "null";
  let maxPages = 5; // limit pagination to avoid excessive API calls

  while (maxPages-- > 0) {
    const url = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${pageToken}`;
    const data = await apiFetch(url);
    const routines = data.daily_routines || [];

    for (const routine of routines) {
      if (routine.date === dateStr) {
        return _buildRoutineDataV3(routine.events || []);
      }
    }

    pageToken = data.next_page_token;
    if (!pageToken) break;
    await smartDelay("FEED_SCROLL");
  }

  return { summary: "", detailed: "" };
}

/**
 * Build routine data from v3 daily_routine events array.
 * Each event has: { title, routine_type, event_type, description, notes, occurred_at, ... }
 *
 * Returns { summary, detailed }:
 *   summary  — comma-separated titles (e.g. "Drink, Nappy - Wet, Sleep")
 *   detailed — timestamped lines (e.g. "8:40 AM - Drink (80ml)")
 */
function _buildRoutineDataV3(events) {
  const titles = [];
  const lines  = [];
  // Sort events by occurred_at (chronological order)
  const sorted = [...events].sort((a, b) => {
    const ta = a.occurred_at || "";
    const tb = b.occurred_at || "";
    return ta.localeCompare(tb);
  });
  for (const evt of sorted) {
    const title = evt.title || evt.full_description || evt.description || evt.routine_type || "";
    if (!title) continue;
    titles.push(title);
    // Format timestamp as "H:MMam/pm" (e.g. "9:11am", "12:00pm")
    let timeStr = "";
    if (evt.occurred_at) {
      const d = new Date(evt.occurred_at);
      if (!isNaN(d.getTime())) {
        const h    = d.getHours();
        const m    = d.getMinutes();
        const ampm = h >= 12 ? "pm" : "am";
        const h12  = h % 12 || 12;
        timeStr = `${h12}:${String(m).padStart(2, "0")}${ampm}`;
      }
    }
    // Include notes/quantity if available (e.g. food description, ml amount)
    const notesParts = [];
    if (evt.notes) notesParts.push(evt.notes);
    if (evt.bottle?.quantity) notesParts.push(`${evt.bottle.quantity}${evt.bottle.measurement || "ml"}`);
    if (evt.nappy?.status && !title.toLowerCase().includes(evt.nappy.status)) notesParts.push(evt.nappy.status);
    const noteSuffix = notesParts.length ? ` (${notesParts.join(", ")})` : "";
    lines.push(timeStr ? `${timeStr} - ${title}${noteSuffix}` : `${title}${noteSuffix}`);
  }
  return {
    summary:  titles.join(", "),
    detailed: lines.join("\n"),
  };
}

/**
 * Build routine summary from the legacy /routines.json endpoint format.
 * Response has top-level arrays: { sleeps: [...], meals: [...], ... }
 */
function _buildRoutineSummaryLegacy(data) {
  const events = [];
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const items = data[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const desc =
          item.description || item.summary || item.type || item.name || "";
        if (desc) events.push(desc);
      }
    }
  }
  const summary = events.join(", ");
  return { summary, detailed: summary }; // legacy format has no timestamps
}

/* ================================================================== */
/*  Attendance filtering                                               */
/* ================================================================== */

/** Map day index (0=Sun) to lowercase day name for regular_days comparison. */
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Bulk-fetch routine dates for a child to build an attendance set.
 * Returns { attendanceMap: Map<date, summary>, oldestDate: string|null }.
 * The oldestDate is used to avoid filtering stories that predate our routine data.
 * Fetches up to maxPages of daily_routines (100 by default for full history).
 *
 * @param {string} childId
 * @param {number} [maxPages=100]
 * @returns {Promise<{attendanceMap: Map<string, string>, oldestDate: string|null}>}
 */
async function bulkFetchAttendanceDates(childId, maxPages = 100) {
  const attendanceMap = new Map();
  let oldestDate = null;
  let pageToken = "null";
  let pages = 0;

  while (pages < maxPages) {
    try {
      const url = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${pageToken}`;
      const data = await apiFetch(url);
      const routines = data.daily_routines || [];

      for (const r of routines) {
        if (r.date && !attendanceMap.has(r.date)) {
          const routineData = _buildRoutineDataV3(r.events || []);
          attendanceMap.set(r.date, routineData);
          // Track oldest date to know the boundary of our data
          if (!oldestDate || r.date < oldestDate) oldestDate = r.date;
        }
      }

      pageToken = data.next_page_token;
      if (!pageToken) break;
      pages++;
      await new Promise(r => setTimeout(r, 800));
    } catch {
      break;
    }
  }

  return { attendanceMap, oldestDate };
}

/* ================================================================== */
/*  Story output helpers — shared by all HTML/card generation paths   */
/* ================================================================== */

/**
 * Extract a plain string from a routine value that may be a string or
 * a { summary, detailed } object.  Always returns a string (never null/undefined).
 *
 * @param {string|{summary:string,detailed:string}|null} r
 * @returns {string}
 */
function _routineStr(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  return r.detailed || r.summary || "";
}

/**
 * Build the canonical on-disk base path for a story folder.
 * e.g. "Storypark Smart Saver/Harry Hill/Stories/2026-03-03 — Tuesday in Nursery One"
 *
 * @param {string} childName
 * @param {string} folderName
 * @returns {string}
 */
function _storyBasePath(childName, folderName) {
  return `Storypark Smart Saver/${sanitizeName(childName)}/Stories/${folderName}`;
}

/**
 * Regenerate root children index + each child's per-story index HTML page.
 * Called from BUILD_HTML_STRUCTURE, AUDIT_AND_REPAIR, and REGENERATE_FROM_DISK handlers.
 */
async function _rebuildIndexPages(children) {
  try {
    const rootHtml = buildChildrenIndexHtml(children);
    const rootRes  = await sendToOffscreen({
      type: "DOWNLOAD_TEXT", text: rootHtml,
      savePath: "Storypark Smart Saver/index.html", mimeType: "text/html",
    });
    if (rootRes.dataUrl && rootRes.savePath) await downloadHtmlFile(rootRes.dataUrl, rootRes.savePath);

    for (const child of children) {
      const manifests = await getDownloadedStories(child.id).catch(() => []);
      if (manifests.length === 0) continue;
      const childIndexHtml = buildMasterIndexHtml(child.name, manifests);
      const childPath = `Storypark Smart Saver/${sanitizeName(child.name)}/Stories/index.html`;
      const ciRes = await sendToOffscreen({
        type: "DOWNLOAD_TEXT", text: childIndexHtml,
        savePath: childPath, mimeType: "text/html",
      });
      if (ciRes.dataUrl && ciRes.savePath) await downloadHtmlFile(ciRes.dataUrl, ciRes.savePath);
    }
  } catch (err) {
    console.warn("[_rebuildIndexPages] Failed:", err.message);
  }
}

// buildStoryHtml, buildChildrenIndexHtml, buildMasterIndexHtml → lib/html-builders.js (imported above)
// extractRoomFromTitle, buildRoomMap → lib/scan-engine.js (imported above)
// sanitizeName, stripHtml, stripEmojis, calculateAge, buildExifMetadata, sanitiseForExif, sanitiseForIptcCaption → lib/metadata-helpers.js (imported above)

// DUMMY to avoid "function not found" - these are needed ONLY by the local runExtraction below
// They work via the imports at the top of this file.
function buildStoryHtml({ title, date, body, childName, childAge, roomName, centreName, educatorName, routineText, mediaFilenames }) {
  const dateDisplay = formatDateDMY(date) || date || "Unknown date";
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const childFirst = (childName || "").split(/\s+/)[0];

  // Media files live alongside story.html in the same folder
  const mediaHtml = (mediaFilenames || []).map(f => {
    const enc = encodeURIComponent(f);
    if (/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)) {
      return `<div class="photo"><video src="./${enc}" controls preload="metadata" style="width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);"></video></div>`;
    }
    return `<div class="photo"><img src="./${enc}" alt="Story photo" loading="lazy"></div>`;
  }).join("\n      ");

  // Attribution block — always shown (with or without routine)
  const attributionLines = [
    childAge
      ? `${escHtml(childName || "")} @ ${escHtml(childAge)}`
      : (childName ? escHtml(childName) : ""),
    roomName   ? escHtml(roomName)   : "",
    centreName ? escHtml(centreName) : "",
    "Storypark / Storypark Smart Saver",
  ].filter(Boolean);
  const attributionHtml = attributionLines.join("<br>");

  // Routine + attribution section
  const routineSection = routineText
    ? `
  <div class="routine-block">
    <div class="divider-line"></div>
    <div class="routine-label">📋 ${childFirst ? escHtml(childFirst) + "'s" : "Daily"} Routine</div>
    <div class="routine-text">${escHtml(routineText)}</div>
    <div class="divider-line"></div>
    <div class="attribution">${attributionHtml}</div>
  </div>`
    : `
  <div class="attribution solo">${attributionHtml}</div>`;

  // Story body — placeholder when empty (e.g. recovered-from-disk stories)
  const bodyHtml = body
    ? `<div class="body">${escHtml(body).replace(/\n/g, "<br>")}</div>`
    : `<div class="body empty">📄 Story text not yet available — run a scan to restore the full story.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title || "Story")} — ${dateDisplay}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Georgia, 'Times New Roman', serif; max-width: 800px; margin: 0 auto; padding: 56px 40px; color: #333; line-height: 1.6; }

    nav { margin-bottom: 20px; font-size: 14px; }
    nav a { color: #0f3460; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    .header { border-bottom: 2px solid #0f3460; padding-bottom: 16px; margin-bottom: 24px; }
    .header h1 { font-size: 24px; color: #0f3460; margin-bottom: 4px; }
    .meta { font-size: 14px; color: #666; }
    .meta span { margin-right: 16px; }
    .body { font-size: 16px; margin-bottom: 24px; white-space: pre-wrap; }
    .body.empty { color: #999; font-style: italic; font-family: -apple-system, sans-serif; font-size: 14px; }
    .photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .photo img { width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); cursor: pointer; transition: opacity 0.15s; }
    .photo img:hover { opacity: 0.9; }
    .photo img.zoomed { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; object-fit: contain; background: rgba(0,0,0,0.92); z-index: 9999; border-radius: 0; cursor: zoom-out; padding: 24px; }
    .routine-block { margin-bottom: 24px; }
    .divider-line { border-top: 2px solid #c5d3e8; margin: 14px 0; }
    .routine-label { font-size: 15px; font-weight: bold; color: #0f3460; margin-bottom: 8px; }
    .routine-text { font-size: 14px; white-space: pre-line; color: #444; line-height: 1.8; margin-bottom: 14px; }
    .attribution { font-size: 13px; color: #555; line-height: 2.0; margin-bottom: 24px; }
    .attribution.solo { border-top: 1px solid #e0e8f0; padding-top: 16px; }
    .footer { font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 12px; }
    @media print { body { padding: 20px; } .photos { break-inside: avoid; } nav { display: none; } .photo img.zoomed { display: none; } }
  </style>
  <script>
    document.addEventListener('click', e => {
      const img = e.target.closest('.photo img');
      if (!img) { document.querySelectorAll('.photo img.zoomed').forEach(i => i.classList.remove('zoomed')); return; }
      img.classList.toggle('zoomed');
    });
  </script>
</head>
<body>
  <nav>
    <a href="../index.html">← Back to all stories</a> · 
    <a href="../../../index.html">← All children</a>
  </nav>
  <div class="header">
    <h1>${escHtml(title || "Story")}</h1>
    <div class="meta">
      <span>📅 ${dateDisplay}</span>
      ${childName ? `<span>👶 ${escHtml(childName)}${childAge ? ` (${escHtml(childAge)})` : ""}</span>` : ""}
      ${educatorName ? `<span>👩‍🏫 ${escHtml(educatorName)}</span>` : ""}
      ${roomName ? `<span>🏠 ${escHtml(roomName)}</span>` : ""}
      ${centreName ? `<span>🏫 ${escHtml(centreName)}</span>` : ""}
    </div>
  </div>

  ${bodyHtml}

  ${mediaHtml ? `<div class="photos">\n      ${mediaHtml}\n    </div>` : ""}

  ${routineSection}

  <div class="footer">
    Saved from Storypark by Storypark Smart Saver — ${new Date().toISOString().split("T")[0]}
  </div>
</body>
</html>`;
}

/* ================================================================== */
/*  Index page builders                                                */
/* ================================================================== */

/**
 * Build the root-level children index HTML page.
 * Shows all children with links to their story grids.
 *
 * @param {Array<{id: string, name: string}>} children
 * @returns {string} HTML string
 */
function buildChildrenIndexHtml(children) {
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cards = (children || []).map(c => {
    const safeName = sanitizeName(c.name);
    return `<a href="./${encodeURIComponent(safeName)}/Stories/index.html" class="child-card">
      <div class="child-emoji">👶</div>
      <div class="child-name">${escHtml(c.name)}</div>
      <div class="child-link">View stories →</div>
    </a>`;
  }).join("\n    ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storypark Smart Saver</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fa; color: #333; padding: 40px 20px; min-height: 100vh; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 28px; color: #0f3460; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #666; margin-bottom: 32px; }
    .children-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
    .child-card { display: flex; flex-direction: column; align-items: center; padding: 32px 20px; background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-decoration: none; color: inherit; transition: transform 0.15s, box-shadow 0.15s; }
    .child-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    .child-emoji { font-size: 48px; margin-bottom: 12px; }
    .child-name { font-size: 20px; font-weight: 700; color: #0f3460; margin-bottom: 8px; }
    .child-link { font-size: 13px; color: #4a90d9; }
    .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📸 Storypark Smart Saver</h1>
    <p class="subtitle">Choose a child to browse their stories</p>
    <div class="children-grid">
    ${cards}
    </div>
    <div class="footer">
      Saved from Storypark — ${new Date().toISOString().split("T")[0]}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Build the per-child master story index HTML page.
 * Shows all downloaded stories as a responsive card grid (Storypark-style).
 *
 * @param {string} childName
 * @param {Array} manifests — from getDownloadedStories()
 * @returns {string} HTML string
 */
function buildMasterIndexHtml(childName, manifests) {
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sorted = [...manifests].sort((a, b) => (b.storyDate || "").localeCompare(a.storyDate || ""));

  const cards = sorted.map(m => {
    const thumb = m.thumbnailFilename
      ? `<img src="./${encodeURIComponent(m.folderName)}/${encodeURIComponent(m.thumbnailFilename)}" alt="" loading="lazy">`
      : `<div class="no-thumb">📸</div>`;
    const date = formatDateDMY(m.storyDate) || m.storyDate || "";
    const meta = [
      m.educatorName ? `👩‍🏫 ${escHtml(m.educatorName)}` : "",
      m.roomName ? `🏠 ${escHtml(m.roomName)}` : "",
    ].filter(Boolean).join(" · ");
    const photoCount = (m.approvedFilenames || []).length;

    return `<a href="./${encodeURIComponent(m.folderName)}/story.html" class="story-card">
      <div class="card-thumb">${thumb}</div>
      <div class="card-body">
        <div class="card-date">${date}</div>
        <div class="card-title">${escHtml(m.storyTitle)}</div>
        ${meta ? `<div class="card-meta">${meta}</div>` : ""}
        <div class="card-excerpt">${escHtml((m.excerpt || "").substring(0, 120))}${(m.excerpt || "").length > 120 ? "…" : ""}</div>
        <div class="card-photos">${photoCount} photo${photoCount !== 1 ? "s" : ""}</div>
      </div>
    </a>`;
  }).join("\n    ");

  const totalPhotos = sorted.reduce((sum, m) => sum + (m.approvedFilenames || []).length, 0);
  const dateRange = sorted.length > 0
    ? `${formatDateDMY(sorted[sorted.length - 1].storyDate) || "?"} — ${formatDateDMY(sorted[0].storyDate) || "?"}`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(childName)} — Stories</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fa; color: #333; padding: 40px 20px; }
    .container { max-width: 1000px; margin: 0 auto; }
    nav { margin-bottom: 20px; font-size: 14px; }
    nav a { color: #0f3460; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    h1 { font-size: 28px; color: #0f3460; margin-bottom: 4px; }
    .stats { font-size: 14px; color: #666; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
    .story-card { display: flex; flex-direction: column; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-decoration: none; color: inherit; overflow: hidden; transition: transform 0.15s, box-shadow 0.15s; }
    .story-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
    .card-thumb { height: 180px; overflow: hidden; background: #e8edf3; display: flex; align-items: center; justify-content: center; }
    .card-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .no-thumb { font-size: 48px; color: #aaa; }
    .card-body { padding: 16px; flex: 1; }
    .card-date { font-size: 12px; color: #888; margin-bottom: 4px; }
    .card-title { font-size: 16px; font-weight: 700; color: #0f3460; margin-bottom: 6px; line-height: 1.3; }
    .card-meta { font-size: 12px; color: #666; margin-bottom: 6px; }
    .card-excerpt { font-size: 13px; color: #555; line-height: 1.4; margin-bottom: 8px; }
    .card-photos { font-size: 12px; color: #4a90d9; }
    .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <nav><a href="../../index.html">← All children</a></nav>
    <h1>📸 ${escHtml(childName)}'s Stories</h1>
    <p class="stats">${sorted.length} stories · ${totalPhotos} photos${dateRange ? ` · ${dateRange}` : ""} · Last updated ${new Date().toISOString().split("T")[0]}</p>
    <div class="grid">
    ${cards}
    </div>
    <div class="footer">Saved from Storypark by Storypark Smart Saver</div>
  </div>
</body>
</html>`;
}

/* ================================================================== */
/*  Room name extraction from story titles                             */
/* ================================================================== */

/**
 * Common room/classroom name suffixes used in Australian childcare centres.
 * These are matched case-insensitively after "in " in story titles.
 */
const ROOM_SUFFIXES = [
  "one", "two", "three", "four", "five", "six",
  "1", "2", "3", "4", "5", "6",
  "room", "class", "group",
  "kindy", "kinder", "kindergarten",
  "preschool", "pre-school",
  "nursery", "babies", "toddlers",
  "junior", "senior", "middle",
];

/**
 * Extract a room/classroom name from a story title.
 * Matches patterns like "… in Nursery One", "… in Senior Kindy 🤸",
 * "… in Nursery 1".
 *
 * Returns the room name string or null if no match found.
 *
 * @param {string} title
 * @returns {string|null}
 */
function extractRoomFromTitle(title) {
  if (!title) return null;
  // Strip emojis, trailing dates, and punctuation for cleaner matching
  const clean = title
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
    .replace(/\s*-?\s*\d{2}\/\d{2}\/\d{2,4}\s*$/, "") // strip trailing dates like "19/02/26" or "- 19/02/26"
    .replace(/[!?.]+\s*$/, "") // strip trailing punctuation
    .trim();

  // Match "in <RoomName>" at or near the end of the title.
  // RoomName = one or more capitalised words that include a known room suffix.
  // The regex captures everything after "in " until end of string.
  const match = clean.match(/\bin\s+([A-Z][a-zA-Z0-9]*(?:\s+[A-Za-z0-9]+)*)\s*$/i);
  if (!match) {
    // DEBUG: Log titles that contain "in" but didn't match our pattern
    if (debugCaptureMode && /\bin\s+[A-Z]/i.test(clean)) {
      _diagLog("room_extraction_miss", { title, clean, reason: "regex_no_match" });
    }
    return null;
  }

  const candidate = match[1].trim();
  // Validate: at least one word in the candidate must be a known room suffix
  const words = candidate.toLowerCase().split(/\s+/);
  const hasRoomWord = words.some((w) => ROOM_SUFFIXES.includes(w));
  if (!hasRoomWord) {
    // DEBUG: Log candidates that matched "in X" but failed suffix validation
    // These are likely unrecognised room names that should be added to ROOM_SUFFIXES
    if (debugCaptureMode) {
      _diagLog("room_extraction_unrecognised", { title, candidate, words, reason: "no_known_suffix" });
    }
    return null;
  }

  // Normalise: "Nursery 1" → "Nursery One", etc. for consistency
  return normaliseRoomName(candidate);
}

/**
 * Normalise room name variants to a canonical form.
 * "Nursery 1" / "nursery one" → "Nursery One"
 *
 * @param {string} name
 * @returns {string}
 */
function normaliseRoomName(name) {
  const numMap = { "1": "One", "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six" };
  // Replace trailing digit with word
  let normalised = name.replace(/\b(\d)\b/g, (_, d) => numMap[d] || d);
  // Title-case each word
  normalised = normalised.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  // Fix common casing: "Kindy" not "kindy", "Pre-School" etc.
  return normalised;
}

/**
 * Pre-scan story summaries to build a room-by-period map.
 * For each story that has a room name in its title, records (yearMonth → roomName).
 * Then for each period, the most frequent room name wins.
 *
 * Also fetches full story titles from the summaries. The feed-level summary
 * includes `title` directly (no extra API call needed).
 *
 * @param {Array<{id: string, created_at: string, title?: string}>} summaries
 * @returns {Map<string, string>} yearMonth ("2026-04") → dominant room name
 */
function buildRoomMap(summaries) {
  // Collect: yearMonth → { roomName → count }
  const periodCounts = new Map();

  for (const s of summaries) {
    const title = s.title || s.excerpt || "";
    const room = extractRoomFromTitle(title);
    if (!room) continue;

    const dateStr = s.created_at ? s.created_at.split("T")[0] : null;
    if (!dateStr) continue;
    const ym = dateStr.substring(0, 7); // "2026-04"

    if (!periodCounts.has(ym)) periodCounts.set(ym, new Map());
    const counts = periodCounts.get(ym);
    counts.set(room, (counts.get(room) || 0) + 1);
  }

  // For each period, pick the most common room name
  const roomMap = new Map();
  for (const [ym, counts] of periodCounts) {
    let bestRoom = "";
    let bestCount = 0;
    for (const [room, count] of counts) {
      if (count > bestCount) { bestRoom = room; bestCount = count; }
    }
    if (bestRoom) roomMap.set(ym, bestRoom);
  }

  return roomMap;
}

/**
 * Infer the room name for a story date using the pre-built room map.
 * Looks up the exact yearMonth first; if missing, finds the nearest
 * yearMonth with data (forward or backward) for continuity.
 *
 * @param {string} dateStr  YYYY-MM-DD
 * @param {Map<string, string>} roomMap  yearMonth → room name
 * @returns {string} room name or ""
 */
function inferRoom(dateStr, roomMap) {
  if (!dateStr || roomMap.size === 0) return "";
  const ym = dateStr.substring(0, 7);

  // Exact match
  if (roomMap.has(ym)) return roomMap.get(ym);

  // Find nearest period (within 3 months)
  const allPeriods = [...roomMap.keys()].sort();
  let bestDist = Infinity;
  let bestRoom = "";
  for (const p of allPeriods) {
    // Distance in months (approximate)
    const [py, pm] = p.split("-").map(Number);
    const [sy, sm] = ym.split("-").map(Number);
    const dist = Math.abs((py * 12 + pm) - (sy * 12 + sm));
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      bestRoom = roomMap.get(p);
    }
  }

  return bestRoom;
}

/* ================================================================== */
/*  Main extraction pipeline                                           */
/* ================================================================== */

/** Characters forbidden in filesystem filenames across Windows/macOS/Linux. */
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/** File extensions that indicate a video media item. */
const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

/**
 * Return true if a Storypark media item is a video rather than an image.
 * Checks content_type first, then falls back to file extension heuristics.
 *
 * @param {{ content_type?: string, type?: string, filename?: string, original_url?: string }} mediaItem
 * @returns {boolean}
 */
function isVideoMedia(mediaItem) {
  const ct = (mediaItem.content_type || mediaItem.type || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  const url = mediaItem.original_url || "";
  const filename = mediaItem.filename || extractFilenameFromUrl(url);
  return VIDEO_EXTENSIONS.test(filename);
}

/** Extract the filename portion from a URL, stripping query parameters. */
function extractFilenameFromUrl(url) {
  return (url.split("/").pop() || "").split("?")[0];
}

function sanitizeName(name) {
  return (name || "Unknown").replace(INVALID_FILENAME_CHARS, "_").trim() || "Unknown";
}

/**
 * Strip HTML tags from a string, collapse whitespace, and trim.
 * Handles non-string inputs defensively to prevent the
 * "(html || "").replace is not a function" crash that occurs when
 * Storypark returns display_content as an array of rich-text blocks
 * rather than a plain string.
 * @param {string|Array|any} html
 * @returns {string}
 */
function stripHtml(html) {
  if (html == null) return "";
  // Handle arrays (rich-text block format used by some Storypark API versions)
  if (Array.isArray(html)) {
    return html.map(b => {
      if (typeof b === "string") return stripHtml(b);
      return stripHtml(b?.text || b?.content || b?.value || "");
    }).join(" ").replace(/\s+/g, " ").trim();
  }
  if (typeof html !== "string") return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Strip emojis and other non-ASCII characters from text to prevent EXIF
 * corruption. EXIF uses ASCII/Latin-1 encoding; emojis and multi-byte
 * Unicode characters can corrupt the image file.
 *
 * @param {string} text
 * @returns {string} ASCII-safe text
 */
function stripEmojis(text) {
  if (!text) return "";
  // Remove emoji and symbol Unicode ranges, keeping basic Latin + extended Latin
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "")   // emoticons
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, "")   // misc symbols & pictographs
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "")   // transport & map
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "")   // flags
    .replace(/[\u{2600}-\u{26FF}]/gu, "")      // misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, "")      // dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")      // variation selectors
    .replace(/[\u{200D}]/gu, "")               // zero-width joiner
    .replace(/[\u{20E3}]/gu, "")               // combining enclosing keycap
    .replace(/[\u{E0020}-\u{E007F}]/gu, "")   // tags
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, "")   // supplemental symbols
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, "")   // chess symbols
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, "")   // symbols extended-A
    .replace(/[\u{2300}-\u{23FF}]/gu, "")      // misc technical
    .replace(/[\u{2B50}]/gu, "star")            // star
    .replace(/[\u{2764}]/gu, "heart")           // heart
    .replace(/\s{2,}/g, " ")                    // collapse multiple spaces
    .trim();
}

/**
 * Calculate child's age at a given date from their birthday.
 * Returns a human-readable string like "2 years 3 months" or "8 months".
 *
 * @param {string} birthday  YYYY-MM-DD format
 * @param {string} atDate    YYYY-MM-DD format (story date)
 * @returns {string} e.g. "1 year 5 months" or "3 months" or ""
 */
function calculateAge(birthday, atDate) {
  if (!birthday || !atDate) return "";
  const birth = new Date(birthday + "T00:00:00Z");
  const at    = new Date(atDate + "T00:00:00Z");
  if (isNaN(birth.getTime()) || isNaN(at.getTime()) || at < birth) return "";

  let years  = at.getUTCFullYear() - birth.getUTCFullYear();
  let months = at.getUTCMonth() - birth.getUTCMonth();
  if (at.getUTCDate() < birth.getUTCDate()) months--;
  if (months < 0) { years--; months += 12; }

  const parts = [];
  if (years > 0) parts.push(`${years} year${years !== 1 ? "s" : ""}`);
  if (months > 0) parts.push(`${months} month${months !== 1 ? "s" : ""}`);
  if (parts.length === 0) parts.push("newborn");
  return parts.join(" ");
}

/**
 * Build structured EXIF metadata for a photo.
 * Returns { title, subject, comments } where:
 *   title   → EXIF ImageDescription (short: "Harry - 8 months")
 *   subject → EXIF XPSubject (short story excerpt)
 *   comments → EXIF UserComment (full story + timestamped routine + attribution)
 *
 * Also returns a legacy `description` field (full text) for backward compatibility
 * with any code that still expects a single string.
 */
function buildExifMetadata(body, childFirstName, routineData, roomName, centreName, childAge = "") {
  // routineData may be a string (legacy) or { summary, detailed } object
  const routineSummary  = typeof routineData === "string" ? routineData : (routineData?.summary || "");
  const routineDetailed = typeof routineData === "string" ? routineData : (routineData?.detailed || "");

  // ── Title: short identifier ──
  const titleParts = [childFirstName || "Child"];
  if (childAge) titleParts.push(childAge);
  const title = stripEmojis(titleParts.join(" - "));

  // ── Subject: short excerpt of the story ──
  const plainBody = stripHtml(body);
  const subject = stripEmojis((plainBody || "").substring(0, 200));

  // ── Comments: full story + timestamped routine + attribution ──
  const commentParts = [];
  if (plainBody) commentParts.push(plainBody);
  if (routineDetailed || routineSummary) {
    const routineLabel = childFirstName ? `${childFirstName}'s Routine:` : "Routine:";
    const routineBody = routineDetailed || routineSummary;
    commentParts.push("------------------------------");
    commentParts.push(`${routineLabel}\n${routineBody}`);
  }
  commentParts.push("------------------------------");
  if (childFirstName && childAge) commentParts.push(`${childFirstName} @ ${childAge}`);
  if (roomName) commentParts.push(roomName);
  if (centreName) commentParts.push(centreName);
  commentParts.push("Storypark");
  const comments = stripEmojis(commentParts.join("\n"));

  // Legacy single-string description (backward compat for story HTML etc.)
  const description = comments;

  return { title, subject, comments, description };
}

/**
 * Strip non-ASCII characters for use in EXIF ASCII fields (Artist, Keywords, etc.).
 * Converts common Unicode punctuation to ASCII first, then removes remaining
 * non-printable/non-ASCII bytes.
 *
 * @param {string} text
 * @param {number} [maxLen=255]  EXIF ASCII field limit
 * @returns {string} ASCII-safe string
 */
function sanitiseForExif(text, maxLen = 255) {
  return (text || "")
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, "--")
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, maxLen);
}

/**
 * Truncate plain text to a maximum UTF-8 byte count for IPTC Caption-Abstract (2:120).
 * Uses TextEncoder for accurate UTF-8 byte measurement, gracefully truncating at a
 * character boundary to avoid splitting multi-byte sequences.
 *
 * @param {string} text   Already HTML-stripped plain text
 * @param {number} maxBytes  Max UTF-8 byte count (IPTC limit = 2000)
 * @returns {string}
 */
function sanitiseForIptcCaption(text, maxBytes = 2000) {
  const clean = (text || "").replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "").trim();
  try {
    const enc = new TextEncoder();
    const bytes = enc.encode(clean);
    if (bytes.length <= maxBytes) return clean;
    // Decode the truncated bytes, stripping any partial multi-byte char at the end
    return new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.slice(0, maxBytes))
      .replace(/\uFFFD.*$/, "")
      .trim();
  } catch {
    return clean.slice(0, maxBytes);
  }
}

/* ================================================================== */
/*  Auto-calibrating threshold                                         */
/* ================================================================== */

/**
 * Compute auto-calibrated face matching thresholds from the child's learned
 * positive and negative descriptor distributions.
 *
 * Uses intra-class similarity (positive vs positive) and inter-class
 * similarity (negative vs positive) to find the optimal separation point.
 * Returns null if insufficient data (< 5 positive, < 3 negative).
 *
 * @param {string} childId
 * @returns {Promise<Object|null>}
 */
async function computeAutoThreshold(childId) {
  const descData = await getDescriptors(childId).catch(() => null);
  if (!descData?.descriptors || descData.descriptors.length < 5) return null;
  const negDescs = await getNegativeDescriptors(childId).catch(() => []);
  if (negDescs.length < 3) return null;
  const posDescs = descData.descriptors;

  // Intra-class similarity: how similar are different photos of the same child?
  const posScores = [];
  for (let i = 0; i < posDescs.length && posScores.length < 200; i++) {
    for (let j = i + 1; j < posDescs.length && posScores.length < 200; j++) {
      posScores.push(matchSimilarityPct(posDescs[i], posDescs[j]));
    }
  }
  // Inter-class similarity: how similar are "not my child" faces to the best positive?
  const negScores = [];
  for (const neg of negDescs) {
    let best = 0;
    for (const pos of posDescs) {
      const s = matchSimilarityPct(neg, pos);
      if (s > best) best = s;
    }
    negScores.push(best);
  }
  if (posScores.length < 3 || negScores.length < 3) return null;

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd  = (arr, m) => Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  const posMean = avg(posScores), negMean = avg(negScores);
  const posStd = sd(posScores, posMean), negStd = sd(negScores, negMean);

  const autoTh = Math.max(50, Math.min(95, Math.round(posMean - posStd)));
  const minTh  = Math.max(30, Math.min(autoTh - 5, Math.round(negMean + negStd)));

  return {
    autoThreshold: autoTh, minThreshold: minTh,
    posMean: Math.round(posMean), negMean: Math.round(negMean),
    posStd: Math.round(posStd * 10) / 10, negStd: Math.round(negStd * 10) / 10,
    posCount: posDescs.length, negCount: negDescs.length,
    gap: Math.round(posMean - posStd - (negMean + negStd)),
  };
}

/**
 * Orchestrate a full extraction run for one child.
 *
 * @param {string} childId
 * @param {string} childName
 * @param {"EXTRACT_LATEST"|"DEEP_RESCAN"} mode
 * @param {object} [options]
 * @param {boolean} [options.closeOffscreenOnExit=true]
 *   When false, the offscreen document is kept alive after the run.
 *   Use this when calling runExtraction multiple times in sequence (e.g.
 *   DEEP_RESCAN_ALL) so we avoid the teardown/re-create cycle between
 *   children, which can cause "message port closed" errors.
 * @returns {Promise<{approved, queued, rejected, cancelled}>}
 */
async function runExtraction(childId, childName, mode, { closeOffscreenOnExit = true, startIndex = 0, resumeAnchorId = null, suppressEndMessages = false, childIndex = 0, childCount = 1 } = {}) {
  logger(
    "INFO",
    `Starting ${mode === "EXTRACT_LATEST" ? "incremental" : "deep"} scan for ${childName}…`
  );

  // Declare result accumulators before the try so they are in scope for the
  // return statement after the finally block.
  let approved = 0;
  let queued   = 0;
  let rejected = 0;
  let skippedAbsent = 0;
  let scanCancelled = false;
  let scanCompletedFully = false; // true only after the main story loop completes without abort
  let scanAbortReason = null;     // "rate_limit" | "auth" | "user_cancel" | "error"
  let deferDownloads = false;
  let _reEvalApprovalCount = 0; // counts auto-approvals since last re-evaluation
  const RE_EVAL_EVERY_N = 20;   // trigger live re-evaluation every N auto-approvals

  /**
   * Persist the current scan position so the Resume button can pick up later.
   * Sets scanCancelled=true so the post-finally cleanup (line ~2717) does not
   * wipe the checkpoint. Safe to call multiple times.
   */
  const abortAndCheckpoint = async (si, totalStories, summariesArr, reason) => {
    scanCancelled   = true;
    scanAbortReason = reason;
    try {
      await saveScanCheckpoint({
        childId,
        childName,
        mode,
        storyIndex: si,
        totalStories,
        lastStoryId: si > 0 && summariesArr && summariesArr[si - 1] ? summariesArr[si - 1].id : null,
        abortedReason: reason,
        abortedAt: new Date().toISOString(),
      });
    } catch (e) {
      // Swallow — failing to save a checkpoint should never mask the original abort.
      console.warn("[runExtraction] checkpoint save on abort failed:", e?.message || e);
    }
  };


  // Wrap the ENTIRE async body (including setup awaits) so the finally block —
  // which resets isScanning — always runs, even if getAllDescriptors(),
  // sendToOffscreen(), or fetchStorySummaries() throw unexpectedly.
  try {

  const {
    autoThreshold: userAutoThreshold = 85,
    minThreshold: userMinThreshold = 50,
    activeCentreName = "",
    attendanceFilter = false,
    saveStoryHtml = true,
    saveStoryCard = true,
    skipFaceRec = false,
    fillGapsOnly = false,
    scanDateMode = "all",
    scanCutoffFromDate = null,
    scanCutoffToDate = null,
  } = await chrome.storage.local.get([
    "autoThreshold", "minThreshold", "activeCentreName",
    "attendanceFilter", "saveStoryHtml", "saveStoryCard", "skipFaceRec", "fillGapsOnly",
    "scanDateMode", "scanCutoffFromDate", "scanCutoffToDate",
  ]);

  // Compute from/to date bounds for this scan run.
  // "all" mode = no date filtering.
  // "custom" mode = use the user-selected From/To calendar dates.
  //   fromDate = earliest story to include (stop paginating when older than this)
  //   toDate   = latest story to include (skip stories newer than this)
  const isCustomRange = scanDateMode === "custom";
  const scanFromDate  = (isCustomRange && scanCutoffFromDate)
    ? new Date(scanCutoffFromDate + "T00:00:00")
    : null;
  const scanToDate    = (isCustomRange && scanCutoffToDate)
    ? new Date(scanCutoffToDate + "T23:59:59")
    : null;

  if (scanFromDate || scanToDate) {
    const fromLabel = scanFromDate ? formatDateDMY(scanCutoffFromDate) : "all time";
    const toLabel   = scanToDate   ? formatDateDMY(scanCutoffToDate)   : "today";
    await logger("INFO", `📅 Date range: ${fromLabel} → ${toLabel}`);
  }

  // When skipFaceRec is enabled, set thresholds to 0 so everything auto-approves
  let minThreshold = skipFaceRec ? 0 : userMinThreshold;

  // ── 4-Phase adaptive face recognition ──
  // Read the current phase for this child and override the auto-approve
  // threshold accordingly:
  //   Phase 1 (Discovery):   100% — everything queued for review
  //   Phase 2 (Validation):  95% — very strict, most go to review
  //   Phase 3 (Confident):   user threshold — building final confidence
  //   Phase 4 (Production):  user threshold — fully hands-off auto-download
  const childPhaseData = await getChildPhase(childId);
  let autoThreshold = userAutoThreshold;

  // ── First full pass safety: disable ALL auto-rejection ──
  // On the very first scan (no processed stories exist for this child),
  // set minThreshold to 0 so nothing is auto-rejected. Every photo either
  // auto-approves (above threshold) or goes to the review queue. This is
  // critical because the model has zero data to make reject decisions.
  const processedStories = await getProcessedStories();
  const childProcessedCount = processedStories.filter(s => String(s.childId) === String(childId)).length;
  const isFirstPass = childProcessedCount === 0;
  if (isFirstPass && !skipFaceRec) {
    minThreshold = 0;
    await logger("INFO", `🛡️ First scan detected — auto-reject DISABLED (all uncertain photos go to review)`);
  }

  if (skipFaceRec) {
    autoThreshold = 0; // skip face rec: everything auto-approves
  } else if (childPhaseData.phase === 1) {
    autoThreshold = 100; // nothing auto-approves — all face photos queue for review
  } else if (childPhaseData.phase === 2) {
    autoThreshold = 95;  // very strict — only obvious matches auto-approve
  }
  // Phase 3+4: auto-calibrate threshold from learned positive/negative data
  if (childPhaseData.phase >= 3 && !skipFaceRec) {
    const autoCalResult = await computeAutoThreshold(childId);
    if (autoCalResult) {
      autoThreshold = autoCalResult.autoThreshold;
      minThreshold  = autoCalResult.minThreshold;
      await logger("INFO", `🎯 Auto-calibrated: approve ≥${autoCalResult.autoThreshold}%, reject <${autoCalResult.minThreshold}% (gap=${autoCalResult.gap})`);
    }
  }

  // Determine if downloads should be deferred.
  // Only Phase 4 (Production) or skipFaceRec allow actual downloads during scan.
  deferDownloads = !skipFaceRec && childPhaseData.phase < 4;

  const PHASE_EMOJIS  = { 1: "🔍", 2: "✅", 3: "📊", 4: "🚀" };
  const PHASE_LABELS  = { 1: "Discovery", 2: "Validation", 3: "Confident", 4: "Production" };
  const phaseEmoji = PHASE_EMOJIS[childPhaseData.phase] || "🔍";
  const phaseLabel = PHASE_LABELS[childPhaseData.phase] || "Unknown";
  // Use actual effective thresholds (which may have been auto-calibrated above)
  const thresholdMap = { 1: "100%", 2: "95%", 3: `${autoThreshold}%`, 4: `${autoThreshold}%` };
  const phaseDetail = `(${childPhaseData.verifiedCount} verified, threshold: ${thresholdMap[childPhaseData.phase] || "?"})`;
  if (skipFaceRec) {
    await logger("INFO", `📥 Face recognition DISABLED — downloading all photos without filtering`);
  } else {
    const dlNote = deferDownloads ? " — downloads deferred" : " — auto-downloading";
    await logger("INFO", `${phaseEmoji} Phase ${childPhaseData.phase}: ${phaseLabel} ${phaseDetail}${dlNote}`);
  }

  // Attempt to fetch the child's own centre name from their profile,
  // so that multi-centre parents get per-child GPS coordinates rather than
  // the global first-discovered centre name stored in activeCentreName.
  let childCentreFallback = activeCentreName;
  let childBirthday = null; // YYYY-MM-DD for age calculation
  let childRegularDays = []; // e.g. ["monday","tuesday","thursday","friday"]
  try {
    // ── Cache-first child profile: birthday + regularDays + centre name ──
    // Read from IDB if fresh (< 24 h old) to avoid a redundant API call on
    // every scan.  Fresh data is saved back to IDB after each API fetch so
    // subsequent scans within the same day skip the network round-trip.
    const cachedProfile  = await getChildProfile(childId).catch(() => null);
    const profileIsStale = cachedProfile
      ? (await isChildProfileStale(childId).catch(() => true))
      : true;

    if (cachedProfile && !profileIsStale) {
      // ✅ IDB hit — use cached data, skip API
      childBirthday    = cachedProfile.birthday    || null;
      childRegularDays = cachedProfile.regularDays || [];
      const cachedCompanies = (cachedProfile.companies || []).map(n => ({ name: n }));
      if (cachedCompanies.length > 0) {
        const foundName = cachedCompanies[0].name || "";
        if (foundName) {
          childCentreFallback = foundName;
          await discoverCentres([foundName]);
        }
      }
    } else {
      // ❌ IDB miss or stale — fetch from API, then persist to cache
      const childProfileData = await apiFetch(`${STORYPARK_BASE}/api/v3/children/${childId}`);
      const child = childProfileData.child || childProfileData;
      childBirthday    = child.birthday     || null;
      childRegularDays = child.regular_days || [];

      let foundName = "";
      const companies = child.companies || child.services || [];
      if (companies.length > 0) {
        foundName = companies[0].name || companies[0].display_name || "";
      } else if (child.centre_ids && child.centre_ids.length > 0) {
        try {
          const familyCentresData = await apiFetch(`${STORYPARK_BASE}/api/v3/family_centres`);
          const centres = familyCentresData.centres || familyCentresData.services || [];
          const matchedCentre = centres.find(c => child.centre_ids.includes(String(c.id)));
          if (matchedCentre) {
            foundName = matchedCentre.name || matchedCentre.display_name || "";
          }
        } catch (e) {
          // Ignore
        }
      }

      if (foundName) {
        childCentreFallback = foundName;
        await discoverCentres([foundName]);
      }

      // Persist profile to IDB for future cache-first reads
      saveChildProfile({
        childId,
        childName,
        birthday:    child.birthday     || null,
        regularDays: child.regular_days || [],
        companies:   companies.map(c => c.name || c.display_name || "").filter(Boolean),
        centreIds:   child.centre_ids   || [],
      }).catch(() => {});
    }
  } catch {
    // Fall back to activeCentreName if child profile fetch fails
  }

  // Ensure the offscreen document's in-memory face descriptors are fully synced
  // with IndexedDB before the first image fetch begins, preventing any race
  // condition where stale descriptors are used for the initial images.
  await sendToOffscreen({ type: "REFRESH_PROFILES" });

  // Load known face descriptors — filter to THIS child only so we don't
  // accidentally match a sibling's face (e.g. Hugo's face in Harry's stories).
  const allDescriptors  = await getAllDescriptors();
  const childEncodings  = allDescriptors
    .filter((d) => String(d.childId) === String(childId))
    .map((d) => ({
      childId:          d.childId,
      childName:        d.childName,
      descriptors:      d.descriptors,
      descriptorsByYear: d.descriptorsByYear || {},
    }));

  // Load negative descriptors ("not my child" faces) for contrastive matching.
  // These are built from rejected review queue items and help the model
  // discriminate between the target child and other children in the same daycare.
  const negativeDescriptors = await getNegativeDescriptors(childId).catch(() => []);
  if (negativeDescriptors.length > 0) {
    await logger("INFO", `🚫 Loaded ${negativeDescriptors.length} negative face descriptors for improved matching`);
  }

  // Bulk-fetch attendance data if attendance filtering is enabled
  let attendanceMap = new Map();
  let attendanceOldestDate = null; // boundary: don't filter stories before this date
  if (attendanceFilter) {
    if (childRegularDays.length > 0) {
      await logger("INFO", `📅 ${childName} currently attends: ${childRegularDays.join(", ")} (note: may differ for older stories)`);
    }
    await logger("INFO", `📅 Pre-fetching routine/attendance data for ${childName}…`);
    const bulkResult = await bulkFetchAttendanceDates(childId);
    attendanceMap = bulkResult.attendanceMap;
    attendanceOldestDate = bulkResult.oldestDate;
    await logger("INFO", `📅 Found ${attendanceMap.size} days with routine data for ${childName}${attendanceOldestDate ? ` (back to ${formatDateDMY(attendanceOldestDate)})` : ""}.`);
    // Also populate routineCache from bulk data so per-story routine lookups hit the cache
    for (const [date, summary] of attendanceMap) {
      routineCache.set(`${childId}:${date}`, summary);
    }
  }

  // Pass scanFromDate as the cutoffDate — fetchStorySummaries stops paginating
  // once it hits a story older than this, so a custom date range doesn't walk
  // the full history.
  let summaries = await fetchStorySummaries(childId, mode, childName, scanFromDate, scanToDate);


  // Fill Gaps Only mode: filter to only stories that don't have any saved photos yet.
  // This allows re-scanning for missing content (e.g. from attendance filter skips)
  // without re-processing stories that already have photos downloaded.
  if (fillGapsOnly && summaries.length > 0) {
    const existingManifests = await getDownloadedStories(childId).catch(() => []);
    const downloadedStoryIds = new Set(
      existingManifests
        .filter(m => m.approvedFilenames && m.approvedFilenames.length > 0)
        .map(m => m.storyId)
        .filter(Boolean)
    );
    if (downloadedStoryIds.size > 0) {
      const before = summaries.length;
      summaries = summaries.filter(s => !downloadedStoryIds.has(String(s.id)));
      if (summaries.length < before) {
        await logger("INFO", `📥 Download Missing Only: found ${summaries.length} stories without photos (skipping ${before - summaries.length} already downloaded)`);
      }
    }
  }

  const totalStories = summaries.length;

  // ── Room name extraction: pre-scan titles to build period→room map ──
  // The Storypark API has no dedicated room field; room names are embedded
  // in story titles like "Monday in Nursery One" or "Fun Friday in Senior Kindy".
  // We extract them from titles that contain the pattern, then use the dominant
  // room per month to fill in stories whose titles don't mention a room.
  const roomMap = buildRoomMap(summaries);
  if (roomMap.size > 0) {
    const rooms = [...new Set(roomMap.values())];
    await logger("INFO", `🏠 Detected room${rooms.length > 1 ? "s" : ""}: ${rooms.join(", ")} (from story titles)`);
  }

  // Pre-populate the discovered-centre cache with names already in storage so
  // we can skip discoverCentres() for repeat occurrences of the same name
  // within this scan and avoid a storage read+write for every story.
  const { centreLocations: _initLocations = {} } =
    await chrome.storage.local.get("centreLocations");
  const discoveredInScan = new Set(Object.keys(_initLocations));
  if (childCentreFallback) discoveredInScan.add(childCentreFallback);

  // Resume support: resolve effective start position. Prefer lastStoryId anchor
  // (exact position in fresh summaries) over raw storyIndex (may drift if
  // stories were added/removed since the checkpoint was written).
  let effectiveStartIndex = startIndex;
  if (resumeAnchorId) {
    const anchorIdx = summaries.findIndex(s => s.id === resumeAnchorId);
    if (anchorIdx >= 0) {
      effectiveStartIndex = anchorIdx + 1; // resume AFTER the last fully-processed story
      await logger("INFO", `▶ Resuming from story ${effectiveStartIndex + 1}/${summaries.length} (anchored to lastStoryId ${resumeAnchorId})`);
    } else {
      // lastStoryId not found — story may have been deleted; fall back to raw index
      if (startIndex > 0 && startIndex < summaries.length) {
        await logger("INFO", `▶ Resuming from story ${startIndex + 1}/${summaries.length} (skipping ${startIndex} already-processed stories) [anchor story not found, using raw index]`);
      }
    }
  } else if (startIndex > 0 && startIndex < summaries.length) {
    await logger("INFO", `▶ Resuming from story ${startIndex + 1}/${summaries.length} (skipping ${startIndex} already-processed stories)`);
  }

  // ETA tracking — initialised just before the loop so elapsed time only
  // counts actual story processing, not the setup/fetch phase above.
  const _scanLoopStartTime = Date.now();

  for (let si = effectiveStartIndex; si < summaries.length; si++) {
    if (cancelRequested) {
      await logger("WARNING", "Scan cancelled by user.");
      chrome.runtime.sendMessage({ type: "LOG", message: "⏹ Scan cancelled." }).catch(() => {});
      // Save checkpoint so the scan can be resumed later
      await abortAndCheckpoint(si, summaries.length, summaries, "user_cancel");
      break;
    }

    // Auto-save checkpoint every 5 stories so interrupted scans can resume.
    // Tightened from 10→5 so rate-limit aborts and SW suspensions lose less work.
    if (si > 0 && si % 5 === 0) {
      await saveScanCheckpoint({
        childId,
        childName,
        mode,
        storyIndex: si,
        totalStories: summaries.length,
        lastStoryId: summaries[si - 1].id,
      }).catch(() => {});
    }


    const summary = summaries[si];
    const dateStr = summary.created_at ? summary.created_at.split("T")[0] : null;

    // Broadcast progress + ETA
    const _sDone  = si - effectiveStartIndex + 1;
    const _sLeft  = summaries.length - si - 1;
    const _elapMs = Date.now() - _scanLoopStartTime;
    const _avgMs  = _sDone > 0 ? _elapMs / _sDone : 0;
    // Only show ETA after 3+ stories processed so early estimates aren't wildly wrong
    const _eta    = (_sDone >= 3 && _avgMs > 0 && _sLeft > 0) ? formatETA(_avgMs * _sLeft) : "";
    chrome.runtime.sendMessage({
      type: "PROGRESS",
      current: si + 1,
      total: totalStories,
      date: formatDateDMY(dateStr),
      childName,
      eta: _eta,
      childIndex,
      childCount,
    }).catch(() => {});

    // ── Attendance filter: skip stories from days the child wasn't at daycare ──
    // Routine data is the PRIMARY source of truth (accurate regardless of
    // schedule changes over the years).  regular_days is only used as a
    // supplementary quick-skip within the routine data's date range.
    if (attendanceFilter && dateStr) {
      const withinRoutineRange = attendanceOldestDate && dateStr >= attendanceOldestDate;

      if (withinRoutineRange) {
        // Within routine data range: routine existence is definitive
        if (attendanceMap.has(dateStr)) {
          // ✅ Routine exists → child was present, proceed normally
        } else {
          // ❌ No routine data for this date → child was absent
          const dayName = DAY_NAMES[new Date(dateStr + "T00:00:00Z").getUTCDay()];
          skippedAbsent++;
          await logger("INFO", `  ⏭️ Skipped ${formatDateDMY(dateStr)} (${dayName}) — ${childName} has no routine data (absent)`, dateStr);
          await markStoryProcessed(summary.id, summary.created_at, childId);
          continue;
        }
      }
      // Outside routine data range (older stories): can't determine attendance,
      // so let the story through and rely on face recognition to filter.
    }

    // Skip the slow READ_STORY delay when we have a cached story — no API call needed
    if (!(await getCachedStory(String(summary.id)).catch(() => null))) {
      await smartDelay("READ_STORY");
    }
    const storyDateDisplay = dateStr ? formatDateDMY(dateStr) : "unknown date";
    await logger("INFO", `Story ${si + 1}/${totalStories} (${storyDateDisplay}) for ${childName}`, dateStr);

    // Fetch full story detail (with cache)
    let story;
    let storyFromCache = false;
    try {
      // Check story cache first — avoids an API call on re-scans
      const cached = await getCachedStory(String(summary.id)).catch(() => null);
      if (cached) {
        story = cached;
        storyFromCache = true;
      } else {
        const detail = await apiFetch(
          `${STORYPARK_BASE}/api/v3/stories/${summary.id}`
        );
        story = detail.story || detail;
        // Cache the story for future re-scans
        await cacheStory(String(summary.id), story).catch(() => {});
      }
    } catch (err) {
      if (err.name === "AuthError" || err.message.includes("401")) {
        await logger("ERROR", `🛑 ${err.message} — checkpoint saved, click Resume to continue.`);
        await abortAndCheckpoint(si, summaries.length, summaries, "auth");
        break;
      }
      if (err.name === "RateLimitError" || err.message.includes("429") || err.message.includes("403")) {
        await logger("ERROR", `🛑 ${err.message} — checkpoint saved at story ${si}, click Resume to continue.`);
        await abortAndCheckpoint(si, summaries.length, summaries, "rate_limit");
        break;
      }
      await logger("WARNING", `  ✗ Story ${summary.id} fetch failed: ${err.message}`);
      continue;
    }


    const createdAt    = story.created_at || summary.created_at || "";
    // Defensive body extraction: some Storypark API versions return display_content
    // as an array of rich-text blocks rather than a plain string, which causes
    // (html || "").replace to throw "replace is not a function".
    // Normalise to a plain string at the earliest point.
    const _rawBody = story.display_content || story.body || story.excerpt || story.content;
    const body = _rawBody == null ? ""
      : typeof _rawBody === "string" ? _rawBody
      : Array.isArray(_rawBody) ? _rawBody.map(b => typeof b === "string" ? b : String(b?.text || b?.content || b?.value || "")).join("\n").trim()
      : String(_rawBody);
    const centreName   = story.community_name || story.centre_name || story.service_name || story.group_name || childCentreFallback || "";
    const storyDateStr = createdAt ? createdAt.split("T")[0] : null;

    // DEBUG: Centre/educator diagnostics
    if (debugCaptureMode) {
      if (!centreName) {
        _diagLog("centre_name_empty", { storyId: summary.id, title: story.display_title || story.title, fields: { community_name: story.community_name, centre_name: story.centre_name, service_name: story.service_name, group_name: story.group_name }, fallback: childCentreFallback });
      } else if (centreName !== childCentreFallback && childCentreFallback) {
        _diagLog("centre_name_mismatch", { storyId: summary.id, storyCentre: centreName, expectedCentre: childCentreFallback });
      }
      const edu = story.user?.display_name || story.user?.name || (story.teachers && story.teachers[0]?.display_name) || story.creator?.display_name || "";
      if (!edu) {
        _diagLog("educator_name_empty", { storyId: summary.id, title: story.display_title || story.title, userField: story.user, teachersField: story.teachers, creatorField: story.creator });
      }
    }

    // group_name often equals the centre name (not a room); deduplicate
    const rawRoom      = story.group_name || "";
    // Layer 1: API field (if it differs from the centre name)
    // Layer 2: Extract room from this story's title (e.g. "Monday in Nursery One")
    // Layer 3: Infer from the dominant room for this month (pre-built roomMap)
    const storyTitleForRoom = story.display_title || story.title || summary.title || "";
    const extractedRoom = extractRoomFromTitle(storyTitleForRoom);
    const inferredRoom = inferRoom(storyDateStr, roomMap);
    const roomName = (rawRoom && rawRoom !== centreName)
      ? rawRoom
      : (extractedRoom || inferredRoom);

    // DEBUG: Room name source tracking
    if (debugCaptureMode && roomName) {
      const source = (rawRoom && rawRoom !== centreName) ? "api_group_name" : (extractedRoom ? "title_extraction" : "period_inference");
      _diagLog("room_name_resolved", { storyId: summary.id, roomName, source, title: storyTitleForRoom });
    }
    const childFirstName = (childName || "").split(/\s+/)[0];

    // Auto-discover this centre name (registers it for GPS lookup in Options).
    // Only call discoverCentres() for names not already known to storage;
    // this avoids a redundant read+write for every story at the same centre.
    if (centreName && !discoveredInScan.has(centreName)) {
      await discoverCentres([centreName]);
      discoveredInScan.add(centreName);
    }

    // Look up GPS from IDB centreProfiles — O(1), already populated by
    // discoverCentres() dual-write and startup importLegacyCentreLocations().
    let gpsCoords = centreName
      ? await getCentreGPS(centreName).catch(() => null)
      : null;

    // B1 DB fallback: if GPS not in IDB, check chrome.storage.local centreLocations
    // (covers cases where legacy migration didn't run or centre was added mid-session).
    if (!gpsCoords && centreName) {
      try {
        const { centreLocations: _clFb = {} } = await chrome.storage.local.get("centreLocations");
        const legacyLoc = _clFb[centreName];
        if (legacyLoc?.lat != null && legacyLoc?.lng != null) {
          gpsCoords = { lat: legacyLoc.lat, lng: legacyLoc.lng };
          // Backfill IDB so future O(1) lookups succeed
          updateCentreGPS(centreName, legacyLoc.lat, legacyLoc.lng).catch(() => {});
        } else if (!(centreName in _clFb)) {
          // Centre completely unknown — trigger background geocoding (non-blocking)
          discoverCentres([centreName]).catch(() => {});
          await logger("INFO", `  📍 Centre GPS not cached — triggering discovery: ${centreName}`);
        }
      } catch (gpsFbErr) {
        await logger("WARNING", `  ⚠ GPS fallback lookup failed for "${centreName}": ${gpsFbErr.message}`, null, { centreName });
      }
    }

    // Collect media items with original_url, split into images and videos
    // Prefer story.media (matches actual Storypark v3 API response structure)
    const mediaItems = story.media || story.media_items || story.assets || [];
    const itemsWithUrl = mediaItems.filter((m) => m.original_url);
    const images = itemsWithUrl
      .filter((m) => !isVideoMedia(m))
      .map((m) => {
        let fname = m.file_name || m.filename || extractFilenameFromUrl(m.original_url) || `${summary.id}`;
        // Storypark file_name often lacks an extension (e.g. "story_image_v2_uuid_original")
        // Infer from content_type if missing
        if (!/\.\w{2,5}$/.test(fname)) {
          const ct = (m.content_type || "").toLowerCase();
          if (ct.includes("png")) fname += ".png";
          else if (ct.includes("gif")) fname += ".gif";
          else if (ct.includes("webp")) fname += ".webp";
          else fname += ".jpg"; // default for images
        }
        // Date-prefix photos to match video naming convention:
        // YYYY-MM-DD_ChildName[_RoomName]_originalname.ext
        // This ensures chronological sort in file managers and gives
        // Google Photos a fallback date signal for non-JPEG formats.
        const dotIdx = fname.lastIndexOf(".");
        const baseName = dotIdx >= 0 ? fname.slice(0, dotIdx) : fname;
        const ext      = dotIdx >= 0 ? fname.slice(dotIdx + 1) : "jpg";
        const nameParts = [
          storyDateStr,
          sanitizeName(childName),
          roomName ? sanitizeName(roomName) : null,
          baseName,
        ].filter(Boolean);
        const prefixedFilename = sanitizeName(`${nameParts.join("_")}.${ext}`);
        return { originalUrl: m.original_url, filename: prefixedFilename };
      });
    const videos = itemsWithUrl
      .filter((m) => isVideoMedia(m))
      .map((m) => {
        let fname = m.file_name || m.filename || extractFilenameFromUrl(m.original_url) || `${summary.id}`;
        if (!/\.\w{2,5}$/.test(fname)) {
          const ct = (m.content_type || "").toLowerCase();
          if (ct.includes("mov")) fname += ".mov";
          else if (ct.includes("webm")) fname += ".webm";
          else fname += ".mp4";
        }
        return { originalUrl: m.original_url, filename: sanitizeName(fname) };
      });

    if (images.length === 0 && videos.length === 0) {
      // No media — but if story HTML archiving is enabled and there's text
      // content, still save the story HTML before skipping.
      if (saveStoryHtml && body && !deferDownloads) {
        // Text-only story HTML — only write to disk during Phase 4 or skipFaceRec
        try {
          const storyTitle = stripHtml(story.display_title || story.title || story.excerpt || "Story");
          const childAge = calculateAge(childBirthday, storyDateStr);
          const educatorName = story.user?.display_name || story.user?.name
            || (story.teachers && story.teachers[0]?.display_name)
            || story.creator?.display_name || "";
          // Persist educator to IDB for metadata enrichment (fire-and-forget)
          if (educatorName && story.user?.id) {
            saveEducator({
              childId,
              educatorId: String(story.user.id),
              educatorName,
              centreName,
            }).catch(() => {});
          }
          const safeDateStr = storyDateStr || "unknown";
          const safeTitle = sanitizeName(storyTitle.substring(0, 50));
          const storyFolderName = `${safeDateStr} - ${safeTitle}`;
          const storyBasePath = `Storypark Smart Saver/${sanitizeName(childName)}/Stories/${storyFolderName}`;
          const routineData = storyDateStr ? await fetchRoutineSummary(childId, storyDateStr) : "";
          const routineHtml = typeof routineData === "object" ? (routineData.detailed || routineData.summary || "") : routineData;
          const htmlContent = buildStoryHtml({
            title: storyTitle, date: storyDateStr, body, childName, childAge,
            roomName, centreName, educatorName, routineText: routineHtml, mediaFilenames: [],
          });
          const txtRes1 = await sendToOffscreen({
            type: "DOWNLOAD_TEXT", text: htmlContent,
            savePath: `${storyBasePath}/story.html`, mimeType: "text/html",
          });
          if (txtRes1.dataUrl && txtRes1.savePath) {
            await downloadHtmlFile(txtRes1.dataUrl, txtRes1.savePath);
          }
        } catch (err) {
          console.warn("Story HTML export (text-only) failed:", err.message);
        }
      }
      await markStoryProcessed(summary.id, createdAt, childId);
      continue;
    }

    // ── Compute story-level metadata once (needed for folder paths + HTML) ──
    const storyTitle = stripHtml(story.display_title || story.title || story.excerpt || "Story");
    const childAge = calculateAge(childBirthday, storyDateStr);
    const educatorName = story.user?.display_name || story.user?.name
      || (story.teachers && story.teachers[0]?.display_name)
      || story.creator?.display_name || "";
    // Persist educator to IDB for metadata enrichment (fire-and-forget)
    if (educatorName && story.user?.id) {
      saveEducator({
        childId,
        educatorId: String(story.user.id),
        educatorName,
        centreName,
      }).catch(() => {});
    }
    const safeDateStr = storyDateStr || "unknown";
    const safeTitle = sanitizeName(storyTitle.substring(0, 50));
    const storyFolderName = `${safeDateStr} - ${safeTitle}`;
    const storyBasePath = `Storypark Smart Saver/${sanitizeName(childName)}/Stories/${storyFolderName}`;

    // Fetch routine data for the story date (deduplicated by cache)
    const routineText  = storyDateStr
      ? await fetchRoutineSummary(childId, storyDateStr)
      : "";

    // ── Phase 2a: Artist + IPTC fields — constant for all photos in this story ──
    // Artist (EXIF tag 315) = "Storypark Smart Saver — {centreName}" (ASCII)
    const exifArtist = sanitiseForExif(
      centreName ? `Storypark Smart Saver \u2014 ${centreName}` : "Storypark Smart Saver",
      255
    );
    // IPTC Caption-Abstract (2:120) = story body as plain text (UTF-8, max 2000 bytes)
    const iptcCaption = sanitiseForIptcCaption(stripHtml(body), 2000);
    // IPTC Keywords (2:25) = child name + centre + room + educator, one per keyword
    const iptcKeywords = [childName, centreName, roomName, educatorName]
      .filter(Boolean)
      .map(k => sanitiseForExif(k, 64));
    // IPTC By-line (2:80) = same as Artist (creator field in Apple Photos)
    const iptcByline = exifArtist;

    // Track which filenames were actually approved/downloaded for deferred story HTML
    const approvedFilenames = [];
    // Track originalUrl→filename mapping for rebuild-from-scratch capability
    const mediaUrls = [];

    // Process each image sequentially
    let aborted = false;
    for (const img of images) {
      if (cancelRequested) { scanCancelled = true; aborted = true; break; }

      // ── Rejection tracking: skip images previously rejected by user ──
      if (await isRejected(summary.id, img.originalUrl).catch(() => false)) {
        rejected++;
        continue;
      }

      // ── Fingerprint cache: fast-path for re-scans ──
      // If we have cached face descriptors from a previous scan, we can skip the
      // expensive image download (~2-5MB) + face detection (~500ms) and do pure-math
      // matching in the service worker. This makes deep re-scans up to 20x faster.
      const cachedFP = await getImageFingerprint(summary.id, img.originalUrl).catch(() => null);
      // Phase 1&2 safety: skip the fingerprint cache fast-path entirely.
      // All photos must go through the full pipeline to the review queue
      // so the parent can build the face profile from scratch. The cache
      // is only used for fast-approve/reject in Phase 3+ when the model
      // is mature enough to make reliable automated decisions.
      if (cachedFP && cachedFP.faces && cachedFP.faces.length > 0
          && childEncodings.length > 0 && !skipFaceRec
          && childPhaseData.phase >= 3) {
        // Pre-compute centroids once for all child encodings
        const fpCentroids = new Map();
        for (const enc of childEncodings) {
          let ctr = buildCentroids(enc.descriptorsByYear || {});
          if (ctr.length === 0 && enc.descriptors.length >= 3) {
            const c = computeCentroid(enc.descriptors);
            if (c) ctr = [c];
          }
          fpCentroids.set(enc.childId, ctr);
        }

        // Run matching against all cached face descriptors
        let bestEffCached = 0, bestPctCached = 0, bestDescCached = null;
        for (const face of cachedFP.faces) {
          if (!face.descriptor) continue;
          for (const enc of childEncodings) {
            const ctr = fpCentroids.get(enc.childId) || [];
            const md = enhancedMatch(face.descriptor, enc.descriptors, negativeDescriptors, ctr);
            if (md.effectiveScore > bestEffCached) {
              bestEffCached  = md.effectiveScore;
              bestPctCached  = md.rawPositive;
              bestDescCached = face.descriptor;
            }
          }
        }

        // DEBUG: Log borderline matching decisions (within ±5% of thresholds)
        if (debugCaptureMode) {
          const nearAuto = Math.abs(bestEffCached - autoThreshold) <= 5;
          const nearMin = Math.abs(bestPctCached - minThreshold) <= 5;
          if (nearAuto || nearMin) {
            _diagLog("match_borderline", {
              storyId: summary.id, imageUrl: img.originalUrl,
              bestEffective: bestEffCached, bestRawPositive: bestPctCached,
              autoThreshold, minThreshold,
              nearAutoThreshold: nearAuto, nearMinThreshold: nearMin,
              decision: bestPctCached < minThreshold ? "reject" : (bestEffCached >= autoThreshold ? "approve" : "review"),
            });
          }
        }

        // Fast REJECT: below minimum threshold — no API call needed at all
        if (bestPctCached < minThreshold) {
          rejected++;
          continue;
        }

        // Fast APPROVE with deferred downloads (Phase 1-3)
        if (bestEffCached >= autoThreshold && deferDownloads) {
          const exifMeta = buildExifMetadata(body, childFirstName, routineText, roomName, centreName, childAge);
          const fpSavePath = `${storyBasePath}/${img.filename}`;
          try {
            await addPendingDownload({
              itemType: "image", childId, childName,
              storyId: summary.id, imageUrl: img.originalUrl,
              savePath: fpSavePath,
              description: exifMeta.description,
              exifTitle: exifMeta.title, exifSubject: exifMeta.subject, exifComments: exifMeta.comments,
              gpsCoords, createdAt, roomName, centreName, filename: img.filename,
            });
          } catch (e) {
            await logger("WARNING", `  ⚠ Pending-download save failed: ${e.message}`);
          }
          approved++;
          _reEvalApprovalCount++;
          approvedFilenames.push(img.filename);
          mediaUrls.push({ filename: img.filename, originalUrl: img.originalUrl });
          await logger("INFO", `  ⚡ Cache approve: ${img.filename} for ${childName} (${bestEffCached}%, deferred)`, storyDateStr);
          // Continuous learning from cached descriptor
          if (bestDescCached) {
            const yr = createdAt ? new Date(createdAt).getFullYear().toString() : "unknown";
            await appendDescriptor(childId, childName, bestDescCached, yr).catch(() => {});
          }
          continue;
        }

        // Fast APPROVE with immediate download (Phase 4) — skip face detection,
        // still need the image for EXIF stamping
        if (bestEffCached >= autoThreshold && !deferDownloads) {
          try {
            await smartDelay("DOWNLOAD_MEDIA");
            const exifMeta = buildExifMetadata(body, childFirstName, routineText, roomName, centreName, childAge);
            const fpSavePath = `${storyBasePath}/${img.filename}`;
            const dlResult = await sendToOffscreen({
              type: "DOWNLOAD_APPROVED",
              storyData: { storyId: summary.id, createdAt, body, roomName, centreName,
                           originalUrl: img.originalUrl, filename: img.filename },
              description: exifMeta.description, exifTitle: exifMeta.title,
              exifSubject: exifMeta.subject, exifComments: exifMeta.comments,
              exifArtist, iptcCaption, iptcKeywords, iptcByline,
              childName, savePath: fpSavePath, gpsCoords,
            });
            if (dlResult.dataUrl && dlResult.savePath) {
              await downloadDataUrl(dlResult.dataUrl, dlResult.savePath);
              recordFileDownloaded({ filePath: dlResult.savePath, childId, storyId: String(summary.id), filename: img.filename, fileType: "image" }).catch(() => {});
            }
            approved++;
            _reEvalApprovalCount++;
            approvedFilenames.push(img.filename);
            mediaUrls.push({ filename: img.filename, originalUrl: img.originalUrl });
            await logger("SUCCESS", `  ⚡ Cache download: ${img.filename} for ${childName} (${bestEffCached}%)`, storyDateStr);
            if (bestDescCached) {
              const yr = createdAt ? new Date(createdAt).getFullYear().toString() : "unknown";
              await appendDescriptor(childId, childName, bestDescCached, yr).catch(() => {});
            }
            continue;
          } catch (dlErr) {
            // Download failed — fall through to full pipeline
            await logger("WARNING", `  ⚠ Cache download failed, using full pipeline: ${dlErr.message}`);
          }
        }

        // Review-threshold or ambiguous match: fall through to full pipeline.
        // Thumbnails are needed for the review queue which the cache doesn't store.
      }

      await smartDelay("DOWNLOAD_MEDIA");

      // Build structured EXIF metadata: title, subject, comments
      const exifMeta = buildExifMetadata(
        body, childFirstName, routineText, roomName, centreName, childAge
      );

      // Photos live inside the story folder (not a flat Photos/ folder)
      const savePath = `${storyBasePath}/${img.filename}`;

      // ── skipFaceRec fast-path: "Download All Media" mode ──
      // When skipFaceRec = true, bypass face detection entirely and download
      // the image immediately using DOWNLOAD_APPROVED (with full EXIF stamping).
      // Without this, the offscreen's "no training data → queue for review" override
      // would trigger even with autoThreshold=0, causing photos to be queued
      // instead of downloaded — which defeats the purpose of "Download All Media".
      if (skipFaceRec) {
        let _skipDlSucceeded = false;
        try {
          const skipDlResult = await sendToOffscreen({
            type:        "DOWNLOAD_APPROVED",
            storyData:   { storyId: summary.id, createdAt, body, roomName, centreName, originalUrl: img.originalUrl, filename: img.filename },
            description: exifMeta.description,
            exifTitle:   exifMeta.title,
            exifSubject: exifMeta.subject,
            exifComments:exifMeta.comments,
            exifArtist, iptcCaption, iptcKeywords, iptcByline,
            childName,
            savePath,
            gpsCoords,
          });
          if (skipDlResult.dataUrl && skipDlResult.savePath) {
            await downloadDataUrl(skipDlResult.dataUrl, skipDlResult.savePath);
            _skipDlSucceeded = true;
            recordFileDownloaded({ filePath: skipDlResult.savePath, childId, storyId: String(summary.id), filename: img.filename, fileType: "image" }).catch(() => {});
          }
        } catch (skipErr) {
          await logger("WARNING", `  ⚠ Download failed for ${img.filename}: ${skipErr.message}`);
        }
        // Only record as approved if the file was actually saved to disk
        if (_skipDlSucceeded) {
          approved++;
          approvedFilenames.push(img.filename);
          mediaUrls.push({ filename: img.filename, originalUrl: img.originalUrl });
          await logger("SUCCESS", `  ✓ Downloaded: ${img.filename} for ${childName}`, storyDateStr);
        }
        continue; // skip PROCESS_IMAGE entirely (regardless of success/failure)
      }

      let result;
      try {
        result = await sendToOffscreen({
          type: "PROCESS_IMAGE",
          imageUrl:  img.originalUrl,
          storyData: {
            storyId:     summary.id,
            createdAt,
            body,
            roomName,
            centreName,
            originalUrl: img.originalUrl,
            filename:    img.filename,
          },
          description: exifMeta.description,
          exifTitle:    exifMeta.title,
          exifSubject:  exifMeta.subject,
          exifComments: exifMeta.comments,
          exifArtist, iptcCaption, iptcKeywords, iptcByline,
          childId,
          childName,
          savePath,
          childEncodings,
          negativeDescriptors,
          autoThreshold,
          minThreshold,
          gpsCoords,
        });
      } catch (err) {
        if (err.name === "AuthError" || err.message.includes("401")) {
          await logger("ERROR", `🛑 ${err.message} — checkpoint saved at story ${si}, click Resume to continue.`);
          await abortAndCheckpoint(si, summaries.length, summaries, "auth");
          aborted = true;
          break;
        }
        if (err.name === "RateLimitError" || err.message.includes("429") || err.message.includes("403")) {
          await logger("ERROR", `🛑 ${err.message} — checkpoint saved at story ${si}, click Resume to continue.`);
          await abortAndCheckpoint(si, summaries.length, summaries, "rate_limit");
          aborted = true;
          break;
        }
        await logger("WARNING", `  ✗ Processing error: ${err.message}`);
        continue;
      }


      // ── Save fingerprint for future re-scans ──
      // Stores detected face descriptors (~2KB each) so the next deep re-scan
      // can skip the image download (~2-5MB) and face detection (~500ms).
      if (result?.detectedFaces) {
        saveImageFingerprint({
          storyId: String(summary.id),
          imageUrl: img.originalUrl,
          childId,
          faces: result.detectedFaces,
          noFace: result.detectedFaces.length === 0,
        }).catch(() => {});
      }

      const forChild   = ` for ${childName}`;
      if (result?.result === "approve") {
        if (deferDownloads) {
          // Phase 1-3: defer downloads — cache metadata for later batch download.
          // No files are written to disk until Phase 4 or manual "Download Approved".
          try {
            await addPendingDownload({
              itemType: "image",
              childId,
              childName,
              storyId: summary.id,
              imageUrl: img.originalUrl,
              savePath: result.savePath || savePath,
              description: exifMeta.description,
              exifTitle: exifMeta.title,
              exifSubject: exifMeta.subject,
              exifComments: exifMeta.comments,
              gpsCoords,
              createdAt,
              roomName,
              centreName,
              filename: img.filename,
            });
          } catch (e) {
            await logger("WARNING", `  ⚠ Failed to cache: ${e.message}`);
          }
          approved++;
          _reEvalApprovalCount++;
          approvedFilenames.push(img.filename);
          mediaUrls.push({ filename: img.filename, originalUrl: img.originalUrl });
          await logger("INFO", `  📋 Cached: ${img.filename}${forChild} (download deferred)`, storyDateStr);
        } else {
          // Phase 4 or skipFaceRec: download immediately
          if (result.dataUrl && result.savePath) {
            await downloadDataUrl(result.dataUrl, result.savePath);
            recordFileDownloaded({ filePath: result.savePath, childId, storyId: String(summary.id), filename: img.filename, fileType: "image" }).catch(() => {});
          }
          approved++;
          _reEvalApprovalCount++;
          approvedFilenames.push(img.filename);
          mediaUrls.push({ filename: img.filename, originalUrl: img.originalUrl });
          await logger("SUCCESS", `  ✓ Downloaded: ${img.filename}${forChild}`, storyDateStr);
        }

        // ── Live re-evaluation: periodically re-check queued items ──
        // Every RE_EVAL_EVERY_N auto-approvals, re-evaluate the review queue
        // using the improved face profile. This creates a snowball effect:
        // each approval makes the model better, which auto-resolves old queue
        // items, whose descriptors further improve the model, etc.
        if (_reEvalApprovalCount >= RE_EVAL_EVERY_N && !skipFaceRec) {
          _reEvalApprovalCount = 0;
          try {
            const freshDescs = await getAllDescriptors();
            const freshChild = freshDescs.find(d => String(d.childId) === String(childId));
            if (freshChild && freshChild.descriptors && freshChild.descriptors.length > 0) {
              const freshNeg = await getNegativeDescriptors(childId).catch(() => []);
              const queue = await getReviewQueue();
              const childQueue = queue.filter(item => String(item.childId) === String(childId) && item.descriptor);

              if (childQueue.length > 0) {
                const reEvalResult = await sendToOffscreen({
                  type: "RE_EVALUATE_BATCH",
                  items: childQueue.map(item => ({
                    id: item.id,
                    descriptor: item.descriptor,
                  })),
                  positiveDescriptors: freshChild.descriptors,
                  descriptorsByYear: freshChild.descriptorsByYear || {},
                  negativeDescriptors: freshNeg,
                  autoThreshold,
                  minThreshold,
                  disableAutoReject: childPhaseData.phase < 3, // Phase 1&2 safety: never auto-reject immature model
                });

                let reApproved = 0, reRejected = 0;
                if (reEvalResult?.results) {
                  for (const r of reEvalResult.results) {
                    if (r.decision === "approve") {
                      const item = childQueue.find(q => q.id === r.id);
                      if (item) {
                        if (item.descriptor && item.childId) {
                          const rd = item.storyData?.createdAt ? new Date(item.storyData.createdAt) : null;
                          const ry = rd ? rd.getFullYear().toString() : "unknown";
                          await appendDescriptor(item.childId, item.childName, item.descriptor, ry);
                          await incrementVerifiedCount(item.childId);
                        }
                        await addPendingDownload({
                          childId: item.childId,
                          childName: item.childName,
                          storyData: item.storyData,
                          savePath: item.savePath,
                          description: item.description || "",
                          exifTitle: item.exifTitle || "",
                          exifSubject: item.exifSubject || "",
                          exifComments: item.exifComments || "",
                        });
                        await removeFromReviewQueue(r.id);
                        reApproved++;
                        approved++;
                      }
                    } else if (r.decision === "reject") {
                      const item = childQueue.find(q => q.id === r.id);
                      if (item) {
                        if (item.storyData?.storyId && item.storyData?.originalUrl) {
                          await addRejection(item.storyData.storyId, item.storyData.originalUrl).catch(() => {});
                        }
                        if (item.descriptor && item.childId) {
                          await appendNegativeDescriptor(item.childId, item.descriptor).catch(() => {});
                        }
                        await removeFromReviewQueue(r.id);
                        reRejected++;
                        rejected++;
                      }
                    }
                  }
                }

                if (reApproved > 0 || reRejected > 0) {
                  const remaining = childQueue.length - reApproved - reRejected;
                  await logger("SUCCESS",
                    `🧠 Live re-evaluation: ${reApproved} auto-approved, ${reRejected} auto-rejected (${remaining} still in queue)`
                  );
                  // Refresh offscreen profiles with newly learned descriptors
                  sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
                  chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
                }
              }
            }
          } catch (reEvalErr) {
            console.warn("[live-reeval] Re-evaluation failed:", reEvalErr.message);
          }
        }
      } else if (result?.result === "review") {
        queued++;
        const baseReview = `${img.filename}${forChild}`;
        const reviewMsg  = result.noTrainingData
          ? `  📚 Queued for profile building: ${baseReview} (no training data yet)`
          : `  👀 Queued for review: ${baseReview} (${result.matchPct ?? "?"}% match)`;
        await logger("INFO", reviewMsg, storyDateStr);
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
      } else {
        // "reject" result: below minThreshold (normal) or processImage threw.
        // Only log when there is an attached error message to avoid spamming
        // the log with every below-threshold rejection.
        rejected++;
        if (result?.error) {
          await logger("WARNING", `  ✗ Processing error: ${result.error}`);
        }
      }
    }

    if (aborted) break;

    // Process videos — download directly, no face matching
    for (const vid of videos) {
      if (cancelRequested) { scanCancelled = true; aborted = true; break; }
      await smartDelay("DOWNLOAD_MEDIA");

      // Build a descriptive filename so Google Photos can read the date from it.
      // Google Photos recognises YYYY-MM-DD at the start of a filename and uses
      // it to place the video on the correct date in the timeline (MP4 containers
      // cannot carry EXIF, so the filename date is the only reliable signal).
      // Format: YYYY-MM-DD_ChildName[_RoomName]_originalname.ext
      const dotIdx     = vid.filename.lastIndexOf(".");
      const baseName   = dotIdx >= 0 ? vid.filename.slice(0, dotIdx) : vid.filename;
      const ext        = dotIdx >= 0 ? vid.filename.slice(dotIdx + 1) : "mp4";
      const nameParts  = [
        storyDateStr,
        sanitizeName(childName),
        roomName ? sanitizeName(roomName) : null,
        baseName,
      ].filter(Boolean);
      const videoFilename = sanitizeName(`${nameParts.join("_")}.${ext}`);
      const savePath = `${storyBasePath}/${videoFilename}`;

      try {
        if (deferDownloads) {
          // Phase 1-3: cache video metadata for later batch download
          await addPendingDownload({
            itemType: "video",
            childId,
            childName,
            storyId: summary.id,
            imageUrl: vid.originalUrl,
            savePath,
            filename: videoFilename,
            createdAt,
            roomName,
            centreName,
          });
          approved++;
          approvedFilenames.push(videoFilename);
          mediaUrls.push({ filename: videoFilename, originalUrl: vid.originalUrl });
          await logger("INFO", `  📋 Cached video: ${videoFilename} for ${childName} (download deferred)`, storyDateStr);
        } else {
          // Memory-safe video download (OOM fix v2.2.x): offscreen streams the
          // bytes into a Blob, creates a blob URL in-place, and returns only
          // the URL + id. The service worker never handles the raw video bytes
          // or a base64 data URL — avoiding the ~64 MB chrome.runtime messaging
          // limit that silently corrupted large videos on the legacy path.
          const vidResult = await sendToOffscreen({
            type: "DOWNLOAD_VIDEO",
            videoUrl: vid.originalUrl,
            savePath,
          });
          if (vidResult?.blobUrl && vidResult?.savePath) {
            const sizeMb = vidResult.size ? ` (${(vidResult.size / 1048576).toFixed(1)} MB)` : "";
            await downloadVideoFromOffscreen(vidResult);
            recordFileDownloaded({ filePath: vidResult.savePath, childId, storyId: String(summary.id), filename: videoFilename, fileType: "video" }).catch(() => {});
            approved++;
            approvedFilenames.push(videoFilename);
            mediaUrls.push({ filename: videoFilename, originalUrl: vid.originalUrl });
            await logger("SUCCESS", `  🎬 Downloaded video: ${videoFilename}${sizeMb} for ${childName}`, storyDateStr);
          } else {
            await logger("WARNING", `  ⚠ Video returned no blob URL: ${videoFilename}`, storyDateStr, { childName });
          }
        }
      } catch (err) {
        if (err.name === "AuthError" || err.message.includes("401")) {
          await logger("ERROR", `🛑 ${err.message} — checkpoint saved at story ${si}, click Resume to continue.`);
          await abortAndCheckpoint(si, summaries.length, summaries, "auth");
          aborted = true;
          break;
        }
        // Individual video CDN 403/404: the specific media URL is expired or unavailable.
        // This is NOT a Storypark API rate limit — skip this video and continue the scan.
        if (err.message.startsWith("Video fetch 403") || err.message.startsWith("Video fetch 404")) {
          await logger("WARNING", `  ⚠ Video unavailable (skipped): ${videoFilename}`, storyDateStr, { childName, centreName });
          // do NOT set aborted — loop continues naturally to the next video/story
        } else if (err.name === "RateLimitError" || err.message.includes("429")) {
          await logger("ERROR", `🛑 ${err.message} — checkpoint saved at story ${si}, click Resume to continue.`);
          await abortAndCheckpoint(si, summaries.length, summaries, "rate_limit");
          aborted = true;
          break;
        } else {
          await logger("WARNING", `  ✗ Video download error: ${err.message}`, storyDateStr, { childName });
        }
      }

    }

    if (aborted) break;

    // ── Deferred story HTML: only include approved/downloaded files ──
    // CRITICAL: If no files were approved, skip story HTML entirely (no empty folders).
    // During Phase 1-3 (deferDownloads), story HTML is also deferred — it will be
    // generated during batch download when the user clicks "Download Approved".
    if (saveStoryHtml && approvedFilenames.length > 0 && !deferDownloads) {
      try {
        const routineHtmlStr = typeof routineText === "object"
          ? (routineText.detailed || routineText.summary || "")
          : (routineText || "");
        const htmlContent = buildStoryHtml({
          title: storyTitle,
          date: storyDateStr,
          body,
          childName,
          childAge,
          roomName,
          centreName,
          educatorName,
          routineText: routineHtmlStr,
          mediaFilenames: approvedFilenames,
        });
        const txtRes2 = await sendToOffscreen({
          type: "DOWNLOAD_TEXT",
          text: htmlContent,
          savePath: `${storyBasePath}/story.html`,
          mimeType: "text/html",
        });
        if (txtRes2.dataUrl && txtRes2.savePath) {
          await downloadHtmlFile(txtRes2.dataUrl, txtRes2.savePath);
          await logger("INFO", `  📄 story.html saved (${approvedFilenames.length} photos)`, storyDateStr, { childName, centreName, roomName, photoCount: approvedFilenames.length });
        }
      } catch (err) {
        console.warn("Story HTML export failed:", err.message);
      }
    }

    // ── Story Card: canvas-rendered JPEG companion per story ──
    // Generated after story HTML so all approved filenames are known.
    // Gated on saveStoryCard preference AND body text being present.
    if (saveStoryCard && approvedFilenames.length > 0 && !deferDownloads && body) {
      try {
        const plainRoutineForCard = typeof routineText === "object"
          ? (routineText.detailed || routineText.summary || "")
          : (routineText || "");
        const cardSavePath = `${storyBasePath}/${storyDateStr || "story"} - Story Card.jpg`;
        const cardResult = await sendToOffscreen({
          type:         "GENERATE_STORY_CARD",
          title:        storyTitle,
          date:         storyDateStr,
          body,
          centreName,
          roomName,
          educatorName,
          childName,
          childAge,
          routineText:  plainRoutineForCard,
          photoCount:   approvedFilenames.length,
          gpsCoords,
          exifArtist,
          iptcCaption,
          iptcKeywords,
          iptcByline,
          savePath:     cardSavePath,
        });
        if (cardResult.ok && cardResult.dataUrl) {
          await downloadDataUrl(cardResult.dataUrl, cardSavePath);
          await logger("INFO", `  🎴 Story Card saved`, storyDateStr, { childName, centreName, roomName, gps: !!gpsCoords });
        }
      } catch (err) {
        console.warn("Story Card generation failed:", err.message);
      }
    }

    // Save story manifest to IndexedDB for index page rebuilding
    if (approvedFilenames.length > 0) {
      try {
        await addDownloadedStory({
          childId,
          childName,
          storyId: summary.id,
          storyTitle: storyTitle || "Story",
          storyDate: storyDateStr || "",
          educatorName: educatorName || "",
          roomName: roomName || "",
          centreName: centreName || "",
          folderName: storyFolderName,
          approvedFilenames,
          mediaUrls, // originalUrl→filename mapping for rebuild-from-scratch
          thumbnailFilename: approvedFilenames[0] || "",
          excerpt: stripHtml(body).substring(0, 200),
          storyBody: body || "", // full body text for HTML regeneration without API
          childAge: childAge || "",
          // Routine text stored for story card generation without re-fetching
          storyRoutine: typeof routineText === "object"
            ? (routineText.detailed || routineText.summary || "")
            : (routineText || ""),
        });
      } catch (err) {
        console.warn("Story manifest save failed:", err.message);
      }
    }

    await markStoryProcessed(summary.id, createdAt, childId);

    // ── RAM management: yield to GC between stories + periodic memory snapshot ──
    // Releases the event loop so V8 can collect freed objects (story JSON,
    // image buffers, API responses) between iterations. A 50 ms yield every
    // story drains pending microtasks and the blob-URL revocation callbacks
    // from completed downloads; the periodic memory snapshot (every 10
    // stories) provides visibility in DevTools if growth is suspected.
    // This is critical for multi-hour scans on accounts with 500+ stories
    // where even tiny per-story allocations add up to OOM territory.
    const _storiesDone = si - effectiveStartIndex + 1;
    if (_storiesDone % 10 === 0) {
      await logMemorySnapshot(`after story ${si + 1}/${summaries.length} for ${childName}`);
    }
    // Yield every story (cheap — 50 ms out of several seconds per story is
    // negligible to the user but huge for GC). The yield also drains
    // download-complete onChanged events so blob URLs get revoked in time.
    await idleYield(50);
  }

  // Mark completion BEFORE finally so the post-finally guard knows whether
  // the loop finished cleanly or was aborted by an error / cancel.
  if (!scanCancelled) {
    scanCompletedFully = true;
  }
  } finally {

    routineCache.clear();
    isScanning      = false;
    cancelRequested = false;
    // Persist cleared state so the popup sees accurate status if it re-opens.
    chrome.storage.session
      .set({ isScanning: false, cancelRequested: false, _requestCount: 0 })
      .catch(() => {});
    // Release the heavy Human AI models immediately to prevent memory leaks —
    // unless the caller has opted to keep the offscreen document alive for a
    // subsequent child scan (avoids the re-init overhead and "message port
    // closed" errors between children in a multi-child scan run).
    if (closeOffscreenOnExit) {
      await chrome.offscreen.closeDocument().catch(() => {});
      offscreenReady = false;
    }
  }

  // Clear checkpoint only when the loop finished cleanly (scanCompletedFully).
  // If scanCancelled is true (rate-limit / auth / user abort), the checkpoint
  // was already written by abortAndCheckpoint() — don't wipe it.
  if (scanCompletedFully) {
    await clearScanCheckpoint(childId).catch(() => {});
  }

  const skippedPart = skippedAbsent > 0 ? `, Skipped (absent): ${skippedAbsent}` : "";
  const dlWord = deferDownloads ? "Cached" : "Downloaded";
  if (scanCompletedFully) {
    const msg = `Scan complete — ${dlWord}: ${approved}, Review: ${queued}, Rejected: ${rejected}${skippedPart}`;
    await logger("SUCCESS", msg, null, { childName, approved, queued, rejected });
  } else if (scanCancelled) {
    const reasonLabel = scanAbortReason === "rate_limit" ? "Rate limited"
      : scanAbortReason === "auth" ? "Auth error"
      : scanAbortReason === "user_cancel" ? "Cancelled by user"
      : "Aborted";
    await logger("WARNING", `⏸ Scan paused (${reasonLabel}) — ${dlWord}: ${approved}, Review: ${queued}, Rejected: ${rejected}${skippedPart} — click Resume to continue.`, null, { childName, approved, queued });
    // Fire a Chrome notification so the parent knows the scan paused in the background
    try {
      chrome.notifications.create(`scan-abort-${childId}-${Date.now()}`, {
        type: "basic", iconUrl: "icons/icon128.png",
        title: "Storypark Smart Saver — Scan Paused",
        message: `⏸ ${reasonLabel}: ${approved} saved so far. Click Resume in the extension to continue.`,
      });
    } catch { /* notifications permission may not be granted */ }
  }


  // End-of-scan summary: if downloads were deferred, tell the user how to get their photos.
  // Suppressed during multi-child scans (non-last children) to avoid misleading the user
  // into thinking the entire scan is done when only one child has finished.
  if (!suppressEndMessages) {
    if (deferDownloads && approved > 0) {
      const pendingAll = await getAllPendingDownloads().catch(() => []);
      const pendingCount = pendingAll.filter(p => String(p.childId) === String(childId)).length;
      await logger("INFO", `📋 ${pendingCount} photos/videos cached for ${childName} — go to Review tab and click "📥 Download Approved" to save them.`);
    }

    // Chrome notification so parents can leave the scan running in the background
    try {
      chrome.notifications.create(`scan-done-${childId}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Storypark Smart Saver",
        message: `✅ ${childName}: ${approved} downloaded, ${queued} to review${skippedAbsent > 0 ? `, ${skippedAbsent} skipped (absent days)` : ""}`,
      });
    } catch { /* notifications permission may not be granted */ }
  }

  return { approved, queued, rejected, skippedAbsent, cancelled: scanCancelled };
}

/* ================================================================== */
/*  Review approve handler                                             */
/* ================================================================== */

async function handleReviewApprove(id, selectedFaceIndex = 0) {
  const item = await getReviewQueueItem(id);
  if (!item) throw new Error("Review item not found.");

  // Determine which descriptor to use (multi-face support)
  let descriptor = item.descriptor;
  if (item.allFaces && item.allFaces.length > selectedFaceIndex) {
    descriptor = item.allFaces[selectedFaceIndex].descriptor;
  }

  // Persist the confirmed face descriptor for continuous learning
  if (descriptor && item.childId) {
    const reviewDate = item.storyData?.createdAt ? new Date(item.storyData.createdAt) : null;
    const reviewYear = reviewDate ? reviewDate.getFullYear().toString() : "unknown";
    await appendDescriptor(item.childId, item.childName, descriptor, reviewYear);
    // Refresh the offscreen document's in-memory profile cache so the next
    // batch of processed photos uses the expanded descriptor set.
    sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});

    // 3-Phase: increment verified face count for this child
    await incrementVerifiedCount(item.childId);
  }

  // Offline files (from runOfflineScan) are already on disk — just learn the
  // face descriptor and advance phase; skip the Storypark download step entirely.
  if (item.isOfflineFile) {
    await removeFromReviewQueue(id);
    lastReviewAction = {
      action: "approve",
      item: { ...item, croppedFaceDataUrl: null, allFaces: undefined },
      descriptor: descriptor ? Array.from(descriptor) : null,
    };
    chrome.storage.session.set({ lastReviewAction }).catch(() => {});
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    return;
  }

  // Look up GPS from IDB centreProfiles (O(1)).
  const centreName = item.storyData?.centreName;
  const gpsCoords = centreName
    ? await getCentreGPS(centreName).catch(() => null)
    : null;

  // Check if downloads should be deferred based on the child's current phase.
  // Phase 1-3: save to pending downloads instead of downloading immediately.
  // Phase 4 or no childId: download immediately.
  const childPhase = item.childId ? await getChildPhase(item.childId) : { phase: 4 };
  const deferApproval = childPhase.phase < 4;

  if (deferApproval) {
    // Defer: save to pending downloads for later batch download
    await addPendingDownload({
      itemType: "image",
      childId:      item.childId,
      childName:    item.childName,
      storyData:    item.storyData,
      savePath:     item.savePath,
      description:  item.description || "",
      exifTitle:    item.exifTitle || "",
      exifSubject:  item.exifSubject || "",
      exifComments: item.exifComments || "",
      gpsCoords,
    });
  } else {
    // Phase 4: download immediately
    const approveResult = await sendToOffscreen({
      type:        "DOWNLOAD_APPROVED",
      storyData:   item.storyData,
      description: item.description || "",
      exifTitle:   item.exifTitle   || "",
      exifSubject: item.exifSubject || "",
      exifComments:item.exifComments|| "",
      childName:   item.childName,
      savePath:    item.savePath,
      gpsCoords,
    });
    if (approveResult.dataUrl && approveResult.savePath) {
      await downloadDataUrl(approveResult.dataUrl, approveResult.savePath);
    }
  }

  await removeFromReviewQueue(id);

  // Store undo state — persist to session storage so undo survives a service
  // worker restart between the action and the user pressing Undo.
  // Strip large base64 image fields to stay within session storage limits.
  lastReviewAction = {
    action: "approve",
    item: { ...item, croppedFaceDataUrl: null, allFaces: undefined },
    descriptor: descriptor ? Array.from(descriptor) : null,
  };
  chrome.storage.session
    .set({ lastReviewAction })
    .catch(() => {});

  chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
}

/* ================================================================== */
/*  Message router                                                     */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;

  switch (msg.type) {

    case "GET_CHILDREN": {
      chrome.storage.local.get("children", ({ children = [] }) => {
        sendResponse({ ok: true, children });
      });
      return true; // async
    }

    case "REFRESH_PROFILE": {
      loadAndCacheProfile()
        .then((children) => sendResponse({ ok: true, children }))
        .catch((err)     => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "EXTRACT_LATEST":
    case "DEEP_RESCAN": {
      const { childId, childName } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child selected." });
        return false;
      }
      if (isScanning) {
        sendResponse({ ok: false, error: "A scan is already in progress." });
        return false;
      }
      // Set scanning flag synchronously to prevent race conditions.
      isScanning      = true;
      cancelRequested = false;
      // Persist to session storage so the popup can restore state if re-opened
      // while the service worker is still running.
      chrome.storage.session
        .set({ isScanning: true, cancelRequested: false, _requestCount: 0 })
        .catch(() => {});
      runExtraction(childId, childName || childId, msg.type)
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }))
        .finally(() => chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {}));
      return true;
    }

    case "EXTRACT_ALL_LATEST":
    case "DEEP_RESCAN_ALL": {
      if (isScanning) {
        sendResponse({ ok: false, error: "A scan is already in progress." });
        return false;
      }
      isScanning      = true;
      cancelRequested = false;
      chrome.storage.session
        .set({ isScanning: true, cancelRequested: false, _requestCount: 0 })
        .catch(() => {});
      (async () => {
        const { children = [] } = await chrome.storage.local.get("children");
        if (children.length === 0) {
          isScanning = false;
          chrome.storage.session.set({ isScanning: false }).catch(() => {});
          sendResponse({ ok: false, error: "No children cached. Refresh your profile first." });
          return;
        }
        const mode = msg.type === "EXTRACT_ALL_LATEST" ? "EXTRACT_LATEST" : "DEEP_RESCAN";
        let totalApproved = 0, totalQueued = 0, totalRejected = 0;
        let wasCancelled  = false;
        try {
          for (let i = 0; i < children.length; i++) {
            // Stop before the next child if a cancel was requested.
            // wasCancelled snapshots the state because runExtraction's finally
            // block resets cancelRequested to false after each child.
            if (wasCancelled) break;
            const child   = children[i];
            // Keep the offscreen document alive across child iterations to
            // avoid the teardown/re-init cycle, which can produce "message
            // port closed" errors while the new document's module scripts
            // are still loading.  We close it explicitly once all children
            // are done (or on cancellation) in the outer finally block below.
            const isLastChild = i === children.length - 1;
            await logger("INFO", `Scanning ${child.name} (${i + 1}/${children.length})…`);
            chrome.runtime.sendMessage({
              type: "LOG",
              message: `📋 Scanning ${child.name} (${i + 1}/${children.length})…`,
            }).catch(() => {});
            try {
              const stats = await runExtraction(child.id, child.name, mode, {
                closeOffscreenOnExit: isLastChild,
                suppressEndMessages: !isLastChild,
                childIndex: i + 1,
                childCount: children.length,
              });
              totalApproved  += stats.approved;
              totalQueued    += stats.queued;
              totalRejected  += stats.rejected;
              // Use the cancelled flag returned by runExtraction. Its finally
              // block resets cancelRequested before we can read it here, so
              // stats.cancelled is the only reliable indicator.
              if (stats.cancelled) wasCancelled = true;
              // Re-assert isScanning so the guard in the message handler
              // keeps blocking new scan requests between child iterations.
              // runExtraction's finally sets isScanning=false, so without
              // this, a new scan could sneak in at the next await point.
              else isScanning = true;
            } catch (err) {
              await logger("ERROR", `Error scanning ${child.name}: ${err.message}`);
              // Re-assert isScanning for the same reason as above: the
              // failed child's finally already cleared it, but the outer
              // loop should continue to the next child.
              isScanning = true;
            }
          }
        } finally {
          isScanning      = false;
          cancelRequested = false;
          // Ensure the offscreen document is closed even if the loop exited
          // early (e.g. cancellation on the first child, where isLastChild
          // would have been false and the document was kept alive).
          await chrome.offscreen.closeDocument().catch(() => {});
          offscreenReady = false;
          chrome.storage.session
            .set({ isScanning: false, cancelRequested: false })
            .catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        }
        sendResponse({
          ok: true,
          stats: { approved: totalApproved, queued: totalQueued, rejected: totalRejected },
        });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "CANCEL_SCAN": {
      cancelRequested = true;
      // Persist so the popup sees the cancellation state even after SW suspend.
      chrome.storage.session.set({ cancelRequested: true }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    case "GET_SCAN_STATUS": {
      sendResponse({ ok: true, isScanning, cancelRequested });
      return false;
    }

    case "TEST_CONNECTION": {
      apiFetch(`${STORYPARK_BASE}/api/v3/users/me`)
        .then((data) => {
          const email = data?.user?.email || data?.email || "";
          sendResponse({ ok: true, email });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_REVIEW_QUEUE": {
      getReviewQueue()
        .then((queue) => sendResponse({ ok: true, queue }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "REVIEW_APPROVE": {
      handleReviewApprove(msg.id, msg.selectedFaceIndex ?? 0)
        .then(()    => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "REVIEW_REJECT": {
      (async () => {
        const item = await getReviewQueueItem(msg.id).catch(() => null);
        await removeFromReviewQueue(msg.id);
        // Persist rejection so re-scans don't re-queue the same image
        if (item?.storyData?.storyId && item?.storyData?.originalUrl) {
          await addRejection(item.storyData.storyId, item.storyData.originalUrl).catch(() => {});
        }
        // Save face descriptor to negative profile ("not my child") for
        // contrastive learning — rejected faces actively improve accuracy
        // by teaching the model what the child does NOT look like.
        if (item?.descriptor && item?.childId) {
          const selectedIdx = msg.selectedFaceIndex ?? 0;
          const desc = (item.allFaces && item.allFaces.length > selectedIdx)
            ? item.allFaces[selectedIdx].descriptor
            : item.descriptor;
          if (desc) {
            await appendNegativeDescriptor(item.childId, desc).catch(() => {});
          }
        }
        // Store undo state
        if (item) {
          lastReviewAction = {
            action: "reject",
            item: { ...item, croppedFaceDataUrl: null, allFaces: undefined },
          };
          chrome.storage.session
            .set({ lastReviewAction })
            .catch(() => {});
        }
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
        sendResponse({ ok: true });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "UNDO_LAST_REVIEW": {
      (async () => {
        if (!lastReviewAction) {
          sendResponse({ ok: false, error: "Nothing to undo." });
          return;
        }
        const { action, item, descriptor } = lastReviewAction;

        // If we approved and learned a descriptor, remove it
        if (action === "approve" && descriptor && item.childId) {
          const existing = await getDescriptors(item.childId).catch(() => null);
          if (existing?.descriptors) {
            // Remove the last descriptor that matches
            const descStr = JSON.stringify(descriptor);
            const idx = existing.descriptors.findLastIndex(
              (d) => JSON.stringify(d) === descStr
            );
            if (idx !== -1) {
              existing.descriptors.splice(idx, 1);
              await setDescriptors(item.childId, existing.childName, existing.descriptors);
              sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
            }
          }
        }

        // Put the item back in the review queue
        await addToReviewQueue(item);
        lastReviewAction = null;
        chrome.storage.session.set({ lastReviewAction: null }).catch(() => {});
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
        sendResponse({ ok: true });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RESET_FACE_DATA": {
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      (async () => {
        await setDescriptors(childId, "", []);
        // 3-Phase: reset phase back to Phase 1 when face data is cleared
        await resetChildPhase(childId);
        sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
        sendResponse({ ok: true });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    /* ── 3-Phase adaptive face recognition messages ── */

    case "GET_CHILD_PHASE": {
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      getChildPhase(childId)
        .then((phase) => sendResponse({ ok: true, phase }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_ALL_CHILD_PHASES": {
      getAllChildPhases()
        .then((phases) => sendResponse({ ok: true, phases }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RESTORE_PHASE": {
      // Restore phase data from an imported profile backup.
      // Only used when importing a profile that includes phase data.
      const { childId, phaseData } = msg;
      if (!childId || !phaseData) {
        sendResponse({ ok: false, error: "Missing childId or phaseData." });
        return false;
      }
      setChildPhase(childId, {
        phase:          phaseData.phase          ?? 1,
        verifiedCount:  phaseData.verifiedCount  ?? 0,
        phase1Complete: phaseData.phase1Complete  ?? false,
        phase2Complete: phaseData.phase2Complete  ?? false,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "ADVANCE_PHASE": {
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      advancePhase(childId)
        .then((result) => {
          if (result.advanced) {
            const p = result.phase;
            const EMOJIS = { 2: "✅", 3: "📊", 4: "🚀" };
            const LABELS = { 2: "Validation", 3: "Confident", 4: "Production" };
            const emoji = EMOJIS[p.phase] || "📊";
            const label = LABELS[p.phase] || "Unknown";
            logger("SUCCESS", `${emoji} Phase ${p.phase} unlocked for ${childId}: ${label} mode!`);
            chrome.runtime.sendMessage({ type: "PHASE_ADVANCED", childId, phase: p }).catch(() => {});
          }
          sendResponse({ ok: true, ...result });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_MODEL_CONFIDENCE": {
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      computeModelConfidence(childId)
        .then((data) => sendResponse({ ok: true, ...data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_AUTO_THRESHOLD": {
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      computeAutoThreshold(childId)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_ACTIVITY_LOG": {
      chrome.storage.local.get("activityLog", ({ activityLog = [] }) => {
        sendResponse({ ok: true, activityLog });
      });
      return true;
    }

    case "CLEAR_ACTIVITY_LOG": {
      chrome.storage.local.set({ activityLog: [] })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "LOG_TO_ACTIVITY": {
      // Lets dashboard.js (page context) write structured entries to the activity log.
      // Useful for logging Rewrite Metadata, Repair Database, Reconcile, etc.
      // msg: { level, message, storyDate?, meta? }
      logger(msg.level || "INFO", msg.message || "", msg.storyDate || null, msg.meta || null);
      sendResponse({ ok: true });
      return false; // synchronous — no async response needed
    }

    case "PROCESS_TRAINING_IMAGE": {
      const { childId, childName, imageDataUri, faceIndex = 0 } = msg;
      if (!childId || !imageDataUri) {
        sendResponse({ ok: false, error: "Missing childId or imageDataUri." });
        return false;
      }
      (async () => {
        try {
          const encRes = await sendToOffscreen({
            type:         "BUILD_ENCODING",
            imageDataUrl: imageDataUri,
            faceIndex,
          });
          if (!encRes?.ok || !encRes.descriptor) {
            sendResponse({ ok: false, error: "No face detected in image." });
            return;
          }
          await saveDescriptor(childId, childName ?? childId, encRes.descriptor);
          // Refresh the offscreen profile cache so new training data is used
          // immediately in any subsequent extraction.
          sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "SAVE_TRAINING_DESCRIPTOR": {
      // Save a pre-computed face descriptor (from the options-page live preview)
      // directly, without re-running face detection in the offscreen document.
      // This is the preferred path when the options page has already confirmed
      // a face is present – it avoids duplicated model inference and the failure
      // modes that can occur when the offscreen document has not yet loaded.
      const { childId, childName, descriptor } = msg;
      if (!childId || !Array.isArray(descriptor) || descriptor.length === 0) {
        sendResponse({ ok: false, error: "Missing childId or descriptor." });
        return false;
      }
      appendDescriptor(childId, childName ?? childId, descriptor)
        .then(() => {
          sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
          sendResponse({ ok: true });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "DISCOVER_CENTRES": {
      // Try all discovery paths: /users/me communities, per-child companies,
      // and the dedicated /api/v3/centres endpoint.
      // loadAndCacheProfile() covers all three paths, so calling it here gives
      // the best chance of finding centres even when one endpoint is unavailable.
      loadAndCacheProfile()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_DIAGNOSTIC_LOG": {
      // Return the in-memory diagnostic API log plus current centreLocations so
      // the options page can offer a "Download Diagnostic Logs" JSON file.
      // Also returns the current debugCaptureMode state so the UI can sync.
      chrome.storage.local.get("centreLocations", ({ centreLocations = {} }) => {
        sendResponse({
          ok: true,
          log: _diagnosticLog.slice(),
          centreLocations,
          capturedAt: new Date().toISOString(),
          debugCaptureMode,
        });
      });
      return true; // async
    }

    case "CLEAR_DIAGNOSTIC_LOG": {
      // Empty the in-memory diagnostic log (does not affect persisted data).
      _diagnosticLog.length = 0;
      sendResponse({ ok: true });
      return false;
    }

    case "SET_DEBUG_CAPTURE_MODE": {
      // Enable or disable verbose API response capture.
      // NOTE: Temporary debug feature — disable during normal use to save memory.
      const enabled = msg.enabled === true;
      debugCaptureMode = enabled;
      chrome.storage.local.set({ debugCaptureMode: enabled })
        .then(() => sendResponse({ ok: true, debugCaptureMode }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // async
    }

    case "REVIEW_TRAIN_ONLY": {
      // Save the face descriptor from a review-queue item to improve the
      // recognition model, but do NOT download the photo.  Instead, save it
      // to the pending-downloads queue for later batch download.
      (async () => {
        try {
          const item = await getReviewQueueItem(msg.id);
          if (!item) throw new Error("Review item not found.");

          let descriptor = item.descriptor;
          if (item.allFaces && item.allFaces.length > (msg.selectedFaceIndex ?? 0)) {
            descriptor = item.allFaces[msg.selectedFaceIndex ?? 0].descriptor;
          }

          if (descriptor && item.childId) {
            const trainDate = item.storyData?.createdAt ? new Date(item.storyData.createdAt) : null;
            const trainYear = trainDate ? trainDate.getFullYear().toString() : "unknown";
            await appendDescriptor(item.childId, item.childName, descriptor, trainYear);
            sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});

            // 3-Phase: increment verified face count (train-only still confirms identity)
            await incrementVerifiedCount(item.childId);
          }

          // Save to pending-downloads queue for later batch download
          await addPendingDownload({
            childId:      item.childId,
            childName:    item.childName,
            storyData:    item.storyData,
            savePath:     item.savePath,
            description:  item.description || "",
            exifTitle:    item.exifTitle || "",
            exifSubject:  item.exifSubject || "",
            exifComments: item.exifComments || "",
          });

          await removeFromReviewQueue(msg.id);
          chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "BATCH_DOWNLOAD_APPROVED": {
      // Download all pending items, then generate story HTML + index pages.
      // Order: ALL media first → story HTML per story → index pages.
      // This guarantees no broken image references in generated HTML.
      (async () => {
        try {
          await ensureOffscreen();
          const items = msg.childId
            ? await getPendingDownloads(msg.childId)
            : await getAllPendingDownloads();
          if (items.length === 0) {
            sendResponse({ ok: true, downloaded: 0 });
            return;
          }

          // ── Phase 1: Group items by storyId ──
          const storyGroups = new Map(); // storyId → { items[], downloadedFilenames[] }
          for (const item of items) {
            const sid = item.storyId || item.storyData?.storyId || "unknown";
            if (!storyGroups.has(sid)) {
              storyGroups.set(sid, { items: [], downloadedFilenames: [] });
            }
            storyGroups.get(sid).items.push(item);
          }

          // ── Phase 2: Download ALL media across ALL stories ──
          let downloaded = 0;
          let failed = 0;
          let batchItemsDone = 0;
          const batchTotal = items.length;
          const _batchLoopStart = Date.now(); // ETA tracking
          const { saveStoryHtml = true } = await chrome.storage.local.get("saveStoryHtml");
          // GPS cache: Map<centreName, {lat,lng}|null> — one IDB lookup per unique centre name
          const _gpsCache = new Map();

          for (const [storyId, group] of storyGroups) {
            for (const item of group.items) {
              let wroteFile = false;
              try {
                // Resolve GPS coordinates
                let gpsCoords = item.gpsCoords || null;
                if (!gpsCoords) {
                  const cName = item.centreName || item.storyData?.centreName;
                  if (cName) {
                    if (!_gpsCache.has(cName)) {
                      _gpsCache.set(cName, await getCentreGPS(cName).catch(() => null));
                    }
                    gpsCoords = _gpsCache.get(cName);
                  }
                }

                const itemType = item.itemType || "image";

                if (itemType === "video") {
                  // Videos: fetch via DOWNLOAD_VIDEO (blob-URL path, OOM-safe)
                  // — see downloadVideoFromOffscreen() for rationale.
                  const vidResult = await sendToOffscreen({
                    type: "DOWNLOAD_VIDEO",
                    videoUrl: item.imageUrl,
                    savePath: item.savePath,
                  });
                  if (vidResult?.blobUrl && vidResult?.savePath) {
                    await downloadVideoFromOffscreen(vidResult);
                    group.downloadedFilenames.push(item.filename);
                    downloaded++;
                    wroteFile = true;
                  }
                } else {
                  // Images: fetch + EXIF stamp via DOWNLOAD_APPROVED
                  const result = await sendToOffscreen({
                    type:        "DOWNLOAD_APPROVED",
                    storyData:   item.storyData || { originalUrl: item.imageUrl },
                    description: item.description || "",
                    exifTitle:   item.exifTitle || "",
                    exifSubject: item.exifSubject || "",
                    exifComments:item.exifComments || "",
                    childName:   item.childName,
                    savePath:    item.savePath,
                    gpsCoords,
                  });
                  if (result.dataUrl && result.savePath) {
                    await downloadDataUrl(result.dataUrl, result.savePath);
                    group.downloadedFilenames.push(item.filename);
                    downloaded++;
                    wroteFile = true;
                  }
                }
              } catch (err) {
                console.warn(`Batch download failed for item ${item.id}:`, err.message);
              }

              if (wroteFile) {
                // Only remove from queue AFTER confirming a file was actually written.
                // Items that failed (threw, or got no dataUrl) stay in the queue so
                // the "Download N Approved" button shows the correct remaining count.
                await removePendingDownload(item.id);
              } else {
                failed++;
              }

              // Broadcast progress + ETA every 10 items so the dashboard can show a live bar.
              batchItemsDone++;
              if (batchItemsDone % 10 === 0 || batchItemsDone === batchTotal) {
                const _batchElapsed = Date.now() - _batchLoopStart;
                const _batchAvgMs  = batchItemsDone > 0 ? _batchElapsed / batchItemsDone : 0;
                const _batchEta    = (batchItemsDone >= 5 && _batchAvgMs > 0 && (batchTotal - batchItemsDone) > 0)
                  ? formatETA(_batchAvgMs * (batchTotal - batchItemsDone)) : "";
                chrome.runtime.sendMessage({
                  type: "BATCH_PROGRESS",
                  done: batchItemsDone,
                  total: batchTotal,
                  downloaded,
                  failed,
                  eta: _batchEta,
                }).catch(() => {});
              }
            }
          }

          // ── Phase 3: Generate story HTML per story (AFTER all media downloaded) ──
          // Skip entirely if nothing was actually written — avoids overwriting index.html
          // and regenerating all story HTML pages when the batch was a no-op (e.g. all
          // items failed due to a Storypark rate-limit or login expiry).
          if (saveStoryHtml && downloaded > 0) {

            // Get all unique childIds that had downloads

            const childIds = new Set();
            for (const [, group] of storyGroups) {
              for (const item of group.items) {
                if (item.childId) childIds.add(item.childId);
              }
            }

            for (const childId of childIds) {
              const storyManifests = await getDownloadedStories(childId).catch(() => []);

              for (const manifest of storyManifests) {
                // Find the matching story group that had actual downloads
                const group = storyGroups.get(manifest.storyId);
                if (!group || group.downloadedFilenames.length === 0) continue;

                try {
                  const storyBasePath = `Storypark Smart Saver/${sanitizeName(manifest.childName)}/Stories/${manifest.folderName}`;
                  const routineText = manifest.storyRoutine || "";
                  const storyBody   = manifest.storyBody || manifest.excerpt || "";

                  // ── story.html ──
                  const htmlContent = buildStoryHtml({
                    title: manifest.storyTitle,
                    date: manifest.storyDate,
                    body: storyBody,
                    childName: manifest.childName,
                    childAge: manifest.childAge || "",
                    roomName: manifest.roomName || "",
                    centreName: manifest.centreName || "",
                    educatorName: manifest.educatorName || "",
                    routineText,
                    mediaFilenames: manifest.approvedFilenames || [],
                  });
                  const txtRes = await sendToOffscreen({
                    type: "DOWNLOAD_TEXT",
                    text: htmlContent,
                    savePath: `${storyBasePath}/story.html`,
                    mimeType: "text/html",
                  });
                  if (txtRes.dataUrl && txtRes.savePath) {
                    await downloadHtmlFile(txtRes.dataUrl, txtRes.savePath);
                  }

                  // ── story card (JPEG) ── regenerated with correct photo count
                  if (storyBody && (manifest.approvedFilenames || []).length > 0) {
                    try {
                      const gpsCoords = manifest.centreName
                        ? await getCentreGPS(manifest.centreName).catch(() => null)
                        : null;
                      const cardSavePath = `${storyBasePath}/${manifest.storyDate || "story"} - Story Card.jpg`;
                      const cardResult = await sendToOffscreen({
                        type: "GENERATE_STORY_CARD",
                        title: manifest.storyTitle,
                        date: manifest.storyDate,
                        body: storyBody,
                        centreName: manifest.centreName || "",
                        roomName: manifest.roomName || "",
                        educatorName: manifest.educatorName || "",
                        childName: manifest.childName,
                        childAge: manifest.childAge || "",
                        routineText,
                        photoCount: (manifest.approvedFilenames || []).length,
                        gpsCoords,
                        savePath: cardSavePath,
                      });
                      if (cardResult.ok && cardResult.dataUrl) {
                        await downloadDataUrl(cardResult.dataUrl, cardSavePath);
                      }
                    } catch { /* non-fatal */ }
                  }
                } catch (err) {
                  console.warn(`Story HTML generation failed for ${manifest.storyId}:`, err.message);
                }
              }
            }
          }

          // ── Phase 4: Generate index pages (AFTER all HTML generated) ──
          try {
            const { children = [] } = await chrome.storage.local.get("children");
            // Root children index (overwrite)
            const rootHtml = buildChildrenIndexHtml(children);
            const rootRes = await sendToOffscreen({
              type: "DOWNLOAD_TEXT", text: rootHtml,
              savePath: "Storypark Smart Saver/index.html", mimeType: "text/html",
            });
            if (rootRes.dataUrl && rootRes.savePath) {
              await downloadHtmlFile(rootRes.dataUrl, rootRes.savePath);
            }
            // Per-child story index pages (overwrite)
            for (const child of children) {
              const manifests = await getDownloadedStories(child.id).catch(() => []);
              if (manifests.length === 0) continue;
              const childIndexHtml = buildMasterIndexHtml(child.name, manifests);
              const childPath = `Storypark Smart Saver/${sanitizeName(child.name)}/Stories/index.html`;
              const ciRes = await sendToOffscreen({
                type: "DOWNLOAD_TEXT", text: childIndexHtml,
                savePath: childPath, mimeType: "text/html",
              });
              if (ciRes.dataUrl && ciRes.savePath) {
                await downloadHtmlFile(ciRes.dataUrl, ciRes.savePath);
              }
            }
          } catch (err) {
            console.warn("Index page generation failed:", err.message);
          }

          sendResponse({ ok: true, downloaded, failed, remaining: failed });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "GET_PENDING_DOWNLOADS_COUNT": {
      (async () => {
        try {
          const items = msg.childId
            ? await getPendingDownloads(msg.childId)
            : await getAllPendingDownloads();
          sendResponse({ ok: true, count: items.length });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "RE_EVALUATE_QUEUE": {
      // Re-evaluate review queue items using current face profiles.
      // Runs the enhanced matching pipeline (centroid + top-K + margin-based
      // negative scoring) against stored descriptors in each queue item.
      // Items that now score above autoThreshold are auto-approved; items
      // that score below minThreshold with high negative are auto-rejected.
      // Everything else stays in the queue.
      (async () => {
        try {
          const childId = msg.childId;
          if (!childId) {
            sendResponse({ ok: false, error: "No childId specified." });
            return;
          }
          const {
            autoThreshold: userAuto = 85,
            minThreshold: userMin = 50,
          } = await chrome.storage.local.get(["autoThreshold", "minThreshold"]);
          const childPhaseData = await getChildPhase(childId);
          let autoThreshold = userAuto;
          if (childPhaseData.phase === 1) autoThreshold = 100;
          else if (childPhaseData.phase === 2) autoThreshold = 95;

          const allDescs = await getAllDescriptors();
          const childDesc = allDescs.find(d => String(d.childId) === String(childId));
          if (!childDesc || !childDesc.descriptors || childDesc.descriptors.length === 0) {
            sendResponse({ ok: true, autoApproved: 0, autoRejected: 0, remaining: 0 });
            return;
          }
          const negDescs = await getNegativeDescriptors(childId).catch(() => []);
          const queue = await getReviewQueue();
          const childQueue = queue.filter(item => String(item.childId) === String(childId) && item.descriptor);

          let autoApproved = 0;
          let autoRejected = 0;

          // Send descriptor data to offscreen for re-evaluation
          await ensureOffscreen();
          const result = await sendToOffscreen({
            type: "RE_EVALUATE_BATCH",
            items: childQueue.map(item => ({
              id: item.id,
              descriptor: item.descriptor,
              allFaces: item.allFaces,
            })),
            positiveDescriptors: childDesc.descriptors,
            descriptorsByYear: childDesc.descriptorsByYear || {},
            negativeDescriptors: negDescs,
            autoThreshold,
            minThreshold: userMin,
            disableAutoReject: childPhaseData.phase < 3, // Phase 1&2 safety: never auto-reject immature model
          });

          if (result?.results) {
            for (const r of result.results) {
              if (r.decision === "approve") {
                // Auto-approve: save descriptor + move to pending downloads
                const item = childQueue.find(q => q.id === r.id);
                if (item) {
                  // Save descriptor for learning
                  if (item.descriptor && item.childId) {
                    const rd = item.storyData?.createdAt ? new Date(item.storyData.createdAt) : null;
                    const ry = rd ? rd.getFullYear().toString() : "unknown";
                    await appendDescriptor(item.childId, item.childName, item.descriptor, ry);
                    await incrementVerifiedCount(item.childId);
                  }
                  // Move to pending downloads
                  await addPendingDownload({
                    childId: item.childId,
                    childName: item.childName,
                    storyData: item.storyData,
                    savePath: item.savePath,
                    description: item.description || "",
                    exifTitle: item.exifTitle || "",
                    exifSubject: item.exifSubject || "",
                    exifComments: item.exifComments || "",
                  });
                  await removeFromReviewQueue(r.id);
                  autoApproved++;
                }
              } else if (r.decision === "reject") {
                const item = childQueue.find(q => q.id === r.id);
                if (item) {
                  // Save to rejection tracking + negative profile
                  if (item.storyData?.storyId && item.storyData?.originalUrl) {
                    await addRejection(item.storyData.storyId, item.storyData.originalUrl).catch(() => {});
                  }
                  if (item.descriptor && item.childId) {
                    await appendNegativeDescriptor(item.childId, item.descriptor).catch(() => {});
                  }
                  await removeFromReviewQueue(r.id);
                  autoRejected++;
                }
              }
              // "keep" = stays in queue, no action needed
            }
          }

          // Refresh profiles after all the descriptor additions
          if (autoApproved > 0) {
            sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
          }

          const remaining = childQueue.length - autoApproved - autoRejected;
          chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
          sendResponse({ ok: true, autoApproved, autoRejected, remaining });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "BUILD_INDEX_PAGES": {
      // Rebuild the master index pages (child stories index + root children index).
      (async () => {
        try {
          const { children = [] } = await chrome.storage.local.get("children");
          await ensureOffscreen();
          // Build root children index (overwrite)
          const rootHtml = buildChildrenIndexHtml(children);
          const rootRes = await sendToOffscreen({
            type: "DOWNLOAD_TEXT", text: rootHtml,
            savePath: "Storypark Smart Saver/index.html", mimeType: "text/html",
          });
          if (rootRes.dataUrl && rootRes.savePath) {
            await downloadHtmlFile(rootRes.dataUrl, rootRes.savePath);
          }
          // Build per-child story index pages
          for (const child of children) {
            const manifests = await getDownloadedStories(child.id).catch(() => []);
            if (manifests.length === 0) continue;
            const childIndexHtml = buildMasterIndexHtml(child.name, manifests);
            const childPath = `Storypark Smart Saver/${sanitizeName(child.name)}/Stories/index.html`;
            const ciRes = await sendToOffscreen({
              type: "DOWNLOAD_TEXT", text: childIndexHtml,
              savePath: childPath, mimeType: "text/html",
            });
            if (ciRes.dataUrl && ciRes.savePath) {
              await downloadHtmlFile(ciRes.dataUrl, ciRes.savePath);
            }
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "BUILD_HTML_STRUCTURE": {
      // Regenerate ALL story HTML files + story cards + index pages from stored
      // manifests (no photo downloads).  Uses conflictAction: "overwrite" so pages
      // always reflect the latest state.  Also reads stored routine data so the
      // rebuilt pages include the correct routine section.
      (async () => {
        try {
          await ensureOffscreen();
          const { children = [], saveStoryCard = true } = await chrome.storage.local.get(["children", "saveStoryCard"]);
          let storyCount = 0, cardCount = 0;

          for (const child of children) {
            const manifests = await getDownloadedStories(child.id).catch(() => []);
            if (manifests.length === 0) continue;

            for (const m of manifests) {
              try {
                const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;

                // Use stored routine text (fixes the hardcoded "" bug)
                const routineText = m.storyRoutine || "";

                // Try to get the full story body from the manifest, or fall back to
                // the IDB story cache so recovered-from-disk stories show real content.
                let storyBody = m.storyBody || "";
                if (!storyBody && m.storyId && !m.storyId.startsWith("recovered_")) {
                  const cached = await getCachedStory(m.storyId).catch(() => null);
                  if (cached) {
                    storyBody = cached.display_content || cached.body || cached.excerpt || "";
                    // Persist back to manifest so future rebuilds are faster
                    if (storyBody) {
                      addDownloadedStory({ ...m, storyBody }).catch(() => {});
                    }
                  }
                }

                // ── story.html ── honour rejectedFilenames (never link to rejected)
                const rejectedSet = new Set(m.rejectedFilenames || []);
                const approvedOnly = (m.approvedFilenames || []).filter(f => !rejectedSet.has(f));
                const htmlContent = buildStoryHtml({
                  title: m.storyTitle,
                  date: m.storyDate,
                  body: storyBody,
                  childName: m.childName,
                  childAge: m.childAge || "",
                  roomName: m.roomName || "",
                  centreName: m.centreName || "",
                  educatorName: m.educatorName || "",
                  routineText,
                  mediaFilenames: approvedOnly,
                });
                const res = await sendToOffscreen({
                  type: "DOWNLOAD_TEXT", text: htmlContent,
                  savePath: `${storyBasePath}/${m.storyHtmlFilename || "story.html"}`, mimeType: "text/html",
                });
                if (res.dataUrl && res.savePath) {
                  await downloadHtmlFile(res.dataUrl, res.savePath);
                  storyCount++;
                }

                // ── story card (JPEG) ── gated on saveStoryCard setting + has body
                if (saveStoryCard && storyBody && approvedOnly.length > 0) {
                  try {
                    const gpsCoords = m.centreName
                      ? await getCentreGPS(m.centreName).catch(() => null)
                      : null;
                    const cardSavePath = `${storyBasePath}/${m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "story - Story Card.jpg")}`;
                    // Photo count excludes videos AND rejected files
                    const photoCount = approvedOnly.filter(
                      f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)
                    ).length;
                    const cardResult = await sendToOffscreen({
                      type: "GENERATE_STORY_CARD",
                      title: m.storyTitle,
                      date: m.storyDate,
                      body: storyBody,
                      centreName: m.centreName || "",
                      roomName: m.roomName || "",
                      educatorName: m.educatorName || "",
                      childName: m.childName,
                      childAge: m.childAge || "",
                      routineText,
                      photoCount,
                      gpsCoords,
                      savePath: cardSavePath,
                    });
                    if (cardResult.ok && cardResult.dataUrl) {
                      await downloadDataUrl(cardResult.dataUrl, cardSavePath);
                      cardCount++;
                    }
                  } catch { /* non-fatal — card generation failure should not block HTML */ }
                }
              } catch (err) {
                console.warn(`Story rebuild failed for ${m.storyId}:`, err.message);
              }
            }
          }

          // Rebuild all index pages using the shared helper
          await _rebuildIndexPages(children);

          await logger("SUCCESS", `📄 HTML rebuilt: ${storyCount} pages${cardCount > 0 ? `, ${cardCount} cards` : ""} + index pages`);

          sendResponse({ ok: true, storyCount });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "FINAL_VERIFICATION": {
      // Re-check ALL pending downloads for a child against the mature face model.
      // Items that fail verification are removed from pending and optionally
      // returned to the review queue. Items that pass stay in pending.
      // This is the "zero human intervention" second pass.
      (async () => {
        try {
          const childId = msg.childId;
          if (!childId) {
            sendResponse({ ok: false, error: "No childId specified." });
            return;
          }
          await ensureOffscreen();

          const {
            autoThreshold: userAuto = 85,
            minThreshold: userMin = 50,
          } = await chrome.storage.local.get(["autoThreshold", "minThreshold"]);

          const allDescs = await getAllDescriptors();
          const childDesc = allDescs.find(d => String(d.childId) === String(childId));
          if (!childDesc || !childDesc.descriptors || childDesc.descriptors.length === 0) {
            sendResponse({ ok: true, verified: 0, rejected: 0, flagged: 0, total: 0 });
            return;
          }
          const negDescs = await getNegativeDescriptors(childId).catch(() => []);
          const pending = await getPendingDownloads(childId);
          const imageItems = pending.filter(p => (p.itemType || "image") === "image" && p.imageUrl);

          let verified = 0, rejected = 0, flagged = 0;

          // Process in batches for efficiency
          for (const item of imageItems) {
            try {
              // Re-fetch the image and run face detection with the mature model
              const result = await sendToOffscreen({
                type: "PROCESS_IMAGE",
                imageUrl: item.imageUrl || item.storyData?.originalUrl,
                storyData: item.storyData || { originalUrl: item.imageUrl },
                description: item.description || "",
                exifTitle: item.exifTitle || "",
                exifSubject: item.exifSubject || "",
                exifComments: item.exifComments || "",
                childId,
                childName: item.childName || "",
                savePath: item.savePath || "",
                childEncodings: [{
                  childId: childDesc.childId,
                  childName: childDesc.childName,
                  descriptors: childDesc.descriptors,
                  descriptorsByYear: childDesc.descriptorsByYear || {},
                }],
                negativeDescriptors: negDescs,
                autoThreshold: userAuto,
                minThreshold: userMin,
              });

              if (result?.result === "approve") {
                verified++;
                // Item stays in pending — it passed verification
              } else if (result?.result === "reject") {
                rejected++;
                await removePendingDownload(item.id);
                // Track rejection so re-scans don't re-queue
                if (item.storyData?.storyId && (item.imageUrl || item.storyData?.originalUrl)) {
                  await addRejection(item.storyData.storyId, item.imageUrl || item.storyData.originalUrl).catch(() => {});
                }
              } else if (result?.result === "review") {
                flagged++;
                // Move back to review queue for manual check
                await addToReviewQueue({
                  childId,
                  childName: item.childName || "",
                  storyData: item.storyData,
                  savePath: item.savePath,
                  description: item.description || "",
                  exifTitle: item.exifTitle || "",
                  exifSubject: item.exifSubject || "",
                  exifComments: item.exifComments || "",
                  matchPct: result.matchPct || 0,
                  descriptor: null,
                  finalVerification: true,
                });
                await removePendingDownload(item.id);
              }
            } catch (err) {
              // If image fetch fails (e.g. Storypark login expired), skip it
              console.warn(`Final verification failed for item ${item.id}:`, err.message);
              verified++; // Assume it's OK if we can't re-verify
            }
          }

          const total = imageItems.length;
          const videoCount = pending.length - imageItems.length;
          await logger("SUCCESS",
            `✅ Final verification: ${verified}/${total} confirmed, ${rejected} rejected, ${flagged} flagged for review` +
            (videoCount > 0 ? ` (${videoCount} videos passed through)` : "")
          );

          if (flagged > 0) {
            chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
          }

          sendResponse({ ok: true, verified, rejected, flagged, total });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "GET_DOWNLOADED_STORIES": {
      // Return downloaded story manifests for a specific child (or all children).
      // Used by the dashboard's folder reconciliation feature.
      const { childId: dsChildId } = msg;
      (async () => {
        try {
          const stories = dsChildId
            ? await getDownloadedStories(dsChildId)
            : [];
          sendResponse({ ok: true, stories });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "ADD_FILE_TO_MANIFEST": {
      // Re-add a filename to a story manifest's approvedFilenames list.
      // Used when a photo rescued from "Rejected Matches" is approved in the Review tab —
      // the file is moved back to Stories/, and this handler updates the IDB manifest
      // so that Build HTML will include the restored photo in story.html and index pages.
      const { childId: amChildId, storyId: amStoryId, filename: amFilename } = msg;
      if (!amChildId || !amStoryId || !amFilename) {
        sendResponse({ ok: false, error: "Missing childId, storyId, or filename." });
        return false;
      }
      (async () => {
        try {
          const manifests = await getDownloadedStories(amChildId);
          const manifest  = manifests.find(m => m.storyId === amStoryId);
          if (manifest) {
            const current = manifest.approvedFilenames || [];
            if (!current.includes(amFilename)) {
              manifest.approvedFilenames = [...current, amFilename];
              // Update thumbnail if the manifest had no photos
              if (!manifest.thumbnailFilename) {
                manifest.thumbnailFilename = amFilename;
              }
              await addDownloadedStory(manifest);
            }
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "GET_CACHE_STATS": {
      (async () => {
        try {
          const fpCount = await countImageFingerprints();
          const scCount = await countCachedStories();
          sendResponse({ ok: true, fingerprints: fpCount, stories: scCount });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "CLEAR_CACHES": {
      (async () => {
        try {
          const what = msg.which || "all"; // "fingerprints", "stories", "all"
          if (what === "fingerprints" || what === "all") await clearAllImageFingerprints();
          if (what === "stories" || what === "all") await clearAllCachedStories();
          await logger("INFO", `🗑️ Cache cleared: ${what}`);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "CLEAR_ALL_REJECTIONS": {
      // Remove all rejection records so previously-rejected photos can be
      // re-evaluated on the next scan (useful after improving the face model
      // or importing a fresh backup).
      clearAllRejections()
        .then(() => {
          logger("INFO", "🔄 All rejected image records cleared — next scan will re-evaluate them.");
          sendResponse({ ok: true });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RUN_ATTENDANCE_DIAGNOSTIC": {
      (async () => {
        try {
          const { children = [] } = await chrome.storage.local.get("children");
          if (children.length === 0) {
            sendResponse({ ok: false, error: "No children found. Refresh profile first." });
            return;
          }

          const results = [];

          for (const child of children) {
            const childId = child.id;
            const childName = child.name;

            // Fetch first 5 pages of stories (~50 stories)
            const storyDates = new Map(); // date -> { titles, childrenTagged }
            let pageToken = null;
            for (let page = 0; page < 5; page++) {
              const url = new URL(`${STORYPARK_BASE}/api/v3/children/${childId}/stories`);
              url.searchParams.set("sort_by", "updated_at");
              url.searchParams.set("story_type", "all");
              if (pageToken) url.searchParams.set("page_token", pageToken);
              const data = await apiFetch(url.toString());
              const stories = data.stories || [];
              for (const s of stories) {
                const date = (s.created_at || s.date || "").split("T")[0];
                if (!date) continue;
                if (!storyDates.has(date)) storyDates.set(date, []);
                storyDates.get(date).push({
                  id: s.id,
                  title: s.excerpt || s.display_subtitle || "(untitled)",
                  subtitle: s.display_subtitle || "",
                  mediaCount: (s.media || []).length,
                  childrenTagged: (s.children || []).map(c => c.display_name || c.first_name || c.id),
                });
              }
              pageToken = data.next_page_token;
              if (!pageToken) break;
              await new Promise(r => setTimeout(r, 800));
            }

            // Fetch routine data for each date
            const dateList = [...storyDates.keys()].sort().reverse();
            const routineByDate = new Map();
            let routinePageToken = "null";
            let routinePages = 0;
            const targetDates = new Set(dateList);

            while (routinePages < 10 && targetDates.size > 0) {
              try {
                const rUrl = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${routinePageToken}`;
                const rData = await apiFetch(rUrl);
                const routines = rData.daily_routines || [];
                for (const r of routines) {
                  if (targetDates.has(r.date)) {
                    const events = (r.events || []).map(e => e.title || e.routine_type || "event");
                    routineByDate.set(r.date, events);
                    targetDates.delete(r.date);
                  }
                }
                routinePageToken = rData.next_page_token;
                if (!routinePageToken) break;
                routinePages++;
                await new Promise(r => setTimeout(r, 800));
              } catch {
                break;
              }
            }

            // Build comparison rows
            const rows = dateList.map(date => {
              const stories = storyDates.get(date) || [];
              const routine = routineByDate.get(date) || [];
              return {
                date,
                hasStories: stories.length > 0,
                storyCount: stories.length,
                storyTitles: stories.map(s => s.subtitle || s.title).slice(0, 3),
                totalPhotos: stories.reduce((sum, s) => sum + s.mediaCount, 0),
                hasRoutine: routine.length > 0,
                routineEvents: routine.slice(0, 5),
                wasPresent: routine.length > 0,
              };
            });

            results.push({ childId, childName, rows });
          }

          sendResponse({ ok: true, results });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* ── Scan resume messages ── */

    case "GET_SCAN_CHECKPOINT": {
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      getScanCheckpoint(childId)
        .then((checkpoint) => sendResponse({ ok: true, checkpoint }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RESUME_SCAN": {
      const { childId, childName } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      if (isScanning) {
        sendResponse({ ok: false, error: "A scan is already in progress." });
        return false;
      }
      (async () => {
        try {
          const checkpoint = await getScanCheckpoint(childId);
          if (!checkpoint) {
            sendResponse({ ok: false, error: "No checkpoint found for this child." });
            return;
          }
          isScanning = true;
          cancelRequested = false;
          chrome.storage.session
            .set({ isScanning: true, cancelRequested: false, _requestCount: 0 })
            .catch(() => {});
          const stats = await runExtraction(
            childId,
            childName || checkpoint.childName || childId,
            checkpoint.mode || "DEEP_RESCAN",
            {
              startIndex: checkpoint.storyIndex || 0,
              resumeAnchorId: checkpoint.lastStoryId || null,
            }
          );
          sendResponse({ ok: true, stats });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        } finally {
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        }
      })();
      return true;
    }

    case "FORCE_PHASE_ADVANCE": {
      // Manually force a child to Phase 4 (Production) — bypasses all
      // requirements. Use when the user is satisfied with their model
      // and wants to start downloading immediately.
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      (async () => {
        try {
          const current = await getChildPhase(childId);
          current.phase = 4;
          current.phase1Complete = true;
          current.phase2Complete = true;
          current.phase3Complete = true;
          await setChildPhase(childId, current);
          await logger("SUCCESS", `🚀 Phase 4 (Production) forced for child ${childId} — downloads now enabled!`);
          chrome.runtime.sendMessage({ type: "PHASE_ADVANCED", childId, phase: current }).catch(() => {});
          sendResponse({ ok: true, phase: current });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* ── Full backup export/import ── */

    case "FULL_BACKUP_EXPORT": {
      (async () => {
        try {
          const { children = [] } = await chrome.storage.local.get("children");
          const allDescs = await getAllDescriptors();
          const allPhases = await getAllChildPhases();
          const allProcessed = await getProcessedStories();
          const allCheckpoints = await getAllScanCheckpoints();
          const allPending = await getAllPendingDownloads();
          const { activityLog = [] } = await chrome.storage.local.get("activityLog");

          // Build per-child profiles
          const profiles = {};
          for (const child of children) {
            const cid = child.id;
            const desc = allDescs.find(d => String(d.childId) === String(cid));
            const phase = allPhases.find(p => String(p.childId) === String(cid));
            const negDescs = await getNegativeDescriptors(cid).catch(() => []);
            // Export full processed story records (with dates) so EXTRACT_LATEST
            // mode can correctly determine where it left off after a backup restore.
            const processed = allProcessed.filter(s => String(s.childId) === String(cid));
            const checkpoint = allCheckpoints.find(c => String(c.childId) === String(cid)) || null;
            const pending = allPending.filter(p => String(p.childId) === String(cid));
            const downloaded = await getDownloadedStories(cid).catch(() => []);

            // Gather rejected image keys for this child (format: "storyId_imageUrl").
            // A rejection key starts with the storyId, so it belongs to this child
            // if that storyId is in the child's processedStories set OR in one of
            // their downloaded-story manifests. (The earlier cid-prefix heuristic
            // was wrong — storyId never starts with childId.)
            const allRejectionKeys = await getAllRejections().catch(() => []);
            const childStoryIds = new Set([
              ...processed.map(s => String(s.storyId || s)),
              ...downloaded.map(d => String(d.storyId)),
            ].filter(Boolean));
            const childRejections = allRejectionKeys.filter(k => {
              const uIdx = k.indexOf("_");
              if (uIdx <= 0) return false;
              const sid = k.substring(0, uIdx);
              return childStoryIds.has(sid);
            });


            profiles[cid] = {
              childName: child.name,
              descriptors: desc?.descriptors || [],
              descriptorsByYear: desc?.descriptorsByYear || {},
              negativeDescriptors: negDescs,
              rejectedImageKeys: childRejections,
              phase: phase || { phase: 1, verifiedCount: 0 },
              processedStoryIds: processed,
              scanCheckpoint: checkpoint,
              pendingDownloads: pending.map(p => {
                // Strip the auto-increment id from pending items
                const { id, ...rest } = p;
                return rest;
              }),
              downloadedStories: downloaded.map(d => {
                const { key, ...rest } = d;
                return rest;
              }),
            };
          }

          // Gather settings
          const settingsKeys = [
            "autoThreshold", "minThreshold", "activeCentreName",
            "centreLocations", "attendanceFilter", "saveStoryHtml",
            "skipFaceRec", "debugCaptureMode",
          ];
          const settings = await chrome.storage.local.get(settingsKeys);


          const backup = {
            version: 3,
            type: "storypark_smart_saver_full_backup",
            exportDate: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest().version,
            children,
            profiles,
            settings,
            activityLog: activityLog.slice(-50), // Last 50 entries only
            // Caches: fingerprints + story cache (optional but saves hours on re-import)
            imageFingerprints: await getAllImageFingerprints().catch(() => []),
            cachedStories: await getAllCachedStories().catch(() => []),
            // v11: Rich Storypark data stores
            childProfiles: await getAllChildProfiles().catch(() => []),
            centreProfiles: await getAllCentreProfiles().catch(() => []),
            educators: await getAllEducators().catch(() => []),
            // fileSystemState intentionally omitted — can be regenerated by integrity check
            _meta: {
              totalDescriptors: allDescs.reduce((sum, d) => sum + (d.descriptors?.length || 0), 0),
              totalNegativeDescriptors: Object.values(profiles).reduce((sum, p) => sum + p.negativeDescriptors.length, 0),
              totalProcessedStories: allProcessed.length,
              totalPendingDownloads: allPending.length,
              childCount: children.length,
              totalFingerprints: await countImageFingerprints().catch(() => 0),
              totalCachedStories: await countCachedStories().catch(() => 0),
            },
          };

          sendResponse({ ok: true, backup });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "FULL_BACKUP_IMPORT": {
      const { backup, mergeMode = "merge" } = msg;
      if (!backup || backup.type !== "storypark_smart_saver_full_backup") {
        sendResponse({ ok: false, error: "Invalid backup file. Expected a Storypark Smart Saver full backup." });
        return false;
      }
      (async () => {
        try {
          const imported = { children: 0, descriptors: 0, phases: 0, stories: 0, pending: 0 };

          // 1. Restore children list
          if (backup.children && backup.children.length > 0) {
            await chrome.storage.local.set({ children: backup.children });
            imported.children = backup.children.length;
          }

          // 2. Restore settings
          if (backup.settings && typeof backup.settings === "object") {
            await chrome.storage.local.set(backup.settings);
          }

          // 3. Restore per-child profiles
          if (backup.profiles) {
            for (const [childId, profile] of Object.entries(backup.profiles)) {
              // Descriptors
              if (profile.descriptors && profile.descriptors.length > 0) {
                if (mergeMode === "merge") {
                  const existing = await getDescriptors(childId).catch(() => null);
                  const existingDescs = existing?.descriptors || [];
                  // Simple merge: union (append new, skip exact duplicates)
                  const existingSet = new Set(existingDescs.map(d => JSON.stringify(d)));
                  const newDescs = profile.descriptors.filter(d => !existingSet.has(JSON.stringify(d)));
                  if (newDescs.length > 0) {
                    const merged = [...existingDescs, ...newDescs];
                    await setDescriptors(childId, profile.childName || "", merged);
                  }
                } else {
                  await setDescriptors(childId, profile.childName || "", profile.descriptors);
                }
                imported.descriptors += profile.descriptors.length;
              }

              // Negative descriptors
              if (profile.negativeDescriptors && profile.negativeDescriptors.length > 0) {
                for (const desc of profile.negativeDescriptors) {
                  await appendNegativeDescriptor(childId, desc);
                }
              }

              // Phase data
              if (profile.phase) {
                if (mergeMode === "merge") {
                  const existing = await getChildPhase(childId);
                  // Keep the higher phase / higher verified count
                  if (profile.phase.phase > existing.phase ||
                      (profile.phase.phase === existing.phase && profile.phase.verifiedCount > existing.verifiedCount)) {
                    await setChildPhase(childId, profile.phase);
                  }
                } else {
                  await setChildPhase(childId, profile.phase);
                }
                imported.phases++;
              }

              // Processed stories — supports both legacy (string[]) and new (object[]) formats
              if (profile.processedStoryIds && profile.processedStoryIds.length > 0) {
                for (const entry of profile.processedStoryIds) {
                  if (typeof entry === "string") {
                    // Legacy format: just story ID strings
                    await markStoryProcessed(entry, "", childId);
                  } else if (entry && entry.storyId) {
                    // New format: full records with dates
                    await markStoryProcessed(entry.storyId, entry.date || "", entry.childId || childId);
                  }
                }
                imported.stories += profile.processedStoryIds.length;
              }

              // Scan checkpoint
              if (profile.scanCheckpoint) {
                await saveScanCheckpoint(profile.scanCheckpoint);
              }

              // Pending downloads
              if (profile.pendingDownloads && profile.pendingDownloads.length > 0) {
                for (const item of profile.pendingDownloads) {
                  await addPendingDownload(item);
                }
                imported.pending += profile.pendingDownloads.length;
              }

              // Rejected image keys — restore so re-scans don't re-queue rejected photos
              if (profile.rejectedImageKeys && profile.rejectedImageKeys.length > 0) {
                for (const key of profile.rejectedImageKeys) {
                  // Key format: "storyId_imageUrl" — split on first underscore
                  const uIdx = key.indexOf("_");
                  if (uIdx > 0) {
                    const storyId = key.substring(0, uIdx);
                    const imageUrl = key.substring(uIdx + 1);
                    await addRejection(storyId, imageUrl).catch(() => {});
                  }
                }
              }

              // Downloaded story manifests
              if (profile.downloadedStories && profile.downloadedStories.length > 0) {
                for (const manifest of profile.downloadedStories) {
                  await addDownloadedStory(manifest);
                }
              }
            }
          }

          // 4. Restore caches (fingerprints + story cache)
          if (backup.imageFingerprints && Array.isArray(backup.imageFingerprints)) {
            for (const fp of backup.imageFingerprints) {
              await saveImageFingerprint(fp).catch(() => {});
            }
          }
          if (backup.cachedStories && Array.isArray(backup.cachedStories)) {
            for (const sc of backup.cachedStories) {
              if (sc.storyId && sc.data) {
                await cacheStory(sc.storyId, sc.data).catch(() => {});
              }
            }
          }

          // 5. Restore v11 rich data stores (if present — v3+ backups)
          if (backup.childProfiles && Array.isArray(backup.childProfiles)) {
            for (const profile of backup.childProfiles) {
              await saveChildProfile(profile).catch(() => {});
            }
          }
          if (backup.centreProfiles && Array.isArray(backup.centreProfiles)) {
            for (const centre of backup.centreProfiles) {
              await saveCentreProfile(centre).catch(() => {});
            }
          } else if (backup.settings?.centreLocations) {
            // Backward compat: v2 backups store centreLocations in settings —
            // migrate to IDB centreProfiles so they're tracked in the new store.
            await importLegacyCentreLocations(backup.settings.centreLocations).catch(() => {});
          }
          if (backup.educators && Array.isArray(backup.educators)) {
            for (const edu of backup.educators) {
              await saveEducator(edu).catch(() => {});
            }
          }

          // 6. Refresh offscreen profiles
          sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});

          // 7. Record last backup import date
          await chrome.storage.local.set({ lastBackupImport: new Date().toISOString() });

          sendResponse({ ok: true, imported });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "GENERATE_STORY_CARD": {
      // Render a 1200 × variable-height JPEG story card via the offscreen Canvas renderer.
      // Routes metadata to offscreen; returns a JPEG data URL for chrome.downloads.
      sendToOffscreen(msg)
        .then((result) => sendResponse(result))
        .catch((err)   => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "SYNC_PROCESSED_FROM_MANIFEST": {
      // Mark every story in the downloaded-stories manifest as processed,
      // without requiring any file on disk.  Used after the user restores
      // ONLY the Database/ folder onto a clean PC (no photo files copied).
      //
      // This trusts Database/manifests.json as the source of truth — every
      // story it lists is considered "done" so the next EXTRACT_LATEST scan
      // resumes from storyId 2001+ instead of re-downloading 1..2000.
      //
      // Safety: does NOT touch rejections.json, descriptors, or any other
      // store.  Rate-limit / OOM-safe because it's pure IDB writes — no
      // Storypark API calls.
      //
      // msg: { childId?: string }  // omit childId to sync all children
      // Returns: { ok, synced, byChild: { [childId]: count } }
      (async () => {
        try {
          const targetChildId = msg.childId ? String(msg.childId) : null;
          const manifests     = await getAllDownloadedStories().catch(() => []);
          const byChild       = {};
          let   synced        = 0;

          for (const m of manifests) {
            if (!m.storyId) continue;
            if (targetChildId && String(m.childId) !== targetChildId) continue;
            try {
              await markStoryProcessed(m.storyId, m.storyDate || "", m.childId);
              byChild[m.childId] = (byChild[m.childId] || 0) + 1;
              synced++;
              // Yield every 20 writes so the IDB transaction pool stays drained
              // on large manifests (e.g. 2000-story restore).
              if (synced % 20 === 0) await idleYield(5);
            } catch (perStoryErr) {
              console.warn("[SYNC_PROCESSED_FROM_MANIFEST] skip", m.storyId, perStoryErr.message);
            }
          }

          await logger("SUCCESS",
            `🔄 Marked ${synced} stories processed from Database/manifests.json — next scan will resume after story ${synced}.`,
            null,
            { synced, byChild },
          );
          sendResponse({ ok: true, synced, byChild });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "SYNC_PROCESSED_FROM_DISK": {
      // Cross-reference the downloadedStories manifest against an on-disk file list
      // supplied by dashboard.js (from walkFolder). For every story whose files are
      // confirmed present on disk, calls markStoryProcessed() so that subsequent
      // EXTRACT_LATEST scans skip those stories instead of re-downloading them.
      //
      // msg: { childId, childName, onDiskPaths: string[] }
      // Returns: { ok, synced, missing }
      (async () => {
        try {
          const { childId, childName, onDiskPaths = [] } = msg;
          const onDiskSet = new Set(onDiskPaths); // full relative paths e.g. "Hugo Hill/Stories/2024-04-14 - Story/photo.jpg"

          const manifests = await getDownloadedStories(childId).catch(() => []);
          // Sanitize child name the same way savePath does in runExtraction
          const INVALID_CHARS = /[/\\:*?"<>|]/g;
          const childSafe = (childName || "").replace(INVALID_CHARS, "_").trim() || "Unknown";

          let synced = 0, missing = 0;
          for (const m of manifests) {
            if (!m.storyId) continue;
            const files = m.approvedFilenames || [];
            if (files.length === 0) continue;
            // Build the expected on-disk relative path for each file and check
            // if at least one file for this story exists on disk.
            const anyOnDisk = files.some(f =>
              onDiskSet.has(`${childSafe}/Stories/${m.folderName}/${f}`)
            );
            if (anyOnDisk) {
              await markStoryProcessed(m.storyId, m.storyDate || "", childId);
              synced++;
            } else {
              missing++;
            }
          }
          sendResponse({ ok: true, synced, missing });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "REWRITE_EXIF_ONLY": {
      // Re-stamp EXIF + IPTC on an already-downloaded JPEG.
      // Routes the image data URL through the offscreen document's applyExif().
      // The modified data URL is returned to dashboard.js which writes it back to disk.
      sendToOffscreen(msg)
        .then((result) => sendResponse(result))
        .catch((err)   => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RECYCLE_OFFSCREEN": {
      // Close and re-create the offscreen document to flush TF.js GPU/CPU memory.
      // Called by runOfflineScan() every ~50 photos to prevent out-of-memory crashes
      // during long face recognition sessions on large photo libraries.
      (async () => {
        try {
          await chrome.offscreen.closeDocument().catch(() => {});
          offscreenReady = false;
          await ensureOffscreen();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "REGENERATE_FROM_DISK": {
      // Regenerate story HTML + story card JPEG for stories whose actual on-disk
      // file list was supplied by dashboard.js (from walkFolder via FSA).
      // Also updates the manifest's approvedFilenames to match what's on disk,
      // and rebuilds index pages.
      //
      // msg: {
      //   filesByFolder: { [folderName: string]: string[] }  — actual media files per folder
      //   childId?: string  — if provided, only manifests for this child are updated
      // }
      // Returns: { ok, rebuilt, updated, errors }
      (async () => {
        try {
          await ensureOffscreen();
          const { filesByFolder = {}, childId: targetChildId } = msg;
          const { children = [], saveStoryCard = true } = await chrome.storage.local.get(["children", "saveStoryCard"]);
          const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

          let rebuilt = 0, updated = 0, errors = 0;

          // Get all manifests (filtered to targetChildId if provided)
          const relevantChildren = targetChildId
            ? children.filter(c => String(c.id) === String(targetChildId))
            : children;

          for (const child of relevantChildren) {
            const manifests = await getDownloadedStories(child.id).catch(() => []);

            for (const m of manifests) {
              const diskFiles = filesByFolder[m.folderName];
              if (!diskFiles) continue; // folder not found on disk — skip

              // Filter to media files only (exclude story.html, story card, etc.)
              const mediaFiles = diskFiles.filter(f => MEDIA_EXT.test(f));
              if (mediaFiles.length === 0) continue;

              try {
                // ── 1. Update manifest with live file list ──
                let manifestChanged = false;
                const currentFiles = new Set(m.approvedFilenames || []);
                const diskSet = new Set(mediaFiles);

                // Add files present on disk but missing from manifest
                for (const f of diskSet) {
                  if (!currentFiles.has(f)) { currentFiles.add(f); manifestChanged = true; }
                }
                // Remove files in manifest that no longer exist on disk
                for (const f of [...currentFiles]) {
                  if (!diskSet.has(f)) { currentFiles.delete(f); manifestChanged = true; }
                }

                const updatedFilenames = [...currentFiles];
                const updatedManifest = {
                  ...m,
                  approvedFilenames: updatedFilenames,
                  thumbnailFilename: m.thumbnailFilename && diskSet.has(m.thumbnailFilename)
                    ? m.thumbnailFilename
                    : updatedFilenames[0] || "",
                };

                if (manifestChanged) {
                  await addDownloadedStory(updatedManifest).catch(() => {});
                  updated++;
                }

                // ── 2. Get best story body (manifest or IDB cache) ──
                let storyBody = m.storyBody || "";
                if (!storyBody && m.storyId && !m.storyId.startsWith("recovered_")) {
                  const cached = await getCachedStory(m.storyId).catch(() => null);
                  if (cached) {
                    storyBody = cached.display_content || cached.body || cached.excerpt || "";
                    if (storyBody) addDownloadedStory({ ...updatedManifest, storyBody }).catch(() => {});
                  }
                }

                const routineText = m.storyRoutine || "";
                const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;

                // ── 3. Rebuild story.html with live file list ──
                const htmlContent = buildStoryHtml({
                  title: m.storyTitle,
                  date: m.storyDate,
                  body: storyBody,
                  childName: m.childName,
                  childAge: m.childAge || "",
                  roomName: m.roomName || "",
                  centreName: m.centreName || "",
                  educatorName: m.educatorName || "",
                  routineText,
                  mediaFilenames: updatedFilenames,
                });
                const htmlRes = await sendToOffscreen({
                  type: "DOWNLOAD_TEXT", text: htmlContent,
                  savePath: `${storyBasePath}/story.html`, mimeType: "text/html",
                });
                if (htmlRes.dataUrl && htmlRes.savePath) {
                  await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
                  rebuilt++;
                }

                // ── 4. Rebuild story card with live photo count ──
                if (saveStoryCard && storyBody && updatedFilenames.length > 0) {
                  try {
                    const gpsCoords = m.centreName
                      ? await getCentreGPS(m.centreName).catch(() => null)
                      : null;
                    const cardSavePath = `${storyBasePath}/${m.storyDate || "story"} - Story Card.jpg`;
                    const cardResult = await sendToOffscreen({
                      type: "GENERATE_STORY_CARD",
                      title: m.storyTitle,
                      date: m.storyDate,
                      body: storyBody,
                      centreName: m.centreName || "",
                      roomName: m.roomName || "",
                      educatorName: m.educatorName || "",
                      childName: m.childName,
                      childAge: m.childAge || "",
                      routineText,
                      photoCount: updatedFilenames.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length,
                      gpsCoords,
                      savePath: cardSavePath,
                    });
                    if (cardResult.ok && cardResult.dataUrl) {
                      await downloadDataUrl(cardResult.dataUrl, cardSavePath);
                    }
                  } catch { /* non-fatal */ }
                }
              } catch (err) {
                console.warn(`[REGENERATE_FROM_DISK] Story ${m.storyId} failed:`, err.message);
                errors++;
              }
            }
          }

          // ── 5. Rebuild index pages ──
          await _rebuildIndexPages(children).catch(() => {});

          await logger("SUCCESS", `🔄 Regenerated from disk: ${rebuilt} story pages rebuilt${updated > 0 ? `, ${updated} manifests updated` : ""}${errors > 0 ? `, ${errors} errors` : ""}`);
          sendResponse({ ok: true, rebuilt, updated, errors });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* ── v2.4: Active Database info panel ── */
    case "ACTIVE_DATABASE_INFO": {
      // Returns { linkedFolderName, folderPath, files[], lastUpdated } so the
      // Settings UI can show "📂 Active Database: .../Storypark Smart Saver/Database — 5 JSON files, last updated 2 min ago"
      getActiveDatabaseInfo()
        .then((info) => sendResponse({ ok: true, info }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    /* ── v2.4: Per-story audit + repair ── */
    case "AUDIT_STORIES": {
      // Classify every story manifest as:
      //   complete            — all approvedFilenames on disk + story.html on disk
      //   partial_photos      — some approvedFilenames missing from disk
      //   partial_assets      — photos OK but story.html / Story Card missing
      //   db_only             — no files on disk at all
      //   rejected_on_disk    — file(s) found in "{Child} Rejected Matches/" folder
      //   missing_video       — at least one video in mediaTypes is not on disk
      //
      // Accepts an optional pre-walked disk list from the dashboard so the SW
      // doesn't need FSA access.  Returns a summary + per-story classification.
      //
      // msg: {
      //   childId?: string
      //   onDiskPaths?: string[]            // Flat list of all files under linked folder
      //   rejectedFilesByChild?: Object     // { [childName]: { [folderName]: string[] } }
      // }
      (async () => {
        try {
          const { childId: targetChildId, onDiskPaths = [], rejectedFilesByChild = null } = msg;
          const onDiskSet = new Set(onDiskPaths);
          const INVALID_CHARS = /[/\\:*?"<>|]/g;
          const sanitize = (s) => (s || "Unknown").replace(INVALID_CHARS, "_").trim() || "Unknown";

          // ── Path prefix auto-detection ──────────────────────────────────────────
          // If the user linked the PARENT folder (not "Storypark Smart Saver" itself),
          // walkFolder returns paths like "Storypark Smart Saver/Hugo Hill/Stories/..."
          // If they linked the SSS folder directly, paths are "Hugo Hill/Stories/..."
          // Detect which mode by checking if any onDiskPath starts with our root folder.
          const _diskPathPrefix = onDiskPaths.length > 0 &&
            onDiskPaths.some(p => p.startsWith("Storypark Smart Saver/"))
            ? "Storypark Smart Saver/" : "";

          const allManifests = targetChildId
            ? await getDownloadedStories(targetChildId).catch(() => [])
            : await getAllDownloadedStories().catch(() => []);

          const stories = [];
          const summary = {
            total: 0,
            complete: 0,
            partial_photos: 0,
            partial_assets: 0,
            db_only: 0,
            rejected_on_disk: 0,
            missing_video: 0,
            missing_files: 0, // total count of missing individual files
          };

          for (const m of allManifests) {
            if (!m.storyId || !m.folderName) continue;
            const childSafe = sanitize(m.childName);
            const storyBase = `${_diskPathPrefix}${childSafe}/Stories/${m.folderName}`;
            const approved  = m.approvedFilenames || [];
            const rejectedM = m.rejectedFilenames || [];
            const mediaTypes = m.mediaTypes || {};

            const onDiskFiles   = [];
            const missingFiles  = [];
            const missingVideos = [];
            for (const f of approved) {
              const p = `${storyBase}/${f}`;
              if (onDiskSet.has(p)) {
                onDiskFiles.push(f);
              } else {
                missingFiles.push(f);
                if (mediaTypes[f] === "video") missingVideos.push(f);
              }
            }

            // story.html + Story Card presence (optional but expected when body exists)
            const storyHtmlName = m.storyHtmlFilename || "story.html";
            const storyCardName = m.storyCardFilename
              || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "");
            const hasStoryHtml = onDiskSet.has(`${storyBase}/${storyHtmlName}`);
            const hasStoryCard = storyCardName ? onDiskSet.has(`${storyBase}/${storyCardName}`) : true;

            // Rejected-on-disk check (from dashboard-supplied walk, if provided)
            let rejectedOnDisk = [];
            if (rejectedFilesByChild && rejectedFilesByChild[m.childName]?.[m.folderName]) {
              rejectedOnDisk = rejectedFilesByChild[m.childName][m.folderName];
            }

            let status;
            if (onDiskFiles.length === 0 && approved.length > 0) {
              status = "db_only";
              summary.db_only++;
            } else if (missingFiles.length > 0) {
              status = "partial_photos";
              summary.partial_photos++;
            } else if (!hasStoryHtml || !hasStoryCard) {
              status = "partial_assets";
              summary.partial_assets++;
            } else {
              status = "complete";
              summary.complete++;
            }

            if (rejectedOnDisk.length > 0) summary.rejected_on_disk++;
            if (missingVideos.length > 0) summary.missing_video++;
            summary.missing_files += missingFiles.length;
            summary.total++;

            stories.push({
              key: m.key || `${m.childId}_${m.storyId}`,
              childId: m.childId,
              childName: m.childName,
              storyId: m.storyId,
              storyDate: m.storyDate,
              storyTitle: m.storyTitle,
              folderName: m.folderName,
              status,
              totalFiles: approved.length,
              onDiskCount: onDiskFiles.length,
              missingFiles,
              missingVideos,
              hasStoryHtml,
              hasStoryCard,
              rejectedOnDisk,
              rejectedFilenamesCount: rejectedM.length,
            });
          }

          sendResponse({ ok: true, summary, stories });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "REPAIR_STORY": {
      // Re-download missing files for a single story manifest.
      // Order of resolution for each missing filename:
      //   1. storyCache (IDB)    — originalUrl lookup by filename
      //   2. manifest.mediaUrls — originalUrl lookup by filename
      //   3. apiFetch story     — LAST resort, refresh the story detail
      //
      // msg: {
      //   childId, storyId,
      //   onlyFilenames?: string[],   // v2.4: targeted repair — only these files
      //                                //   (from audit's missingFiles list); if omitted,
      //                                //   repairs every approved filename (legacy behaviour).
      //   regenerateAssets?: bool,    // v2.4: also regenerate story.html + Story Card
      //                                //   after files are restored (default: true).
      //   options?: { skipFaceRec?: bool }
      // }
      // Returns: { ok, downloaded, failed, skipped, missingUrls, assetsRegenerated }
      (async () => {
        try {
          const { childId, storyId, options = {}, onlyFilenames = null, regenerateAssets = true } = msg;
          if (!childId || !storyId) {
            sendResponse({ ok: false, error: "Missing childId or storyId." });
            return;
          }
          const { skipFaceRec: forceSkipFaceRec = true } = options; // default: bypass face rec for repairs
          await ensureOffscreen();

          // Load manifest
          const manifests = await getDownloadedStories(childId).catch(() => []);
          const manifest = manifests.find(m => String(m.storyId) === String(storyId));
          if (!manifest) {
            sendResponse({ ok: false, error: "Manifest not found." });
            return;
          }

          // Try the story cache for original URLs first (cheap)
          let storyUrls = new Map(); // filename -> originalUrl
          for (const mu of manifest.mediaUrls || []) {
            if (mu.filename && mu.originalUrl) storyUrls.set(mu.filename, mu.originalUrl);
          }
          // Fallback to cached full story record
          if (storyUrls.size === 0) {
            const cached = await getCachedStory(String(storyId)).catch(() => null);
            if (cached) {
              const mediaItems = cached.media || cached.media_items || cached.assets || [];
              for (const m of mediaItems) {
                const fn = m.file_name || m.filename || extractFilenameFromUrl(m.original_url || "");
                if (fn && m.original_url) storyUrls.set(fn, m.original_url);
              }
            }
          }

          // v2.4 targeted repair: honour onlyFilenames[] if supplied by the
          // audit — saves bandwidth by not re-downloading files already present
          // on disk. Fall back to "all approved (minus rejected)" when omitted.
          const rejectedSet = new Set(manifest.rejectedFilenames || []);
          const approvedSet = new Set(manifest.approvedFilenames || []);
          let filesToRepair;
          if (Array.isArray(onlyFilenames) && onlyFilenames.length > 0) {
            // Only repair files the audit flagged AND that are still approved+not-rejected
            filesToRepair = onlyFilenames.filter(f => approvedSet.has(f) && !rejectedSet.has(f));
          } else {
            filesToRepair = [...approvedSet].filter(f => !rejectedSet.has(f));
          }

          if (filesToRepair.length === 0) {
            sendResponse({ ok: true, downloaded: 0, failed: 0, skipped: 0, missingUrls: [], assetsRegenerated: false });
            return;
          }

          // LAST RESORT: If any filenames still lack URLs, hit the API once
          const needsRefresh = filesToRepair.some(f => !storyUrls.has(f));
          if (needsRefresh && !String(storyId).startsWith("recovered_")) {
            try {
              const detail = await apiFetch(`${STORYPARK_BASE}/api/v3/stories/${storyId}`);
              const story = detail.story || detail;
              await cacheStory(String(storyId), story).catch(() => {});
              const mediaItems = story.media || story.media_items || story.assets || [];
              for (const m of mediaItems) {
                const fn = m.file_name || m.filename || extractFilenameFromUrl(m.original_url || "");
                if (fn && m.original_url && !storyUrls.has(fn)) {
                  storyUrls.set(fn, m.original_url);
                }
              }
            } catch (apiErr) {
              await logger("WARNING", `[REPAIR_STORY] Story ${storyId} API refresh failed: ${apiErr.message}`);
            }
          }

          const storyBasePath = `Storypark Smart Saver/${sanitizeName(manifest.childName)}/Stories/${manifest.folderName}`;
          const gpsCoords = manifest.centreName
            ? await getCentreGPS(manifest.centreName).catch(() => null)
            : null;

          let downloaded = 0, failed = 0, skipped = 0;
          const missingUrls = [];

          for (const filename of filesToRepair) {
            const originalUrl = storyUrls.get(filename);
            if (!originalUrl) {
              skipped++;
              missingUrls.push(filename);
              continue;
            }
            const savePath = `${storyBasePath}/${filename}`;
            const mediaType = (manifest.mediaTypes || {})[filename]
              || (/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(filename) ? "video" : "image");

            try {
              if (mediaType === "video") {
                const vidResult = await sendToOffscreen({
                  type: "DOWNLOAD_VIDEO", videoUrl: originalUrl, savePath,
                });
                if (vidResult?.blobUrl && vidResult?.savePath) {
                  await downloadVideoFromOffscreen(vidResult);
                  downloaded++;
                  recordFileDownloaded({ filePath: savePath, childId, storyId: String(storyId), filename, fileType: "video" }).catch(() => {});
                } else {
                  failed++;
                }
              } else {
                // Image: route through DOWNLOAD_APPROVED for EXIF stamping
                const result = await sendToOffscreen({
                  type: "DOWNLOAD_APPROVED",
                  storyData: { storyId, createdAt: manifest.storyDate || "", body: manifest.storyBody || "",
                               roomName: manifest.roomName, centreName: manifest.centreName,
                               originalUrl, filename },
                  description: manifest.storyBody || "",
                  exifTitle:   `${(manifest.childName || "").split(/\s+/)[0]} - ${manifest.childAge || ""}`,
                  exifSubject: (manifest.excerpt || "").substring(0, 200),
                  exifComments: manifest.storyBody || "",
                  childName: manifest.childName,
                  savePath, gpsCoords,
                });
                if (result.dataUrl && result.savePath) {
                  await downloadDataUrl(result.dataUrl, result.savePath);
                  downloaded++;
                  recordFileDownloaded({ filePath: result.savePath, childId, storyId: String(storyId), filename, fileType: "image" }).catch(() => {});
                } else {
                  failed++;
                }
              }
            } catch (err) {
              console.warn(`[REPAIR_STORY] ${filename} failed:`, err.message);
              failed++;
            }
          }

          // v2.4: Regenerate story.html + Story Card for this story so the
          // user-visible HTML matches the restored file set. Skipped if the
          // caller disables it (e.g. a batch repair that regenerates indexes at the end).
          let assetsRegenerated = false;
          if (regenerateAssets && downloaded > 0) {
            try {
              const { saveStoryCard = true } = await chrome.storage.local.get("saveStoryCard");
              const approvedAfter = [...approvedSet].filter(f => !rejectedSet.has(f));
              const routineStr = _routineStr(manifest.storyRoutine);
              const storyBody  = manifest.storyBody || manifest.excerpt || "";
              const htmlContent = buildStoryHtml({
                title: manifest.storyTitle, date: manifest.storyDate,
                body: storyBody, childName: manifest.childName,
                childAge: manifest.childAge || "", roomName: manifest.roomName || "",
                centreName: manifest.centreName || "", educatorName: manifest.educatorName || "",
                routineText: routineStr, mediaFilenames: approvedAfter,
              });
              const htmlRes = await sendToOffscreen({
                type: "DOWNLOAD_TEXT", text: htmlContent,
                savePath: `${storyBasePath}/${manifest.storyHtmlFilename || "story.html"}`,
                mimeType: "text/html",
              });
              if (htmlRes.dataUrl && htmlRes.savePath) {
                await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
                assetsRegenerated = true;
              }
              if (saveStoryCard && storyBody && approvedAfter.length > 0) {
                const cardSavePath = `${storyBasePath}/${manifest.storyCardFilename || (manifest.storyDate ? `${manifest.storyDate} - Story Card.jpg` : "story - Story Card.jpg")}`;
                const photoCount = approvedAfter.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length;
                const cardResult = await sendToOffscreen({
                  type: "GENERATE_STORY_CARD",
                  title: manifest.storyTitle, date: manifest.storyDate, body: storyBody,
                  centreName: manifest.centreName || "", roomName: manifest.roomName || "",
                  educatorName: manifest.educatorName || "", childName: manifest.childName,
                  childAge: manifest.childAge || "", routineText: routineStr,
                  photoCount, gpsCoords, savePath: cardSavePath,
                });
                if (cardResult.ok && cardResult.dataUrl) {
                  await downloadDataUrl(cardResult.dataUrl, cardSavePath);
                }
              }
            } catch (regenErr) {
              console.warn(`[REPAIR_STORY] asset regen for ${storyId} failed:`, regenErr.message);
            }
          }

          await logger("SUCCESS", `🛠 Repaired story ${storyId}: ${downloaded} files restored${failed > 0 ? `, ${failed} failed` : ""}${missingUrls.length > 0 ? `, ${missingUrls.length} skipped (no URL)` : ""}${assetsRegenerated ? " + story.html regenerated" : ""}`);
          sendResponse({ ok: true, downloaded, failed, skipped, missingUrls, assetsRegenerated });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* ── v2.4 AUDIT + REPAIR combined pipeline with rate-limiting + progress ── */
    case "AUDIT_AND_REPAIR": {
      // Full audit-then-repair pipeline that:
      //   1. Classifies every story against the supplied disk snapshot
      //   2. For broken stories (db_only / partial_photos): re-downloads missing
      //      files using smartDelay + cancelRequested (same anti-abuse as scans)
      //   3. After repair: re-classifies using original disk state + newly
      //      downloaded paths so the result is accurate without re-walking disk
      //   4. Regenerates HTML + Story Cards for any story that gained new files
      //
      // Routes through the existing scan-bar / global-stop infrastructure:
      //   • sets isScanning = true → disables scan buttons, shows global banner
      //   • broadcasts PROGRESS messages → fills scan progress bar
      //   • checks cancelRequested each story → Stop button works
      //   • broadcasts SCAN_COMPLETE when done → banner hides
      //   • all progress lines written to Activity Log via logger()
      //
      // msg: {
      //   onDiskPaths: string[],               // pre-walked by dashboard (FSA)
      //   rejectedFilesByChild?: Object,        // { [childName]: { [folderName]: string[] } }
      //   repairPartialAssets?: bool,           // default false — only repair missing PHOTOS
      // }
      if (isScanning) {
        sendResponse({ ok: false, error: "A scan or repair is already in progress." });
        return false;
      }
      isScanning      = true;
      cancelRequested = false;
      chrome.storage.session.set({ isScanning: true, cancelRequested: false, _requestCount: 0 }).catch(() => {});

      sendResponse({ ok: true, started: true }); // acknowledge immediately; results come via SCAN_COMPLETE

      (async () => {
        const loopStart = Date.now();
        let totalDownloaded = 0, totalFailed = 0, totalSkipped = 0;
        try {
          const {
            onDiskPaths = [],
            rejectedFilesByChild = null,
            repairPartialAssets = false,
          } = msg;

          await ensureOffscreen();
          const { saveStoryCard = true } = await chrome.storage.local.get("saveStoryCard");

          const INVALID_CHARS = /[/\\:*?"<>|]/g;
          const _san = (s) => (s || "Unknown").replace(INVALID_CHARS, "_").trim() || "Unknown";
          const onDiskSet = new Set(onDiskPaths);

          // ── Path prefix auto-detection (same logic as AUDIT_STORIES) ──────────────
          // If parent folder is linked, paths are "Storypark Smart Saver/ChildName/..."
          // If SSS folder itself is linked, paths are "ChildName/..."
          const _aarPathPrefix = onDiskPaths.length > 0 &&
            onDiskPaths.some(p => p.startsWith("Storypark Smart Saver/"))
            ? "Storypark Smart Saver/" : "";

          // ── PHASE 1: Audit (classify all stories) ────────────────────────
          await logger("INFO", `🔍 Audit started — classifying ${onDiskPaths.length} files on disk vs manifests…`);
          chrome.runtime.sendMessage({ type: "PROGRESS", current: 0, total: 100, childName: "Auditing…", childIndex: 0, childCount: 1, eta: "" }).catch(() => {});

          const allManifests = await getAllDownloadedStories().catch(() => []);
          const brokenStories = []; // { manifest, missingFiles, needsAssets }
          let complete = 0, partialPhotos = 0, dbOnly = 0, partialAssets = 0, totalMissing = 0;

          for (const m of allManifests) {
            if (!m.storyId || !m.folderName) continue;
            const childSafe = _san(m.childName);
            const base      = `${_aarPathPrefix}${childSafe}/Stories/${m.folderName}`;
            const approved  = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
            const missingFiles = approved.filter(f => !onDiskSet.has(`${base}/${f}`));
            const htmlName  = m.storyHtmlFilename || "story.html";
            const cardName  = m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "");
            const hasHtml   = onDiskSet.has(`${base}/${htmlName}`);
            const hasCard   = !cardName || onDiskSet.has(`${base}/${cardName}`);
            const needsAssets = !hasHtml || !hasCard;

            if (approved.length === 0) continue; // nothing expected on disk
            if (missingFiles.length === approved.length) { dbOnly++; totalMissing += missingFiles.length; brokenStories.push({ manifest: m, missingFiles, needsAssets: true }); }
            else if (missingFiles.length > 0) { partialPhotos++; totalMissing += missingFiles.length; brokenStories.push({ manifest: m, missingFiles, needsAssets: true }); }
            else if (needsAssets && repairPartialAssets) { partialAssets++; brokenStories.push({ manifest: m, missingFiles: [], needsAssets: true }); }
            else if (needsAssets) { partialAssets++; }
            else { complete++; }
          }

          const totalStories = allManifests.length;
          await logger("INFO",
            `📊 Audit complete — ${totalStories} stories: ✅ ${complete} complete · 📷 ${partialPhotos} missing photos · 💾 ${dbOnly} DB-only · 📄 ${partialAssets} missing HTML/Card · ⚠ ${totalMissing} files to restore`
          );

          if (brokenStories.length === 0) {
            await logger("SUCCESS", "✅ Everything looks good — no files need repairing!");
            chrome.runtime.sendMessage({ type: "AUDIT_REPAIR_DONE", summary: { complete, partialPhotos, dbOnly, partialAssets, totalMissing, repaired: 0, failed: 0 } }).catch(() => {});
            return;
          }

          await logger("INFO", `🛠 Starting repair for ${brokenStories.length} stories (${totalMissing} files)…`);

          // ── PHASE 2: Repair broken stories ────────────────────────────────
          // Track newly downloaded paths so we can re-audit without re-walking disk
          const newlyDownloaded = new Set();
          const _total = brokenStories.length;

          for (let si = 0; si < _total; si++) {
            if (cancelRequested) {
              await logger("WARNING", `⏸ Repair cancelled after ${si} of ${_total} stories.`);
              break;
            }

            const { manifest: m, missingFiles, needsAssets } = brokenStories[si];
            const storyBase     = `${_san(m.childName)}/Stories/${m.folderName}`;
            const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;

            // Progress bar
            const elapsed = Date.now() - loopStart;
            const avgMs   = si > 0 ? elapsed / si : 0;
            const eta     = (si >= 2 && avgMs > 0) ? formatETA(avgMs * (_total - si)) : "";
            chrome.runtime.sendMessage({
              type: "PROGRESS",
              current: si + 1,
              total: _total,
              date: m.storyDate ? formatDateDMY(m.storyDate) : "",
              childName: `Repairing ${m.childName || ""}`,
              eta,
              childIndex: 0, childCount: 1,
            }).catch(() => {});

            // Build URL map for this story
            const storyUrls = new Map();
            for (const mu of m.mediaUrls || []) {
              if (mu.filename && mu.originalUrl) storyUrls.set(mu.filename, mu.originalUrl);
            }
            // Fallback: cached story
            if (storyUrls.size === 0 || missingFiles.some(f => !storyUrls.has(f))) {
              const cached = await getCachedStory(String(m.storyId)).catch(() => null);
              if (cached) {
                for (const item of (cached.media || cached.media_items || cached.assets || [])) {
                  const fn = item.file_name || item.filename || extractFilenameFromUrl(item.original_url || "");
                  if (fn && item.original_url && !storyUrls.has(fn)) storyUrls.set(fn, item.original_url);
                }
              }
            }
            // Last resort: live API fetch (with rate-limit awareness)
            const needsApiRefresh = missingFiles.length > 0 && missingFiles.some(f => !storyUrls.has(f))
              && !String(m.storyId).startsWith("recovered_");
            if (needsApiRefresh) {
              try {
                await smartDelay("READ_STORY"); // respect rate limiting on API call
                const detail = await apiFetch(`${STORYPARK_BASE}/api/v3/stories/${m.storyId}`);
                const story  = detail.story || detail;
                await cacheStory(String(m.storyId), story).catch(() => {});
                for (const item of (story.media || story.media_items || story.assets || [])) {
                  const fn = item.file_name || item.filename || extractFilenameFromUrl(item.original_url || "");
                  if (fn && item.original_url && !storyUrls.has(fn)) storyUrls.set(fn, item.original_url);
                }
              } catch (apiErr) {
                if (apiErr.name === "AuthError") { await logger("ERROR", `🛑 Auth error — check Storypark login.`); cancelRequested = true; break; }
                if (apiErr.name === "RateLimitError") { await logger("WARNING", `⏳ Rate limited — pausing…`); await new Promise(r => setTimeout(r, 30000)); }
                else await logger("WARNING", `⚠ Story ${m.storyId} API fetch failed: ${apiErr.message}`);
              }
            }

            // Download each missing file
            let storyDownloaded = 0;
            const gpsCoords = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;

            for (const filename of missingFiles) {
              if (cancelRequested) break;
              const originalUrl = storyUrls.get(filename);
              if (!originalUrl) {
                await logger("WARNING", `⚠ No URL for: ${filename} (story ${m.storyId}) — needs a fresh scan`);
                totalSkipped++;
                continue;
              }
              const savePath = `${storyBasePath}/${filename}`;
              const isVideo  = (m.mediaTypes || {})[filename] === "video"
                || /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(filename);
              try {
                await smartDelay("DOWNLOAD_MEDIA");
                if (isVideo) {
                  const vr = await sendToOffscreen({ type: "DOWNLOAD_VIDEO", videoUrl: originalUrl, savePath });
                  if (vr?.blobUrl) { await downloadVideoFromOffscreen(vr); storyDownloaded++; totalDownloaded++; newlyDownloaded.add(`${storyBase}/${filename}`); }
                  else { totalFailed++; }
                } else {
                  const ir = await sendToOffscreen({
                    type: "DOWNLOAD_APPROVED",
                    storyData: { storyId: m.storyId, createdAt: m.storyDate || "", originalUrl, filename },
                    description: m.storyBody || "", exifTitle: `${(m.childName || "").split(/\s+/)[0]} - ${m.childAge || ""}`,
                    exifSubject: (m.excerpt || "").substring(0, 200), exifComments: m.storyBody || "",
                    childName: m.childName, savePath, gpsCoords,
                  });
                  if (ir?.dataUrl && ir?.savePath) {
                    await downloadDataUrl(ir.dataUrl, ir.savePath);
                    storyDownloaded++; totalDownloaded++;
                    newlyDownloaded.add(`${storyBase}/${filename}`);
                  } else { totalFailed++; }
                }
              } catch (dlErr) {
                const isExpired = dlErr.message.includes("403") || dlErr.message.includes("404");
                await logger(isExpired ? "WARNING" : "WARNING",
                  `⚠ ${filename}: ${isExpired ? "URL expired — run a fresh scan to get new URL" : dlErr.message}`
                );
                totalFailed++;
              }
            }

            // Regenerate HTML + Card if we downloaded anything for this story
            if ((storyDownloaded > 0 || (needsAssets && missingFiles.length === 0)) && !cancelRequested) {
              try {
                const approvedAfter = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
                const routineStr    = typeof m.storyRoutine === "string" ? m.storyRoutine : (m.storyRoutine?.detailed || m.storyRoutine?.summary || "");
                const storyBody     = m.storyBody || m.excerpt || "";
                const htmlContent   = buildStoryHtml({
                  title: m.storyTitle, date: m.storyDate, body: storyBody,
                  childName: m.childName, childAge: m.childAge || "",
                  roomName: m.roomName || "", centreName: m.centreName || "",
                  educatorName: m.educatorName || "", routineText: routineStr,
                  mediaFilenames: approvedAfter,
                });
                const htmlRes = await sendToOffscreen({
                  type: "DOWNLOAD_TEXT", text: htmlContent,
                  savePath: `${storyBasePath}/${m.storyHtmlFilename || "story.html"}`,
                  mimeType: "text/html",
                });
                if (htmlRes.dataUrl && htmlRes.savePath) {
                  await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
                  newlyDownloaded.add(`${storyBase}/${m.storyHtmlFilename || "story.html"}`);
                }
                if (saveStoryCard && storyBody && approvedAfter.length > 0) {
                  const cardName = m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "story - Story Card.jpg");
                  const cr = await sendToOffscreen({
                    type: "GENERATE_STORY_CARD",
                    title: m.storyTitle, date: m.storyDate, body: storyBody,
                    centreName: m.centreName || "", roomName: m.roomName || "",
                    educatorName: m.educatorName || "", childName: m.childName,
                    childAge: m.childAge || "", routineText: routineStr,
                    photoCount: approvedAfter.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length,
                    gpsCoords, savePath: `${storyBasePath}/${cardName}`,
                  });
                  if (cr.ok && cr.dataUrl) {
                    await downloadDataUrl(cr.dataUrl, `${storyBasePath}/${cardName}`);
                    newlyDownloaded.add(`${storyBase}/${cardName}`);
                  }
                }
              } catch (regenErr) {
                console.warn(`[AUDIT_AND_REPAIR] HTML regen failed for ${m.storyId}:`, regenErr.message);
              }
            }

            await idleYield(50); // GC between stories
          }

          // Rebuild index pages
          if (totalDownloaded > 0 && !cancelRequested) {
            const { children = [] } = await chrome.storage.local.get("children");
            await _rebuildIndexPages(children).catch(() => {});
          }

          // ── PHASE 3: Re-audit with synthetic post-repair disk state ────────
          const postRepairDiskSet = new Set([...onDiskSet, ...newlyDownloaded]);
          let reComplete = 0, rePartialPhotos = 0, reDbOnly = 0, rePartialAssets = 0, reMissing = 0;
          for (const m of allManifests) {
            if (!m.storyId || !m.folderName) continue;
            const base     = `${_aarPathPrefix}${_san(m.childName)}/Stories/${m.folderName}`;
            const approved = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
            const missing  = approved.filter(f => !postRepairDiskSet.has(`${base}/${f}`));
            const htmlName = m.storyHtmlFilename || "story.html";
            const cardName = m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "");
            if (approved.length === 0) continue;
            if (missing.length === approved.length) { reDbOnly++; reMissing += missing.length; }
            else if (missing.length > 0) { rePartialPhotos++; reMissing += missing.length; }
            else if (!postRepairDiskSet.has(`${base}/${htmlName}`) || (cardName && !postRepairDiskSet.has(`${base}/${cardName}`))) { rePartialAssets++; }
            else { reComplete++; }
          }

          const summary = `🛠 Repair complete — ${totalDownloaded} restored, ${totalFailed} failed${totalSkipped > 0 ? `, ${totalSkipped} need fresh scan (expired URLs)` : ""}`;
          await logger("SUCCESS", summary);
          await logger("INFO",
            `📊 Post-repair: ✅ ${reComplete} complete · 📷 ${rePartialPhotos} partial · 💾 ${reDbOnly} DB-only · 📄 ${rePartialAssets} HTML/Card only · ⚠ ${reMissing} still missing`
          );

          chrome.runtime.sendMessage({
            type: "AUDIT_REPAIR_DONE",
            summary: {
              complete: reComplete, partialPhotos: rePartialPhotos, dbOnly: reDbOnly,
              partialAssets: rePartialAssets, totalMissing: reMissing,
              repaired: totalDownloaded, failed: totalFailed, skipped: totalSkipped,
            },
          }).catch(() => {});

        } finally {
          isScanning      = false;
          cancelRequested = false;
          chrome.storage.session.set({ isScanning: false, cancelRequested: false, _requestCount: 0 }).catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        }
      })();

      return true; // sendResponse already called above
    }

    /* ── v2.4: Rebuild rejections.json from Rejected Matches/ folders ── */
    case "REBUILD_REJECTIONS_FROM_FOLDERS": {

      // msg: { rejectedFilesByChild: { [childName]: { [folderName]: string[] } } }
      (async () => {
        try {
          const manifests = await getAllDownloadedStories().catch(() => []);
          const added = await rebuildRejectionsFromFolders(
            manifests,
            msg.rejectedFilesByChild || {}
          );
          await logger("SUCCESS", `🔄 Rebuilt rejections ledger from Rejected Matches/ folders — ${added} entries added.`);
          sendResponse({ ok: true, added });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* ── v2.4: Generate Story Cards for every story (Settings UI button) ── */
    case "GENERATE_STORY_CARDS_ALL": {
      // Like BUILD_HTML_STRUCTURE but only regenerates the Story Card JPEGs.
      // Honours `rejectedFilenames` so the card's photo count is accurate.
      // msg: { childId?: string }
      (async () => {
        try {
          await ensureOffscreen();
          const { children = [] } = await chrome.storage.local.get("children");
          const targetChildId = msg.childId ? String(msg.childId) : null;
          const relevantChildren = targetChildId
            ? children.filter(c => String(c.id) === String(targetChildId))
            : children;

          let generated = 0, skipped = 0, errors = 0;
          for (const child of relevantChildren) {
            const manifests = await getDownloadedStories(child.id).catch(() => []);
            for (const m of manifests) {
              try {
                const storyBody = m.storyBody || m.excerpt || "";
                const approvedOnly = (m.approvedFilenames || []).filter(
                  f => !(m.rejectedFilenames || []).includes(f)
                );
                if (!storyBody || approvedOnly.length === 0) { skipped++; continue; }
                const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;
                const gpsCoords = m.centreName
                  ? await getCentreGPS(m.centreName).catch(() => null)
                  : null;
                const cardSavePath = `${storyBasePath}/${m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "story - Story Card.jpg")}`;
                const photoCount = approvedOnly.filter(
                  f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)
                ).length;
                const cardResult = await sendToOffscreen({
                  type: "GENERATE_STORY_CARD",
                  title: m.storyTitle, date: m.storyDate, body: storyBody,
                  centreName: m.centreName || "", roomName: m.roomName || "",
                  educatorName: m.educatorName || "", childName: m.childName,
                  childAge: m.childAge || "", routineText: m.storyRoutine || "",
                  photoCount, gpsCoords, savePath: cardSavePath,
                });
                if (cardResult.ok && cardResult.dataUrl) {
                  await downloadDataUrl(cardResult.dataUrl, cardSavePath);
                  generated++;
                }
              } catch (e) {
                console.warn(`[GENERATE_STORY_CARDS_ALL] Story ${m.storyId} failed:`, e.message);
                errors++;
              }
              // Yield periodically for GC
              if ((generated + skipped + errors) % 20 === 0) await idleYield(30);
            }
          }
          await logger("SUCCESS", `🎴 Story Cards generated: ${generated}${skipped > 0 ? `, skipped: ${skipped}` : ""}${errors > 0 ? `, errors: ${errors}` : ""}`);
          sendResponse({ ok: true, generated, skipped, errors });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    default:
      return false;
  }
});

/* ================================================================== */
/*  Startup – load children into cache                                 */
/* ================================================================== */


/**
 * Eager-load the hot file caches (manifests.json + rejections.json + descriptors etc.)
 * so the first REVIEW_APPROVE / scan / dashboard query doesn't block on disk I/O.
 * Called on both onInstalled and onStartup, and also runs inline once per
 * service-worker activation (MV3 wakes the SW lazily — neither event may fire).
 */
async function _eagerLoadOnStartup() {
  try {
    const counts = await eagerLoadHotCaches();
    const summary = `📂 Database loaded: ${counts.manifests} manifests · ${counts.rejections} rejections · ${counts.descriptors} descriptor records · ${counts.fingerprints} fingerprints`;
    console.log("[startup] " + summary);
    // Log only when there's something worth reporting — avoids noisy "0 …" line
    // in the Activity Log on first install.
    if (counts.manifests > 0 || counts.rejections > 0 || counts.descriptors > 0) {
      logger("INFO", summary).catch(() => {});
    }
  } catch (err) {
    console.warn("[startup] eager load failed (non-fatal):", err?.message || err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loadAndCacheProfile();
  _eagerLoadOnStartup();
  // Migrate existing centreLocations from chrome.storage to IDB centreProfiles (v11).
  // Runs once on install/update — non-destructive (saveCentreProfile does not overwrite GPS).
  chrome.storage.local.get("centreLocations", ({ centreLocations }) => {
    if (centreLocations && Object.keys(centreLocations).length > 0) {
      importLegacyCentreLocations(centreLocations).catch(() => {});
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadAndCacheProfile();
  _eagerLoadOnStartup();
  // Ensure centreLocations are mirrored to IDB on every startup (catches any
  // GPS updates made via chrome.storage since last session).
  chrome.storage.local.get("centreLocations", ({ centreLocations }) => {
    if (centreLocations && Object.keys(centreLocations).length > 0) {
      importLegacyCentreLocations(centreLocations).catch(() => {});
    }
  });
});

// MV3 service workers may start without onInstalled/onStartup firing (lazy wake
// triggered by a message). Always prime the hot caches on module load too.
_eagerLoadOnStartup();


/* ================================================================== */
/*  Extension icon click → open / focus dashboard                      */
/* ================================================================== */

chrome.action.onClicked.addListener(async () => {
  const dashUrl = chrome.runtime.getURL("dashboard.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(dashUrl));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: dashUrl });
  }
});
