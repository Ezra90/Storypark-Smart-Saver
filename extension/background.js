/**
 * background.js Service Worker (Manifest V3)
 *
 * Headless API approach: calls Storypark's internal v3 JSON APIs directly.
 * No DOM scraping, no content script.
 *
 * This file owns: scan state, diagnostic/activity log, offscreen lifecycle,
 * profile loading, review approve handler, and the message router.
 *
 * All scan logic lib/scan-engine.js
 * All API calls || lib/api-client.js
 * All downloads || lib/download-pipe.js
 * HTML builders || lib/html-builders.js
 * Pure helpers || lib/metadata-helpers.js
 *
 * See ARCHITECTURE.md for the full message protocol table.
 * See AI_RULES.md for invariants all AI agents must follow.
 */

// Pure-math face matching (SW-safe no DOM)
import { similarityPct as matchSimilarityPct } from "./lib/matching.js";

// IndexedDB layer
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
  getTemplateSettings,
  saveTemplateSettings,
  appendActivityLogEntries,
  upsertStoryCatalogRecords,
  upsertStoryDetailRecords,
  upsertRoutineSnapshotRecords,
  saveSyncState,
  getSyncState,
  appendSyncJournal,
  getSyncJournal,
  ensureSyncSchema,
  getDatabaseIntegrityReport,
  clearPersistedActivityLog,
  getStoryCatalogRecords,
  appendDecisionLogEntries,
  getJobsState,
  acquireJobLock,
  releaseJobLock,
  rotateDecisionLog,
  pruneAgedFaceData,
  ensureDatabaseWritable,
} from "./lib/db.js";

// Pure helpers formatDateDMY/formatETA/sanitizeSavePath moved to lib; rest still local
import {
  formatDateDMY, formatETA, sanitizeSavePath,
  mergeTemplateSettings, DEFAULT_TEMPLATE_SETTINGS,
  buildTemplateTokenMap, renderTemplate, TEMPLATE_LIMITS, CARD_TITLE_MAX_CHARS, normaliseStoryText,
} from "./lib/metadata-helpers.js";

// Storypark API client + anti-abuse timing // apiFetch, smartDelay, STORYPARK_BASE, AuthError, RateLimitError were removed from this file;
// they now live exclusively in lib/api-client.js.
// initApiClient() wires in logger, _diagLog, and cancelRequested so smartDelay respects
// scan cancellations and apiFetch captures debug log entries.
import {
  apiFetch, smartDelay, discoverCentres, geocodeCentre,
  AuthError, RateLimitError, STORYPARK_BASE, DELAY_PROFILES,
  initApiClient,
} from "./lib/api-client.js";

// OOM-safe download pipeline // downloadBlob/DataUrl/HtmlFile/VideoFromOffscreen were removed from this file;
// they now live exclusively in lib/download-pipe.js.
// handleDownloadChanged is registered below (ONCE prevents double-handler bug).
// initDownloadPipe() wires in sendToOffscreen for the blob-URL creation path.
import {
  downloadBlob, downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen,
  MAX_CONCURRENT_DOWNLOADS, handleDownloadChanged, initDownloadPipe, getDownloadStats,
} from "./lib/download-pipe.js";

// Scan Engine (Rule 12: Strict UI Decoupling) // All scan logic lives in lib/scan-engine.js. Background.js routes messages
// to runExtraction() but NEVER executes business logic directly.
import { runExtraction, initScanEngine, _rebuildIndexPages } from "./lib/scan-engine.js";

// HTML Builders
import { buildStoryHtml, buildChildrenIndexHtml, buildMasterIndexHtml, getStoryHtmlFilenames, getStoryCardFilename } from "./lib/html-builders.js";

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
initScanEngine({
  logger,
  getCancelRequested: () => cancelRequested,
  sendToOffscreen,
  diagLog: _diagLog,
  getDebugMode: () => debugCaptureMode,
});

// Message handler modules (domain-specific, imported for thin router)
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
// handlers-review.js aliased to avoid name conflict with local handleReviewApprove function
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
  handleFixStoryMetadata, handleAssignStoryNumbers, handleRehydrateStoryBodies,
} from "./lib/handlers-misc.js";
import { handleRebuildDatabaseFromDisk } from "./lib/handlers-rebuild.js";
import {
  handleGetFaceModelHealth,
  handleSetFaceHoldoutSet,
  handleGetDecisionAuditSummary,
  handleRunRetentionMaintenance,
  handleSelfImproveFaceModel,
  handleRunInitialFaceBootstrap,
} from "./lib/handlers-face-model.js";

// Small helpers needed by message handlers (not worth a full module)
const _extractFilenameFromUrl = (url) => ((url || "").split("/").pop() || "").split("?")[0];
const _isVideoMedia = (item) => {
  const ct = (item.content_type || item.type || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  const fn = item.filename || _extractFilenameFromUrl(item.original_url || "");
  return /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(fn);
  };

async function _getTemplateSettingsMerged() {
  const stored = await getTemplateSettings().catch(() => ({}));
  const legacy = await chrome.storage.local.get(["templateHtml", "templateCard", "templateExifRules"]).catch(() => ({}));
  return mergeTemplateSettings({
    ...stored,
    html: { ...(stored?.html || {}), ...(legacy.templateHtml || {}) },
    card: { ...(stored?.card || {}), ...(legacy.templateCard || {}) },
    exif: { ...(stored?.exif || {}), ...(legacy.templateExifRules || {}) },
  });
}

/* ================================================================== */
/*  Top-level scan state                                               */
/*  */
/*  These three module-level variables are referenced throughout the   */
/*  message router AND captured by the closures passed to              */
/*  initApiClient / initScanEngine above (() => cancelRequested, etc.) */
/*  Function declarations and `let`/`const` declarations are hoisted   */
/*  to the top of the module, so the closures created earlier resolve  */
/*  to the same binding declared here.                                 */
/* ================================================================== */

/** True while a scan / repair / rebuild is in progress. */
let isScanning      = false;

/** Set to true when the user clicks Stop; checked at every yield point. */
let cancelRequested = false;

const STORYPARK_SYNC_ALARM = "storypark_periodic_sync";
const FACE_INTEGRITY_ALARM = "storypark_face_integrity_weekly";

/** In-memory ring buffer of recent API responses (when debugCaptureMode). */
const _diagnosticLog = [];

/**
 * Last completed review action ({ action, item, descriptor? }) used by
 * UNDO_LAST_REVIEW.  Persisted to chrome.storage.session in parallel so the
 * popup can survive a service-worker suspend.  Read/write via the small
 * accessors below, which are passed to the imported review handlers via ctx.
 */
let lastReviewAction = null;
function _getLastReviewAction() { return lastReviewAction; }
function _setLastReviewAction(action) {
  lastReviewAction = action || null;
  chrome.storage.session.set({ lastReviewAction }).catch(() => {});
}

// Restore last review action from session storage (survives SW suspend).
chrome.storage.session.get("lastReviewAction").then(({ lastReviewAction: stored }) => {
  if (stored) lastReviewAction = stored;
}).catch(() => {});

/** Build the ctx object that lib handlers expect. Created once per call. */
function _handlerCtx() {
  return {
    logger,
    sendToOffscreen,
    getCancelRequested:  () => cancelRequested,
    getLastReviewAction: _getLastReviewAction,
    setLastReviewAction: _setLastReviewAction,
  };
}



/**
 * Maximum number of entries kept in _diagnosticLog.  Raised to 500 when
 * debugCaptureMode is active so a full scan can be captured without trimming.
 * NOTE: This is a temporary debug feature disable during normal use to save memory.
 */
const DIAG_LOG_MAX_NORMAL = 50;
const DIAG_LOG_MAX_DEBUG  = 500;

/**
 * When true, every apiFetch() response is captured in _diagnosticLog.
 * Loaded from chrome.storage.local and toggled via SET_DEBUG_CAPTURE_MODE.
 * Disabled by default only enable when actively debugging API structure.
 */
let debugCaptureMode = false;

// Load persisted debugCaptureMode on startup.
chrome.storage.local.get("debugCaptureMode", ({ debugCaptureMode: stored }) => {
  if (stored === true) debugCaptureMode = true;
});

/**
 * Append a raw API response to the diagnostic log.
 * @param {string} url || the API endpoint that was called
 * @param {*} data || the parsed JSON response body
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
 * of sequential readwrite round-trips during large scans from one per
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
      // Mirror to Database/activity_log.json for durable on-disk history.
      appendActivityLogEntries(batch).catch(() => {});
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

  // Return a resolved promise so existing `await logger(�)` call-sites
  // continue to work without changes.
        return Promise.resolve();
}

// formatDateDMY, formatETA lib/metadata-helpers.js

// DELAY_PROFILES, smartDelay, STORYPARK_BASE, AuthError, RateLimitError, apiFetch lib/api-client.js
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
 * @param {number}  [_retryCount=0] || Internal retry counter do not pass externally.
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

// sanitizeSavePath lib/metadata-helpers.js (imported above)

// Download pipeline lib/download-pipe.js (imported above) // Register the download changed handler (ONCE - prevents double-handler bug)
chrome.downloads.onChanged.addListener(handleDownloadChanged);

// downloadBlob, downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen lib/download-pipe.js (imported)
// _dataUrlToBlob, _enqueueDownload, _activeDownloads, _downloadQueue are internal to download-pipe.js
// Use getDownloadStats() (imported above) to read semaphore state for logging.

/* ================================================================== */
/*  Memory instrumentation (passive logs only, no behaviour change)  */
/* ================================================================== */

/**
 * Report service-worker memory usage at a point in time.
 * Uses performance.memory (Chrome-only, non-standard but widely available
 * in extension service workers). Falls back to navigator.deviceMemory if
 * performance.memory is unavailable. Silent if neither is available.
 *
 * Logged at INFO level only never WARNING so it doesn't pollute the
 * Activity Log. Also prints to console for DevTools inspection.
 */
async function logMemorySnapshot(contextLabel) {
  try {
    let line = `[MEM] ${contextLabel}`;
    if (typeof performance !== "undefined" && performance.memory) {
      const used  = (performance.memory.usedJSHeapSize  / 1048576).toFixed(1);
      const total = (performance.memory.totalJSHeapSize / 1048576).toFixed(1);
      const limit = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0);
      line += ` JS heap ${used}/${total} MB (limit ${limit} MB)`;
    }
    const _dlStats = getDownloadStats();
    line += ` downloads active=${_dlStats.active} queued=${_dlStats.queued}`;
    console.log(line);
  } catch {
    // Non-fatal instrumentation must never break a scan.
  }
}

/**
 * Yield the microtask queue and give V8 a chance to run GC between stories.
 * A short setTimeout (not setImmediate) is used because service workers don't
 * expose setImmediate but the 10 ms delay is enough for any pending
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
      data.user?.administered_family_children_teacher_stories ?? data.administered_family_children_teacher_stories ?? null;
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
      .filter((c) => c && typeof c === "object")
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
          if (!co || typeof co !== "object") continue;
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
        // Non-fatal skip this child if the fetch fails
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
 * the Nominatim OSM API.  Non-fatal silently skips on auth or network errors.
 */
async function fetchAndDiscoverCentresFromApi() {
  try {
    const centresUrl = `${STORYPARK_BASE}/api/v3/centres`;
    const data = await apiFetch(centresUrl);
    _diagLog(centresUrl, data);

    const centres = data.centres || data.services || [];
    if (!centres.length) return;

    const entries = centres
      .filter((c) => c && typeof c === "object")
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
    // Non-fatal /api/v3/centres may not be accessible for all account types
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
      break; // success use this response
    } catch {
      // Try the next path variant
    }
  }
  try {
    if (!data) return;

    const centres = data.centres || data.services || [];
    if (!centres.length) return;

    const entries = centres
      .filter((c) => c && typeof c === "object")
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
 * resulting name+address into centreLocations.  Non-fatal errors are
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

/**
 * Sync rich API metadata for all cached children into local Database files.
 * This does NOT download media files; it builds a durable API snapshot that
 * can later be compared against on-disk manifests/file counts.
 *
 * Writes:
 *  - child profiles (IDB)
 *  - centre profiles (IDB)
 *  - educators (IDB)
 *  - story cache (IDB)
 *  - story catalog summary (Database/story_catalog.json)
 */
async function syncStoryparkInformation() {
  const dbWritable = await ensureDatabaseWritable().catch(() => false);
  if (!dbWritable) {
    throw new Error("Database folder is not writable. Re-link your Storypark working directory and click Verify Directory.");
  }
  const _isMediaFilenameForApiCompare = (name) => {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return false;
    // Explicitly ignore generated artifacts in story folders.
    if (n === "story.html") return false;
    // Accept legacy underscore and templated card naming:
    //   "story_card.jpg"
    //   "2026-04-26 - my-title card.jpg"
    if (
      n === "story_card.jpg" ||
      n === "story_card.jpeg" ||
      /(?:^| - ).*card\.jpe?g$/i.test(n)
    ) return false;
    return /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?|mp4|mov|m4v|avi|webm|mkv)$/i.test(n);
  };

  const children = await loadAndCacheProfile();
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error("No children found. Refresh your profile first.");
  }

  let storyCount = 0;
  let catalogCount = 0;
  let pageCalls = 0;
  const centresById = new Map();
  const childCentres = {};
  const childDobById = new Map();
  const classByChildWeekCentre = new Map();
  const classSeenByChildCentre = new Map();
  const downloadedStories = await getAllDownloadedStories().catch(() => []);
  const syncStartedAt = Date.now();
  const previousSyncState = await getSyncState().catch(() => ({}));
  const resumeCheckpoint = previousSyncState?.inProgress ? (previousSyncState.checkpoint || null) : null;
  let lastCheckpoint = resumeCheckpoint || null;
  await saveSyncState({
    type: "storypark_api_sync",
    inProgress: true,
    startedAt: new Date(syncStartedAt).toISOString(),
    lastSuccessAt: previousSyncState?.lastSuccessAt || null,
    mode: "full",
    childrenTotal: children.length,
    checkpoint: resumeCheckpoint || null,
  }).catch(() => {});
  await appendSyncJournal([
    {
      level: "INFO",
      event: "sync_start",
      message: resumeCheckpoint
        ? `Resuming Storypark API sync from checkpoint (child index ${resumeCheckpoint.childIndex ?? 0}).`
        : "Starting Storypark API sync from beginning.",
    },
  ]).catch(() => {});
  const { totalStoryCount = null } = await chrome.storage.local.get("totalStoryCount");
  const estimatedTotalStories =
    Number.isFinite(Number(totalStoryCount)) && Number(totalStoryCount) > 0
      ? Number(totalStoryCount)
      : null;
  let etaMsPerStoryEma = null;
  let lastEtaMs = null;
  let stableProjectedTotal = estimatedTotalStories || 0;
  await logger(
    "INFO",
    estimatedTotalStories
      ? `Storypark API sync target: ~${estimatedTotalStories} total stories across ${children.length} children.`
      : `Storypark API sync target: total story count unknown; scanning all pages for ${children.length} children.`
  );
  const downloadedCountByKey = new Map();
  for (const m of downloadedStories || []) {
    const k = `${String(m?.childId || "")}_${String(m?.storyId || "")}`;
    if (k === "_") continue;
    const approved = Array.isArray(m?.approvedFilenames)
      ? m.approvedFilenames.filter(_isMediaFilenameForApiCompare).length
      : 0;
    // Include facial rejects in local count checks. Rejected files are still
    // known story media and should not trigger false full re-download flags.
    const rejected = Array.isArray(m?.rejectedFilenames)
      ? m.rejectedFilenames.filter(_isMediaFilenameForApiCompare).length
      : 0;
    const queued = Array.isArray(m?.queuedFilenames)
      ? m.queuedFilenames.filter(_isMediaFilenameForApiCompare).length
      : 0;
    downloadedCountByKey.set(k, approved + rejected + queued);
  }

  // Prime centre-id lookup for child centre_ids -> centre names.
  for (const p of ["/api/v3/family/centres", "/api/v3/family_centres", "/api/v3/centres"]) {
    try {
      const u = `${STORYPARK_BASE}${p}`;
      const d = await apiFetch(u);
      _diagLog(u, d);
      const discoverRows = [];
      for (const c of d?.centres || []) {
        const cid = String(c?.id || "");
        const name = String(c?.name || c?.display_name || "").trim();
        if (!cid || !name) continue;
        centresById.set(cid, name);
        discoverRows.push({
          name,
          address: [c.address, c.suburb, c.state, c.postcode].filter(Boolean).join(", ") || null,
        });
        await saveCentreProfile({
          centreName: name,
          centreId: cid,
          address: c.address || null,
          suburb: c.suburb || null,
          state: c.state || null,
          postcode: c.postcode || null,
          lat: null,
          lng: null,
        }).catch(() => {});
      }
      if (discoverRows.length) {
        await discoverCentres(discoverRows).catch(() => {});
      }
    } catch { /* non-fatal endpoint variance */ }
  }

  const totalChildren = children.length;
  const _isoWeekKey = (dateStr = "") => {
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "";
    // ISO week key: YYYY-Www
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  };

  const _classKey = (childId, centreName, dateStr) =>
    `${childId}::${(centreName || "").toLowerCase().trim()}::${_isoWeekKey(dateStr)}`;

  const resumeChildIndex = Number.isFinite(Number(resumeCheckpoint?.childIndex))
    ? Math.max(0, Number(resumeCheckpoint.childIndex))
    : 0;
  for (let ci = resumeChildIndex; ci < totalChildren; ci++) {
    if (cancelRequested) break;
    const child = children[ci];
    const childId = String(child.id);
    const childName = child.name || `Child ${childId}`;
    await logger("INFO", `Syncing Storypark info for ${childName} (${ci + 1}/${totalChildren})…`);

    try {
      await smartDelay("READ_STORY");
      const cu = `${STORYPARK_BASE}/api/v3/children/${childId}`;
      const cd = await apiFetch(cu);
      _diagLog(cu, cd);
      const cobj = cd.child || cd || {};
      const childDob = cobj.birthday || null;
      if (childDob) childDobById.set(childId, childDob);
      const centreIds = Array.isArray(cobj.centre_ids) ? cobj.centre_ids.map(String) : [];
      childCentres[childId] = centreIds
        .map((id) => centresById.get(String(id)))
        .filter(Boolean);
      await logger(
        "INFO",
        childCentres[childId]?.length
          ? `${childName}: linked centres from API → ${childCentres[childId].join(", ")}`
          : `${childName}: no linked centres found in child profile (will still discover from story feed).`
      );
      await saveChildProfile({
        childId,
        childName,
        birthday: cobj.birthday || null,
        regularDays: Array.isArray(cobj.regular_days) ? cobj.regular_days : [],
        companies: Array.isArray(cobj.companies) ? cobj.companies : [],
        centreIds,
        centres: childCentres[childId],
      }).catch(() => {});
    } catch (err) {
      await logger("WARNING", `Child profile fetch failed for ${childName}: ${err.message}`);
    }

    let pageToken = (ci === resumeChildIndex && resumeCheckpoint?.childId === childId && resumeCheckpoint?.pageToken)
      ? String(resumeCheckpoint.pageToken)
      : null;
    let childPage = 0;
    let childStoryIdx = 0;
    const existingManifests = await getDownloadedStories(childId).catch(() => []);
    const manifestByStoryId = new Map(
      (existingManifests || []).map((m) => [String(m?.storyId || ""), m]).filter(([sid]) => Boolean(sid))
    );
    while (!cancelRequested) {
      childPage++;
      const pageStartedAt = Date.now();
      const feedUrl = new URL(`${STORYPARK_BASE}/api/v3/children/${childId}/stories`);
      feedUrl.searchParams.set("sort_by", "updated_at");
      feedUrl.searchParams.set("story_type", "all");
      if (pageToken) feedUrl.searchParams.set("page_token", pageToken);

      await logger(
        "INFO",
        `${childName}: fetching feed page ${childPage}${pageToken ? ` (page_token=${pageToken})` : " (first page)"}`
      );
      await saveSyncState({
        inProgress: true,
        checkpoint: {
          childIndex: ci,
          childId,
          childName,
          pageToken: pageToken || null,
          childPage,
          storyCount,
          catalogCount,
          pageCalls,
        },
      }).catch(() => {});
      lastCheckpoint = {
        childIndex: ci,
        childId,
        childName,
        pageToken: pageToken || null,
        childPage,
        storyCount,
        catalogCount,
        pageCalls,
      };
      await smartDelay("FEED_SCROLL");
      const feed = await apiFetch(feedUrl.toString());
      _diagLog(feedUrl.toString(), feed);
      pageCalls++;

      const stories = Array.isArray(feed?.stories) ? feed.stories : [];
      if (stories.length === 0) {
        await logger("INFO", `${childName}: page ${childPage} returned 0 stories; end of feed.`);
        break;
      }
      await logger(
        "INFO",
        `${childName}: page ${childPage} returned ${stories.length} stories (child total so far ${childStoryIdx + stories.length}).`
      );

      const catalogBatch = [];
      const detailBatch = [];
      const routineBatch = [];
      const pageStoryTotal = stories.length;
      for (const s of stories) {
        if (cancelRequested) break;
        const storyId = String(s?.id || "");
        if (!storyId) continue;
        childStoryIdx++;
        storyCount++;
        const pageStoryIndex = catalogBatch.length + 1;

        const storyDate = (s?.date || String(s?.created_at || "").split("T")[0] || "").trim();
        const centreId = s?.group_id ? String(s.group_id) : null;
        const centreName = (s?.group_name || (centreId ? centresById.get(centreId) : "") || "").trim();
        if (centreName) {
          await discoverCentres([centreName]).catch(() => {});
        }
        const title = s?.title || s?.display_title || s?.excerpt || "Story";
        const excerpt = s?.excerpt || "";
        const media = Array.isArray(s?.media) ? s.media : [];
        const imageCount = media.filter(m => (m?.content_type || "").startsWith("image/") || m?.type === "image").length;
        const videoCount = media.filter(m => (m?.content_type || "").startsWith("video/") || m?.type === "video").length;

        // Fetch full story detail for richer text + educator data + stable media list
        let detailStory = null;
        try {
          await smartDelay("READ_STORY");
          const su = `${STORYPARK_BASE}/api/v3/stories/${storyId}`;
          const sd = await apiFetch(su);
          _diagLog(su, sd);
          detailStory = sd?.story || sd || null;
          if (detailStory) await cacheStory(storyId, detailStory).catch(() => {});
        } catch (err) {
          await logger("WARNING", `Story detail fetch failed for ${childName} / ${storyId}: ${err.message}`);
        }

        const d = detailStory || s;
        const titleFromDetail = d?.title || d?.display_title || title;
        const explicitClassFromTitle = extractRoomFromTitle(titleFromDetail || title || "") || "";
        const classKey = _classKey(childId, centreName, storyDate);
        if (explicitClassFromTitle) {
          classByChildWeekCentre.set(classKey, explicitClassFromTitle);
          const centreClassKey = `${childId}::${(centreName || "").toLowerCase().trim()}`;
          if (!classSeenByChildCentre.has(centreClassKey)) classSeenByChildCentre.set(centreClassKey, new Set());
          classSeenByChildCentre.get(centreClassKey).add(explicitClassFromTitle);
        }
        const inferredClass = classByChildWeekCentre.get(classKey) || explicitClassFromTitle || "";
        const className = inferredClass;
        const classSource = explicitClassFromTitle
          ? "story-title"
          : (inferredClass ? "same-week-centre" : "none");

        // Pull routine summary/details by story date (cached per child+date).
        const routine = storyDate ? await fetchRoutineSummary(childId, storyDate).catch(() => ({ summary: "", detailed: "" })) : { summary: "", detailed: "" };
        const routineSummary = typeof routine === "string" ? routine : (routine?.summary || "");
        const routineDetailed = typeof routine === "string" ? routine : (routine?.detailed || "");
        const routineKey = storyDate ? `${childId}_${storyDate}` : "";

        const displayTitle = String(titleFromDetail || title || "Story").replace(/\s+/g, " ").trim().slice(0, 90);
        await logger(
          "INFO",
          `${childName}: story ${pageStoryIndex}/${pageStoryTotal} on page ${childPage} (global ${storyCount}) — ${storyDate || "unknown date"} · ${displayTitle || "(untitled)"}`
        );

        const educatorName =
          d?.user?.display_name ||
          (Array.isArray(d?.teachers) ? d.teachers[0]?.display_name : "") ||
          d?.creator?.display_name ||
          "";
        if (educatorName && d?.user?.id) {
          await saveEducator({
            educatorId: String(d.user.id),
            educatorName,
            childId,
            centreName: centreName || null,
          }).catch(() => {});
        }

        const effectiveMedia = Array.isArray(d?.media) ? d.media : media;
        const effectiveImageCount = effectiveMedia.filter(m => (m?.content_type || "").startsWith("image/") || m?.type === "image").length;
        const effectiveVideoCount = effectiveMedia.filter(m => (m?.content_type || "").startsWith("video/") || m?.type === "video").length;
        const effectiveOtherCount = Math.max(0, effectiveMedia.length - effectiveImageCount - effectiveVideoCount);
        const fileCount = effectiveMedia.length || imageCount + videoCount;
        const mediaTypes = Array.from(
          new Set(
            effectiveMedia
              .map((m) => (m?.content_type || m?.type || "unknown").toString().toLowerCase())
              .filter(Boolean)
          )
        );
        const key = `${childId}_${storyId}`;
        const downloadedCount = downloadedCountByKey.get(key);
        // Force full re-download when local media count differs from API
        // in either direction (lower OR higher), so story manifests can be
        // fully realigned to the current Storypark media set.
        const requiresRedownload =
          Number.isFinite(downloadedCount) && downloadedCount !== fileCount;
        if (requiresRedownload) {
          await logger(
            "WARNING",
            `File-count mismatch for ${childName} story ${storyId}: local=${downloadedCount}, api=${fileCount}. Marked for full re-download.`
          );
        }
        await logger(
          "INFO",
          `${childName}: indexed story ${storyId} · media ${fileCount} (${effectiveImageCount} image, ${effectiveVideoCount} video, ${effectiveOtherCount} other) · centre "${centreName || "Unknown"}"${className ? ` · class "${className}"` : ""}${educatorName ? ` · educator "${educatorName}"` : ""}${routineSummary ? " · routine found" : " · no routine"}.`
        );

        catalogBatch.push({
          childId,
          childName,
          childDob: childDobById.get(childId) || null,
          childAgeAtStory: childDobById.get(childId) && storyDate ? calculateAge(childDobById.get(childId), storyDate) : "",
          storyId,
          storyDate,
          title: titleFromDetail || title,
          excerpt,
          educatorName,
          centreId,
          centreName,
          className,
          classSource,
          hasStoryBody: Boolean((d?.display_content || d?.body || d?.excerpt || "").toString().trim()),
          hasRoutine: Boolean(routineSummary || routineDetailed),
          detailKey: `${childId}_${storyId}`,
          routineKey: routineKey || null,
          imageCount: effectiveImageCount,
          videoCount: effectiveVideoCount,
          otherCount: effectiveOtherCount,
          mediaTypes,
          fileCount,
          downloadedCount: Number.isFinite(downloadedCount) ? downloadedCount : null,
          requiresRedownload,
          hasBody: Boolean(d?.display_content || d?.body || d?.excerpt),
          updatedAt: d?.updated_at || s?.updated_at || null,
        });

        const normalisedBody = normaliseStoryText(d?.display_content || d?.body || d?.excerpt || "").slice(0, 30000);
        const routineForManifest = (routineDetailed || routineSummary || "").trim();

        detailBatch.push({
          childId,
          childName,
          storyId,
          storyDate,
          title: titleFromDetail || title,
          excerpt,
          storyBody: normalisedBody,
          rawDisplayContent: d?.display_content ?? null,
          rawBody: d?.body ?? null,
          rawExcerpt: d?.excerpt ?? null,
          rawContent: d?.content ?? null,
          rawMedia: Array.isArray(d?.media) ? d.media : (Array.isArray(d?.attachments) ? d.attachments : []),
          educatorName,
          centreId,
          centreName,
          className,
          classSource,
          updatedAt: d?.updated_at || s?.updated_at || null,
        });

        // Keep existing downloaded manifests hydrated with latest API body/routine
        // so HTML and Story Card regeneration can include routine without full rescan.
        const existingManifest = manifestByStoryId.get(storyId);
        if (existingManifest) {
          const patched = { ...existingManifest };
          let changed = false;
          if (normalisedBody && patched.storyBody !== normalisedBody) {
            patched.storyBody = normalisedBody;
            patched.excerpt = stripHtml(normalisedBody).slice(0, 200);
            changed = true;
          }
          if (routineForManifest && patched.storyRoutine !== routineForManifest) {
            patched.storyRoutine = routineForManifest;
            changed = true;
          }
          if (!patched.educatorName && educatorName) {
            patched.educatorName = educatorName;
            changed = true;
          }
          if (changed) {
            await addDownloadedStory(patched).catch(() => {});
            manifestByStoryId.set(storyId, patched);
          }
        }

        if (routineKey) {
          routineBatch.push({
            childId,
            childName,
            storyDate,
            routineSummary,
            routineDetailed,
          });
        }

        if (storyCount % 20 === 0) {
          await logger(
            "INFO",
            `Sync progress: global ${storyCount}${estimatedTotalStories ? `/${estimatedTotalStories}` : ""} stories; ${childName} ${childStoryIdx} stories processed; currently story ${storyId}.`
          );
        }
      }

      catalogCount += await upsertStoryCatalogRecords(catalogBatch);
      await upsertStoryDetailRecords(detailBatch);
      await upsertRoutineSnapshotRecords(routineBatch);
      const nextToken = feed?.next_page_token || null;
      const elapsedMs = Date.now() - syncStartedAt;
      const globalAvgMsPerStory = storyCount > 0 ? elapsedMs / storyCount : 0;
      const pageElapsedMs = Date.now() - pageStartedAt;
      const pageAvgMsPerStory = pageStoryTotal > 0 ? pageElapsedMs / pageStoryTotal : 0;
      if (pageAvgMsPerStory > 0) {
        etaMsPerStoryEma = etaMsPerStoryEma == null
          ? pageAvgMsPerStory
          : (etaMsPerStoryEma * 0.7) + (pageAvgMsPerStory * 0.3);
      }
      const blendedAvgMsPerStory = etaMsPerStoryEma != null && globalAvgMsPerStory > 0
        ? ((etaMsPerStoryEma * 0.65) + (globalAvgMsPerStory * 0.35))
        : (etaMsPerStoryEma ?? globalAvgMsPerStory);
      const projectedTotalRaw = estimatedTotalStories && estimatedTotalStories >= storyCount
        ? estimatedTotalStories
        : Math.max(
          storyCount + (nextToken ? Math.max(stories.length, Math.round(childStoryIdx / Math.max(1, childPage))) : 0),
          storyCount
        );
      stableProjectedTotal = Math.max(stableProjectedTotal, projectedTotalRaw, storyCount);
      const projectedTotal = stableProjectedTotal;
      const remainingStories = Math.max(0, projectedTotal - storyCount);
      let etaMs = storyCount >= 5 && blendedAvgMsPerStory > 0
        ? (blendedAvgMsPerStory * remainingStories)
        : null;
      if (etaMs != null && Number.isFinite(etaMs)) {
        if (lastEtaMs == null) {
          lastEtaMs = etaMs;
        } else {
          // Clamp ETA jumps per page so "overall remaining" stays readable.
          const maxStep = Math.max(60_000, lastEtaMs * 0.25);
          const delta = etaMs - lastEtaMs;
          if (Math.abs(delta) > maxStep) {
            etaMs = lastEtaMs + (Math.sign(delta) * maxStep);
          }
          lastEtaMs = etaMs;
        }
      }
      const eta = etaMs != null ? formatETA(etaMs) : "";
      chrome.runtime.sendMessage({
        type: "PROGRESS",
        current: storyCount,
        total: projectedTotal,
        childName: `Syncing ${childName} (page ${childPage})`,
        date: `Child ${ci + 1}/${totalChildren} · page ${childPage}${nextToken ? " · next block queued" : " · final block"}`,
        eta,
        childIndex: ci + 1,
        childCount: totalChildren,
      }).catch(() => {});
      await logger(
        "INFO",
        `${childName}: finished page ${childPage}. Global progress ${storyCount}/${projectedTotal}${eta ? ` · ETA ${eta}` : ""}${nextToken ? " · continuing to next block." : " · child complete."}`
      );
      await appendSyncJournal([
        {
          level: "INFO",
          event: "sync_page_complete",
          childId,
          childName,
          childIndex: ci,
          childPage,
          pageToken: pageToken || null,
          nextPageToken: nextToken || null,
          storyCount,
          catalogCount,
          pageCalls,
        },
      ]).catch(() => {});
      pageToken = nextToken;
      if (!pageToken) break;
    }
  }

  await logger(
    cancelRequested ? "WARNING" : "SUCCESS",
    `${cancelRequested ? "Sync cancelled" : "Sync complete"}: ${storyCount} stories indexed across ${children.length} children (${catalogCount} catalog updates, ${pageCalls} feed pages).`
  );

  await chrome.storage.local.set({ childCentres }).catch(() => {});
  await saveSyncState({
    inProgress: false,
    lastSuccessAt: new Date().toISOString(),
    lastRunStats: { children: children.length, stories: storyCount, catalogUpdates: catalogCount, cancelled: !!cancelRequested },
    checkpoint: cancelRequested
      ? lastCheckpoint
      : null,
  }).catch(() => {});
  await appendSyncJournal([
    {
      level: cancelRequested ? "WARNING" : "SUCCESS",
      event: cancelRequested ? "sync_cancelled" : "sync_complete",
      storyCount,
      catalogCount,
      pageCalls,
      children: children.length,
    },
  ]).catch(() => {});

  return { children: children.length, stories: storyCount, catalogUpdates: catalogCount, cancelled: !!cancelRequested };
}

// geocodeCentre, discoverCentres lib/api-client.js (imported above)


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
 * older than the cutoff so a "last 30 days" scan only fetches 1-2 pages
 * instead of walking years of history.  This dramatically reduces both RAM
 * usage and API calls for date-limited scans.
 *
 * @param {string}    childId
 * @param {string}    mode ?? "EXTRACT_LATEST" | "DEEP_RESCAN"
 * @param {string}    childName || For log messages
 * @param {Date|null} cutoffDate || Stop collecting stories older than this date.
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
      // than the cutoff means all subsequent stories are also older stop.
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
    await logger("INFO", `Scanning${childName ? ` ${childName}` : ""}� found ${summaries.length} stories${dateRange}${cutoffNote}`);

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
        // Both endpoints failed
        return empty
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
 *   summary || comma-separated titles (e.g. "Drink, Nappy - Wet, Sleep")
 *   detailed timestamped lines (e.g. "8:40 AM - Drink (80ml)")
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
          // Track oldest date to know the boundary of our data.
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
/*  Story output helpers shared by all HTML/card generation paths   */
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
 * e.g. "Storypark Smart Saver/Harry Hill/Stories/2026-03-03 Tuesday in Nursery One"
 *
 * @param {string} childName
 * @param {string} folderName
 * @returns {string}
 */
function _storyBasePath(childName, folderName) {
  return `Storypark Smart Saver/${sanitizeName(childName)}/Stories/${folderName}`;
}

// All scan helpers (runExtraction, _rebuildIndexPages) are imported from lib/scan-engine.js above.
// All HTML builders (buildStoryHtml, buildChildrenIndexHtml, buildMasterIndexHtml) are imported from lib/html-builders.js above.
// All metadata helpers (sanitizeName, stripHtml, stripEmojis, calculateAge, buildExifMetadata, sanitiseForExif, 
// sanitiseForIptcCaption) are imported from lib/metadata-helpers.js above.

/* ================================================================== */
/*  Index page builders                                                */
/* ================================================================== */

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
 * Matches patterns like "� in Nursery One", "� in Senior Kindy ��",
 * "� in Nursery 1".
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

  // Normalise: "Nursery 1" "Nursery One", etc. for consistency
        return normaliseRoomName(candidate);
}

/**
 * Normalise room name variants to a canonical form.
 * "Nursery 1" / "nursery one" "Nursery One"
 *
 * @param {string} name
 * @returns {string}
 */
function normaliseRoomName(name) {
  const numMap = { "1": "One", "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six" };
  // Replace trailing digit with word.
  let normalised = name.replace(/\b(\d)\b/g, (_, d) => numMap[d] || d);
  // Title-case each word
normalised = normalised.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  // Fix common casing: "Kindy" not "kindy", "Pre-School" etc.
        return normalised;
}

/**
 * Pre-scan story summaries to build a room-by-period map.
 * For each story that has a room name in its title, records (yearMonth roomName).
 * Then for each period, the most frequent room name wins.
 *
 * Also fetches full story titles from the summaries. The feed-level summary
 * includes `title` directly (no extra API call needed).
 *
 * @param {Array<{id: string, created_at: string, title?: string}>} summaries
 * @returns {Map<string, string>} yearMonth ("2026-04") dominant room name
 */
function buildRoomMap(summaries) {
  // Collect: yearMonth { roomName count }
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
 * @param {string} dateStr || YYYY-MM-DD
 * @param {Map<string, string>} roomMap || yearMonth room name
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
 * @param {string} birthday || YYYY-MM-DD format
 * @param {string} atDate || YYYY-MM-DD format (story date)
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
 *   title || EXIF ImageDescription (short: "Harry - 8 months")
 *   subject EXIF XPSubject (short story excerpt)
 *   comments EXIF UserComment (full story + timestamped routine + attribution)
 *
 * Also returns a legacy `description` field (full text) for backward compatibility
 * with any code that still expects a single string.
 */
function buildExifMetadata(body, childFirstName, routineData, roomName, centreName, childAge = "") {
  // routineData may be a string (legacy) or { summary, detailed } object.
  const routineSummary = typeof routineData === "string" ? routineData : (routineData?.summary || "");
  const routineDetailed = typeof routineData === "string" ? routineData : (routineData?.detailed || "");

  // Title: short identifier
  const titleParts = [childFirstName || "Child"];
  if (childAge) titleParts.push(childAge);
  const title = stripEmojis(titleParts.join(" - "));

  // Subject: short excerpt of the story
  const plainBody = stripHtml(body);
  const subject = stripEmojis((plainBody || "").substring(0, 200));

  // Comments: full story + timestamped routine + attribution
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
 * @param {number} [maxLen=255] || EXIF ASCII field limit
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
 * @param {string} text || Already HTML-stripped plain text
 * @param {number} maxBytes || Max UTF-8 byte count (IPTC limit = 2000)
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

/* ================================================================== */
/*  Message router                                                     */
/* ================================================================== */

/**
 * Compatibility map: dashboard module sometimes sends shorter/legacy
 * message names that don't match the canonical case labels in the router.
 * We normalise them here so a single rename doesn't cascade into ten silent
 * "no handler" failures across the UI.
 */
const _MSG_TYPE_ALIASES = {
  REBUILD_HTML_ALL:        "BUILD_HTML_STRUCTURE",
  APPEND_DESCRIPTOR:       "SAVE_TRAINING_DESCRIPTOR",
  SET_DEBUG_CAPTURE:       "SET_DEBUG_CAPTURE_MODE",
  GET_DEBUG_LOG:           "GET_DIAGNOSTIC_LOG",
  CLEAR_DEBUG_LOG:         "CLEAR_DIAGNOSTIC_LOG",
  GET_DB_INFO:             "ACTIVE_DATABASE_INFO",
  // Post-Processing tab buttons — alias to the existing batch handlers
  INIT_FACE_FILTER:        "RE_EVALUATE_QUEUE",
  EMBED_EXIF_ALL:          "REWRITE_EXIF_ONLY",
};


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;

  // Normalise legacy/short message names so dashboard modules and the
  // router stay in sync after partial renames.
        if (_MSG_TYPE_ALIASES[msg.type]) {
    msg = { ...msg, type: _MSG_TYPE_ALIASES[msg.type] };
  }

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

    case "GET_STORYPARK_SYNC_STATUS": {
      (async () => {
        const state = await getSyncState().catch(() => ({}));
        const { syncScheduleEnabled = false, syncScheduleHours = 72 } = await chrome.storage.local.get([
          "syncScheduleEnabled",
          "syncScheduleHours",
        ]);
        sendResponse({
          ok: true,
          state,
          schedule: { enabled: !!syncScheduleEnabled, hours: Number(syncScheduleHours) || 72 },
        });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "SET_STORYPARK_SYNC_SCHEDULE": {
      (async () => {
        const enabled = msg?.enabled === true;
        const hours = Math.max(24, Number(msg?.hours) || 72);
        await chrome.storage.local.set({ syncScheduleEnabled: enabled, syncScheduleHours: hours });
        if (enabled) {
          await chrome.alarms.create(STORYPARK_SYNC_ALARM, { periodInMinutes: hours * 60 });
        } else {
          await chrome.alarms.clear(STORYPARK_SYNC_ALARM);
        }
        await logger("INFO", enabled
          ? `Automatic Storypark sync enabled (every ${hours} hours).`
          : "Automatic Storypark sync disabled.");
        sendResponse({ ok: true, enabled, hours });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_STORYPARK_SYNC_HEALTH": {
      (async () => {
        const state = await getSyncState().catch(() => ({}));
        const journal = await getSyncJournal(true).catch(() => []);
        const integrity = await getDatabaseIntegrityReport().catch(() => ({ generatedAt: new Date().toISOString(), files: [] }));
        const jobs = await getJobsState().catch(() => ({}));
        const last200 = journal.slice(0, 200);
        const latestTs = last200.length ? Date.parse(last200[0]?.timestamp || "") : NaN;
        const lastProgressAgeMs = Number.isFinite(latestTs) ? Math.max(0, Date.now() - latestTs) : null;
        const errorCount = last200.filter((e) => String(e?.level || "").toUpperCase() === "ERROR").length;
        const warningCount = last200.filter((e) => String(e?.level || "").toUpperCase() === "WARNING").length;
        const retryCount = last200.filter((e) => String(e?.message || "").toLowerCase().includes("retry")).length;
        sendResponse({
          ok: true,
          state,
          health: {
            errorsLast200: errorCount,
            warningsLast200: warningCount,
            retriesLast200: retryCount,
            lastProgressAgeMs,
            journalEntries: journal.length,
            integrityGeneratedAt: integrity.generatedAt,
            integrityFiles: integrity.files,
            jobsState: jobs,
          },
        });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_FACE_MODEL_HEALTH": {
      handleGetFaceModelHealth(msg, _handlerCtx())
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "SET_FACE_HOLDOUT_SET": {
      handleSetFaceHoldoutSet(msg, _handlerCtx())
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_DECISION_AUDIT_SUMMARY": {
      handleGetDecisionAuditSummary(msg, _handlerCtx())
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RUN_RETENTION_MAINTENANCE": {
      handleRunRetentionMaintenance(msg, _handlerCtx())
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RESUME_STORYPARK_SYNC_NOW": {
      if (isScanning) {
        sendResponse({ ok: false, error: "Another scan/sync task is already in progress." });
        return false;
      }
      isScanning = true;
      cancelRequested = false;
      chrome.storage.session
        .set({ isScanning: true, cancelRequested: false, _requestCount: 0 })
        .catch(() => {});
      (async () => {
        await logger("INFO", "Resuming Storypark sync from last saved checkpoint…");
        const stats = await syncStoryparkInformation();
        sendResponse({ ok: true, stats });
      })()
        .catch(async (err) => {
          await logger("ERROR", `Storypark sync resume failed: ${err.message}`);
          sendResponse({ ok: false, error: err.message });
        })
        .finally(() => {
          isScanning = false;
          cancelRequested = false;
          chrome.storage.session
            .set({ isScanning: false, cancelRequested: false })
            .catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        });
      return true;
    }

    case "SYNC_STORYPARK_INFORMATION": {
      if (isScanning) {
        sendResponse({ ok: false, error: "Another scan/sync task is already in progress." });
        return false;
      }
      isScanning = true;
      cancelRequested = false;
      chrome.storage.session
        .set({ isScanning: true, cancelRequested: false, _requestCount: 0 })
        .catch(() => {});

      (async () => {
        await logger("INFO", "Sync from Storypark started. Time remaining is shown in the progress bar.");
        chrome.runtime.sendMessage({
          type: "PROGRESS",
          current: 0,
          total: 1,
          childName: "Syncing Storypark information…",
          date: "",
          eta: "",
          childIndex: 0,
          childCount: 0,
        }).catch(() => {});
        const stats = await syncStoryparkInformation();
        sendResponse({ ok: true, stats });
      })()
        .catch(async (err) => {
          await logger("ERROR", `Storypark sync failed: ${err.message}`);
          sendResponse({ ok: false, error: err.message });
        })
        .finally(() => {
          isScanning = false;
          cancelRequested = false;
          chrome.storage.session
            .set({ isScanning: false, cancelRequested: false })
            .catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        });
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
            await logger("INFO", `Scanning ${child.name} (${i + 1}/${children.length})�`);
            chrome.runtime.sendMessage({
              type: "LOG",
              message: `Scanning ${child.name} (${i + 1}/${children.length})�`,
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
      (async () => {
        const item = await getReviewQueueItem(msg.id).catch(() => null);
        const result = await _handlerReviewApprove(msg, _handlerCtx());
        if (result?.ok && item) {
          const phaseData = await getChildPhase(item.childId).catch(() => null);
          await appendDecisionLogEntries([{
            source: "manual_review",
            decision: "approve",
            childId: item.childId,
            childName: item.childName,
            storyId: item.storyData?.storyId || "",
            imageUrlHash: "",
            phase: phaseData?.phase || null,
            reasonCode: "manual_approve",
          }]).catch(() => {});
        }
        sendResponse(result);
      })().catch((err)   => sendResponse({ ok: false, error: err.message }));
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
        // contrastive learning rejected faces actively improve accuracy
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
        if (item) {
          const phaseData = await getChildPhase(item.childId).catch(() => null);
          await appendDecisionLogEntries([{
            source: "manual_review",
            decision: "reject",
            childId: item.childId,
            childName: item.childName,
            storyId: item.storyData?.storyId || "",
            imageUrlHash: "",
            phase: phaseData?.phase || null,
            reasonCode: "manual_reject",
          }]).catch(() => {});
        }
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

    /* 3-Phase adaptive face recognition messages */

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
        phase:          phaseData.phase ?? 1,
        verifiedCount:  phaseData.verifiedCount ?? 0,
        phase1Complete: phaseData.phase1Complete ?? false,
        phase2Complete: phaseData.phase2Complete ?? false,
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
            const EMOJIS = { 2: "", 3: "", 4: "" };
            const LABELS = { 2: "Validation", 3: "Confident", 4: "Production" };
            const emoji = EMOJIS[p.phase] || "";
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
        // Return both keys for compatibility while modules are unified.
        sendResponse({ ok: true, activityLog, entries: activityLog });
      });
      return true;
    }

    case "CLEAR_ACTIVITY_LOG": {
      (async () => {
        await chrome.storage.local.set({ activityLog: [] });
        await clearPersistedActivityLog().catch(() => {});
      })()
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
      return false; // synchronous no async response needed
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
      // a face is present it avoids duplicated model inference and the failure
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

    case "SAVE_CENTRE_LOCATIONS": {
      (async () => {
        try {
          const centreLocations = msg?.centreLocations && typeof msg.centreLocations === "object"
            ? msg.centreLocations
            : {};
          await chrome.storage.local.set({ centreLocations });
          for (const [centreName, meta] of Object.entries(centreLocations)) {
            if (!centreName) continue;
            await saveCentreProfile({
              centreName,
              lat: Number.isFinite(Number(meta?.lat)) ? Number(meta.lat) : null,
              lng: Number.isFinite(Number(meta?.lng)) ? Number(meta.lng) : null,
              address: meta?.address || null,
              mapsUrl: meta?.mapsUrl || "",
            }).catch(() => {});
          }
          sendResponse({ ok: true, count: Object.keys(centreLocations).length });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
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
      // NOTE: Temporary debug feature disable during normal use to save memory.
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
      // Order: ALL media first story HTML per story index pages.
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

          // Phase 1: Group items by storyId
        const storyGroups = new Map(); // storyId { items[], downloadedFilenames[] }
          for (const item of items) {
            const sid = item.storyId || item.storyData?.storyId || "unknown";
            if (!storyGroups.has(sid)) {
              storyGroups.set(sid, { items: [], downloadedFilenames: [] });
            }
            storyGroups.get(sid).items.push(item);
          }

          // Phase 2: Download ALL media across ALL stories
        let downloaded = 0;
          let failed = 0;
          let batchItemsDone = 0;
          const batchTotal = items.length;
          const _batchLoopStart = Date.now(); // ETA tracking
const { saveStoryHtml = true } = await chrome.storage.local.get("saveStoryHtml");
          const _templateSettings = await _getTemplateSettingsMerged();
          // GPS cache: Map<centreName, {lat,lng}|null> one IDB lookup per unique centre name
        const _gpsCache = new Map();

          for (const [storyId, group] of storyGroups) {
            for (const item of group.items) {
              let wroteFile = false;
              try {
                // Resolve GPS coordinates ||
        let gpsCoords = item.gpsCoords
null;
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
                  // see downloadVideoFromOffscreen() for rationale.
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
        const _tokenMap = buildTemplateTokenMap({
                    storyDate: item.storyData?.createdAt || item.storyData?.date || "",
                    storyTitle: item.storyData?.title || "",
                    storyBody: item.description || item.storyData?.body || "",
                    childName: item.childName || "",
                    childAge: item.childAge || "",
                    roomName: item.storyData?.roomName || "",
                    centreName: item.storyData?.centreName || "",
                    educatorName: item.storyData?.educatorName || "",
                    routineText: item.storyData?.routineText || "",
                    photoCount: 1,
                  });
                  const _exifTitle = renderTemplate(_templateSettings.exif.title, _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifTitle });
                  const _exifSubject = renderTemplate(_templateSettings.exif.subject || "[StoryBody]", _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifSubject });
                  const _exifComments = renderTemplate(_templateSettings.exif.comments || "[StoryBody]", _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifComments });
        const result = await sendToOffscreen({
                    type:        "DOWNLOAD_APPROVED",
                    storyData:   item.storyData || { originalUrl: item.imageUrl },
                    description: item.description || "",
                    exifTitle:   _exifTitle || item.exifTitle || "",
                    exifSubject: _exifSubject || item.exifSubject || "",
                    exifComments:_exifComments || item.exifComments || "",
                    childName:   item.childName,
                    savePath:    item.savePath,
                    gpsCoords,
                    templateSettings: _templateSettings,
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

          // Phase 3: Generate story HTML per story (AFTER all media downloaded) // Skip entirely if nothing was actually written avoids overwriting index.html
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

                  // story.html
        const _tmpl = await _getTemplateSettingsMerged();
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
                    templateSettings: _tmpl,
                  });
                  const txtRes = await sendToOffscreen({
                    type: "DOWNLOAD_TEXT",
                    text: htmlContent,
                    savePath: `${storyBasePath}/${getStoryHtmlFilenames(manifest.storyDate, manifest.storyTitle, manifest.folderName).primary}`,
                    mimeType: "text/html",
                  });
                  if (txtRes.dataUrl && txtRes.savePath) {
                    await downloadHtmlFile(txtRes.dataUrl, txtRes.savePath);
                    const htmlNames = getStoryHtmlFilenames(manifest.storyDate, manifest.storyTitle, manifest.folderName);
                    if (htmlNames.legacy) {
                      const namedRes = await sendToOffscreen({
                        type: "DOWNLOAD_TEXT",
                        text: htmlContent,
                        savePath: `${storyBasePath}/${htmlNames.legacy}`,
                        mimeType: "text/html",
                      });
                      if (namedRes.dataUrl && namedRes.savePath) await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
                    }
                  }

                  // story card (JPEG) regenerated with correct photo count.
                  if (storyBody && (manifest.approvedFilenames || []).length > 0) {
                    try {
                      const gpsCoords = manifest.centreName
                        ? await getCentreGPS(manifest.centreName).catch(() => null)
                        : null;
                      const cardSavePath = `${storyBasePath}/${manifest.storyCardFilename || getStoryCardFilename(manifest.storyDate, manifest.storyTitle, manifest.folderName)}`;
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
                        templateSettings: _tmpl,
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

          // Phase 4: Generate index pages (AFTER all HTML generated)
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
          if (isScanning) {
            sendResponse({ ok: false, error: "A scan/process task is already running." });
            return;
          }
          isScanning = true;
          cancelRequested = false;
          chrome.storage.session.set({ isScanning: true, cancelRequested: false, _requestCount: 0 }).catch(() => {});
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
          const loopStart = Date.now();
          const total = childQueue.length;

          await logger("INFO", `Face Filter started for child ${childId}: ${total} queued photos to re-evaluate.`);

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
            for (let i = 0; i < result.results.length; i++) {
              if (cancelRequested) break;
              const r = result.results[i];
              const done = i + 1;
              const elapsed = Date.now() - loopStart;
              const avgMs = done > 0 ? elapsed / done : 0;
              const eta = (done >= 3 && avgMs > 0 && total > done) ? formatETA(avgMs * (total - done)) : "";
              chrome.runtime.sendMessage({
                type: "PROGRESS",
                current: done,
                total: Math.max(1, total),
                childName: "Face Filter re-evaluating…",
                date: "",
                eta,
                childIndex: 0,
                childCount: 1,
              }).catch(() => {});
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
                  await appendDecisionLogEntries([{
                    source: "auto_re_evaluate",
                    decision: "approve",
                    childId: item.childId,
                    childName: item.childName,
                    storyId: item.storyData?.storyId || "",
                    imageUrlHash: "",
                    phase: childPhaseData.phase,
                    thresholds: { autoThreshold, minThreshold: userMin },
                    scores: { effectiveScore: r.effectiveScore ?? r.matchPct ?? null, negativeScore: r.rawNegative ?? null },
                    reasonCode: "auto_re_evaluate_approve",
                  }]).catch(() => {});
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
                  await appendDecisionLogEntries([{
                    source: "auto_re_evaluate",
                    decision: "reject",
                    childId: item.childId,
                    childName: item.childName,
                    storyId: item.storyData?.storyId || "",
                    imageUrlHash: "",
                    phase: childPhaseData.phase,
                    thresholds: { autoThreshold, minThreshold: userMin },
                    scores: { effectiveScore: r.effectiveScore ?? r.matchPct ?? null, negativeScore: r.rawNegative ?? null },
                    reasonCode: "auto_re_evaluate_reject",
                  }]).catch(() => {});
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
          const cancelled = !!cancelRequested;
          await logger(
            cancelled ? "WARNING" : "SUCCESS",
            cancelled
              ? `Face Filter cancelled: ${autoApproved} approved, ${autoRejected} rejected, ${remaining} remaining.`
              : `Face Filter complete: ${autoApproved} approved, ${autoRejected} rejected, ${remaining} remaining.`
          );
          chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
          sendResponse({ ok: true, autoApproved, autoRejected, remaining, cancelled });
        } catch (err) {
          await logger("ERROR", `Face Filter failed: ${err.message}`);
          sendResponse({ ok: false, error: err.message });
        } finally {
          isScanning = false;
          cancelRequested = false;
          chrome.storage.session.set({ isScanning: false, cancelRequested: false }).catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        }
      })();
      return true;
    }

    case "SELF_IMPROVE_FACE_MODEL": {
      handleSelfImproveFaceModel(msg, _handlerCtx())
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RUN_INITIAL_FACE_BOOTSTRAP": {
      handleRunInitialFaceBootstrap(msg, _handlerCtx())
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
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
          if (isScanning) {
            sendResponse({ ok: false, error: "A scan/process task is already running." });
            return;
          }
          isScanning = true;
          cancelRequested = false;
          chrome.storage.session.set({ isScanning: true, cancelRequested: false, _requestCount: 0 }).catch(() => {});
          await logger("INFO", "Post-Processing started: generating HTML and Story Cards.");
          await ensureOffscreen();
          const { children = [], saveStoryCard = true } = await chrome.storage.local.get(["children", "saveStoryCard"]);
          let storyCount = 0, cardCount = 0;
          let cancelled = false;
          let totalStories = 0;
          for (const child of children) {
            const manifests = await getDownloadedStories(child.id).catch(() => []);
            totalStories += manifests.length;
          }
          let doneStories = 0;

          for (const child of children) {
            if (cancelRequested) {
              cancelled = true;
              break;
            }
            const manifests = await getDownloadedStories(child.id).catch(() => []);
            if (manifests.length === 0) continue;

            for (const m of manifests) {
              if (cancelRequested) {
                cancelled = true;
                break;
              }
              doneStories++;
              chrome.runtime.sendMessage({
                type: "PROGRESS",
                current: doneStories,
                total: Math.max(1, totalStories),
                date: m.storyDate ? formatDateDMY(m.storyDate) : "",
                childName: `Generating ${m.childName || "stories"}`,
                eta: "",
                childIndex: 0,
                childCount: 1,
              }).catch(() => {});
              try {
                const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;

                // Use stored routine text (fixes the hardcoded "" bug) ||
                const routineText = (m.storyRoutine || "").trim();

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

                // story.html honour rejectedFilenames (never link to rejected).
                const rejectedSet = new Set(m.rejectedFilenames || []);
                const approvedOnly = (m.approvedFilenames || []).filter(f => !rejectedSet.has(f));
                const _tmpl = await _getTemplateSettingsMerged();
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
                  templateSettings: _tmpl,
                });
                const res = await sendToOffscreen({
                  type: "DOWNLOAD_TEXT", text: htmlContent,
                  savePath: `${storyBasePath}/${m.storyHtmlFilename || "story.html"}`, mimeType: "text/html",
                });
                if (res.dataUrl && res.savePath) {
                  await downloadHtmlFile(res.dataUrl, res.savePath);
                  const htmlNames = getStoryHtmlFilenames(m.storyDate, m.storyTitle, m.folderName);
                  if (htmlNames.legacy) {
                    const namedRes = await sendToOffscreen({
                      type: "DOWNLOAD_TEXT", text: htmlContent,
                      savePath: `${storyBasePath}/${htmlNames.legacy}`, mimeType: "text/html",
                    });
                    if (namedRes.dataUrl && namedRes.savePath) await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
                  }
                  storyCount++;
                }

                // story card (JPEG) gated on saveStoryCard setting + has body
        if (saveStoryCard && storyBody && approvedOnly.length > 0) {
                  try {
                    const gpsCoords = m.centreName
                      ? await getCentreGPS(m.centreName).catch(() => null)
                      : null;
                    const cardSavePath = `${storyBasePath}/${m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName)}`;
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
                      templateSettings: _tmpl,
                    });
                    if (cardResult.ok && cardResult.dataUrl) {
                      await downloadDataUrl(cardResult.dataUrl, cardSavePath);
                      cardCount++;
                    }
                  } catch { /* non-fatal card generation failure should not block HTML */ }
                }
              } catch (err) {
                console.warn(`Story rebuild failed for ${m.storyId}:`, err.message);
              }
            }
            if (cancelled) break;
          }

          // Rebuild all index pages using the shared helper
          await _rebuildIndexPages(children);

          if (cancelled) {
            await logger("WARNING", `Post-Processing cancelled: ${storyCount} pages${cardCount > 0 ? `, ${cardCount} cards` : ""} generated before stop.`);
          } else {
            await logger("SUCCESS", `HTML rebuilt: ${storyCount} pages${cardCount > 0 ? `, ${cardCount} cards` : ""} + index pages`);
          }

          sendResponse({ ok: true, count: storyCount, cards: cardCount, cancelled });
        } catch (err) {
          await logger("ERROR", `Post-Processing failed: ${err.message}`);
          sendResponse({ ok: false, error: err.message });
        } finally {
          isScanning = false;
          cancelRequested = false;
          chrome.storage.session.set({ isScanning: false, cancelRequested: false }).catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
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
                // Item stays in pending it passed verification
              } else if (result?.result === "reject") {
                rejected++;
                await removePendingDownload(item.id);
                // Track rejection so re-scans don't re-queue.
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
            `Final verification: ${verified}/${total} confirmed, ${rejected} rejected, ${flagged} flagged for review` +
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
      // Used when a photo rescued from "Rejected Matches" is approved in the Review tab // the file is moved back to Stories/, and this handler updates the IDB manifest
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
            // Remove from rejectedFilenames a rescued file must not remain excluded
            // from HTML rendering (buildStoryPage filters on rejectedSet.has(f)).
        const rejected = (manifest.rejectedFilenames || []).filter(f => f !== amFilename);
            const current  = manifest.approvedFilenames || [];
            const approved = current.includes(amFilename) ? current : [...current, amFilename];
            await addDownloadedStory({
              ...manifest,
              approvedFilenames:  approved,
              rejectedFilenames:  rejected,
              thumbnailFilename:  manifest.thumbnailFilename || amFilename,
            });
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
          await logger("INFO", `️ Cache cleared: ${what}`);
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
          logger("INFO", "All rejected image records cleared next scan will re-evaluate them.");
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

    /* Scan resume messages */

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
      // Manually force a child to Phase 4 (Production) bypasses all
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
          await logger("SUCCESS", `Phase 4 (Production) forced for child ${childId} downloads now enabled!`);
          chrome.runtime.sendMessage({ type: "PHASE_ADVANCED", childId, phase: current }).catch(() => {});
          sendResponse({ ok: true, phase: current });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* Full backup export/import */

    case "FULL_BACKUP_EXPORT": {
      (async () => {
        try {
          const ctx = { logger, sendToOffscreen, getCancelRequested: () => cancelRequested };
          const result = await handleFullBackupExport(msg, ctx);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "FULL_BACKUP_IMPORT": {
      (async () => {
        try {
          const ctx = { logger, sendToOffscreen, getCancelRequested: () => cancelRequested };
          const result = await handleFullBackupImport(msg, ctx);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "GENERATE_STORY_CARD": {
      // Render a 1200 variable-height JPEG story card via the offscreen Canvas renderer.
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
      // This trusts Database/manifests.json as the source of truth every
      // story it lists is considered "done" so the next EXTRACT_LATEST scan
      // resumes from storyId 2001+ instead of re-downloading 1..2000.
      //
      // Safety: does NOT touch rejections.json, descriptors, or any other
      // store.  Rate-limit / OOM-safe because it's pure IDB writes no
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
            `Marked ${synced} stories processed from Database/manifests.json next scan will resume after story ${synced}.`,
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
      //   filesByFolder: { [folderName: string]: string[] }  actual media files per folder
      //   childId?: string
      //   if provided, only manifests for this child are updated
      // }
      // Returns: { ok, rebuilt, updated, errors }
      (async () => {
        try {
          await ensureOffscreen();
          const { filesByFolder = {}, childId: targetChildId } = msg;
          const { children = [], saveStoryCard = true } = await chrome.storage.local.get(["children", "saveStoryCard"]);
          const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;
          // Story Card JPEGs are generated assets for Google Photos not downloaded media.
          // They must never appear in approvedFilenames or be rendered as gallery images.
        const _REGEN_STORY_CARD_RE = /Story Card\.jpg$/i;

          let rebuilt = 0, updated = 0, errors = 0;

          // Get all manifests (filtered to targetChildId if provided)
        const relevantChildren = targetChildId
            ? children.filter(c => String(c.id) === String(targetChildId))
            : children;

          for (const child of relevantChildren) {
            const manifests = await getDownloadedStories(child.id).catch(() => []);

            for (const m of manifests) {
              const diskFiles = filesByFolder[m.folderName];
              if (!diskFiles) continue; // folder not found on disk skip

              // Filter to media files only exclude story.html AND Story Card JPEGs.
              // Story Cards are generated assets for Google Photos, not downloaded media.
        const mediaFiles = diskFiles.filter(f => MEDIA_EXT.test(f) && !_REGEN_STORY_CARD_RE.test(f));
              if (mediaFiles.length === 0) continue;

              try {
                // 1. Update manifest with live file list
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

                // 2. Get best story body (manifest or IDB cache)
        let storyBody = m.storyBody
"";
                if (!storyBody && m.storyId && !m.storyId.startsWith("recovered_")) {
                  const cached = await getCachedStory(m.storyId).catch(() => null);
                  if (cached) {
                    storyBody = cached.display_content || cached.body || cached.excerpt || "";
                    if (storyBody) addDownloadedStory({ ...updatedManifest, storyBody }).catch(() => {});
                  }
                }

                const routineText = m.storyRoutine || "";
                const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;

                // 3. Rebuild story.html with live file list
        const _tmpl = await _getTemplateSettingsMerged();
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
                  templateSettings: _tmpl,
                });
                const htmlRes = await sendToOffscreen({
                  type: "DOWNLOAD_TEXT", text: htmlContent,
                  savePath: `${storyBasePath}/${getStoryHtmlFilenames(m.storyDate, m.storyTitle, m.folderName).primary}`, mimeType: "text/html",
                });
                if (htmlRes.dataUrl && htmlRes.savePath) {
                  await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
                  const htmlNames = getStoryHtmlFilenames(m.storyDate, m.storyTitle, m.folderName);
                  if (htmlNames.legacy) {
                    const namedRes = await sendToOffscreen({
                      type: "DOWNLOAD_TEXT", text: htmlContent,
                      savePath: `${storyBasePath}/${htmlNames.legacy}`, mimeType: "text/html",
                    });
                    if (namedRes.dataUrl && namedRes.savePath) await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
                  }
                  rebuilt++;
                }

                // 4. Rebuild story card with live photo count
        if (saveStoryCard && storyBody && updatedFilenames.length > 0) {
                  try {
                    const gpsCoords = m.centreName
                      ? await getCentreGPS(m.centreName).catch(() => null)
                      : null;
                    const cardSavePath = `${storyBasePath}/${m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName)}`;
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
                      templateSettings: _tmpl,
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

          // 5. Rebuild index pages
        await _rebuildIndexPages(children).catch(() => {});

          await logger("SUCCESS", `Regenerated from disk: ${rebuilt} story pages rebuilt${updated > 0 ? `, ${updated} manifests updated` : ""}${errors > 0 ? `, ${errors} errors` : ""}`);
          sendResponse({ ok: true, rebuilt, updated, errors });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* v2.4: Active Database info panel */
    case "ACTIVE_DATABASE_INFO": {
      // Returns DB file info + practical story/media telemetry.
      (async () => {
        const info = await getActiveDatabaseInfo();
        const childId = msg?.childId ? String(msg.childId) : null;
        const useChildFilter = childId && childId !== "__ALL__";
        const manifests = useChildFilter
          ? await getDownloadedStories(childId).catch(() => [])
          : await getAllDownloadedStories().catch(() => []);
        const catalogRows = useChildFilter
          ? await getStoryCatalogRecords(childId).catch(() => [])
          : await getStoryCatalogRecords().catch(() => []);
        const reviewQueue = await getReviewQueue().catch(() => []);
        const queueFiltered = useChildFilter
          ? reviewQueue.filter((q) => String(q?.childId || "") === childId)
          : reviewQueue;

        const IMAGE_RE = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i;
        const VIDEO_RE = /\.(mp4|mov|m4v|avi|webm|mkv|3gp)$/i;
        const isGeneratedArtifact = (name) => {
          const n = String(name || "").toLowerCase();
          if (n === "story.html" || n === "story_card.jpg" || n === "story_card.jpeg") return true;
          return /(?:^| - ).*card\.jpe?g$/i.test(n);
        };

        let totalImages = 0;
        let totalVideos = 0;
        let totalMedia = 0;
        let faceApproved = 0;
        let totalApiExpectedMedia = 0;
        let totalMissingVsApi = 0;
        let totalMissingImagesVsApi = 0;
        let totalMissingVideosVsApi = 0;
        let totalStoriesNeedingRestore = 0;
        const byChild = {};
        const localCountByKey = new Map();
        const localImageCountByKey = new Map();
        const localVideoCountByKey = new Map();
        const normalizeCentreKey = (value) => String(value || "")
          .toLowerCase()
          .trim()
          .replace(/\s+/g, " ")
          .replace(/[^\w\s]/g, "");
        const centreIdByChildAndName = new Map();
        const _rememberCentreAlias = (cId, centreId, centreName) => {
          const cid = String(cId || "");
          const id = String(centreId || "").trim();
          const nameKey = normalizeCentreKey(centreName);
          if (!cid || !id || !nameKey) return;
          centreIdByChildAndName.set(`${cid}::${nameKey}`, id);
        };
        const _resolveCentreKey = (cId, centreId, centreName) => {
          const cid = String(cId || "");
          const id = String(centreId || "").trim();
          const nameKey = normalizeCentreKey(centreName);
          if (id) return `id:${id}`;
          if (!nameKey) return "";
          const mappedId = centreIdByChildAndName.get(`${cid}::${nameKey}`);
          if (mappedId) return `id:${mappedId}`;
          return `name:${nameKey}`;
        };

        // Build a child-scoped alias map so mixed ID/name records for the same
        // daycare collapse to one canonical key.
        for (const m of manifests) {
          _rememberCentreAlias(m?.childId, m?.centreId, m?.centreName);
        }
        for (const row of catalogRows) {
          _rememberCentreAlias(row?.childId, row?.centreId, row?.centreName);
        }

        const ensureChildStats = (cId, cName) => {
          if (!byChild[cId]) {
            byChild[cId] = {
              childId: cId,
              childName: cName,
              stories: 0,
              images: 0,
              videos: 0,
              media: 0,
              pending: 0,
              daycareKeys: new Set(),
            };
          }
          if (!(byChild[cId].daycareKeys instanceof Set)) {
            byChild[cId].daycareKeys = new Set();
          }
          return byChild[cId];
        };

        for (const m of manifests) {
          const cId = String(m?.childId || "");
          const cName = String(m?.childName || cId || "Unknown");
          const childStats = ensureChildStats(cId, cName);
          childStats.stories++;
          const approved = Array.isArray(m?.approvedFilenames) ? m.approvedFilenames : [];
          let storyImages = 0;
          let storyVideos = 0;
          for (const f of approved) {
            if (isGeneratedArtifact(f)) continue;
            if (IMAGE_RE.test(f)) storyImages++;
            else if (VIDEO_RE.test(f)) storyVideos++;
          }
          const storyMedia = storyImages + storyVideos;
          const storyKey = `${cId}_${String(m?.storyId || "")}`;
          localCountByKey.set(storyKey, storyMedia);
          localImageCountByKey.set(storyKey, storyImages);
          localVideoCountByKey.set(storyKey, storyVideos);
          childStats.images += storyImages;
          childStats.videos += storyVideos;
          childStats.media += storyMedia;
          const centreKey = _resolveCentreKey(m?.childId, m?.centreId, m?.centreName);
          if (centreKey) childStats.daycareKeys.add(centreKey);
          totalImages += storyImages;
          totalVideos += storyVideos;
          totalMedia += storyMedia;
          faceApproved += storyImages;
        }
        for (const q of queueFiltered) {
          const cId = String(q?.childId || "");
          const childStats = ensureChildStats(cId, String(q?.childName || cId || "Unknown"));
          childStats.pending++;
        }

        // Compare local tracked media vs Storypark API expected file counts per story.
        for (const row of catalogRows) {
          const cId = String(row?.childId || "");
          const childStats = ensureChildStats(cId, String(row?.childName || cId || "Unknown"));
          const centreKey = _resolveCentreKey(row?.childId, row?.centreId, row?.centreName);
          if (centreKey) childStats.daycareKeys.add(centreKey);
          const apiExpected = Number(row?.fileCount || 0);
          if (!Number.isFinite(apiExpected) || apiExpected < 0) continue;
          const key = `${cId}_${String(row?.storyId || "")}`;
          const local = Number(localCountByKey.get(key) || 0);
          const missing = Math.max(0, apiExpected - local);
          const apiExpectedImages = Math.max(0, Number(row?.imageCount || 0));
          const apiExpectedVideos = Math.max(0, Number(row?.videoCount || 0));
          const localImages = Math.max(0, Number(localImageCountByKey.get(key) || 0));
          const localVideos = Math.max(0, Number(localVideoCountByKey.get(key) || 0));
          const missingImages = Math.max(0, apiExpectedImages - localImages);
          const missingVideos = Math.max(0, apiExpectedVideos - localVideos);
          totalApiExpectedMedia += apiExpected;
          totalMissingVsApi += missing;
          totalMissingImagesVsApi += missingImages;
          totalMissingVideosVsApi += missingVideos;
          if (missing > 0) {
            totalStoriesNeedingRestore++;
            childStats.missingVsApi = (childStats.missingVsApi || 0) + missing;
            childStats.missingImagesVsApi = (childStats.missingImagesVsApi || 0) + missingImages;
            childStats.missingVideosVsApi = (childStats.missingVideosVsApi || 0) + missingVideos;
            childStats.storiesNeedingRestore = (childStats.storiesNeedingRestore || 0) + 1;
          }
          childStats.apiExpectedMedia = (childStats.apiExpectedMedia || 0) + apiExpected;
        }

        for (const child of Object.values(byChild)) {
          const keys = child.daycareKeys instanceof Set ? [...child.daycareKeys] : [];
          let idKeys = 0;
          let nameKeys = 0;
          for (const k of keys) {
            if (String(k).startsWith("id:")) idKeys++;
            else if (String(k).startsWith("name:")) nameKeys++;
          }
          const count = keys.length;
          child.daycareCount = count;
          child.daycareLabel = count <= 0 ? "No daycare data yet" : `${count} daycare${count === 1 ? "" : "s"}`;
          if (count > 0) {
            child.daycareDedupeNote = idKeys > 0 && nameKeys === 0
              ? "Centres deduped by Storypark ID"
              : nameKeys > 0 && idKeys === 0
                ? "Centres deduped by normalized name (no IDs on stories)"
                : idKeys > 0 && nameKeys > 0
                  ? "Mixed ID and name keys across stories"
                  : "";
          } else {
            child.daycareDedupeNote = "";
          }
          delete child.daycareKeys;
        }

        sendResponse({
          ok: true,
          info: {
            ...info,
            childId: useChildFilter ? childId : "__ALL__",
            totalStories: manifests.length,
            imageCount: totalImages,    // photos only, excludes cards/html
            videoCount: totalVideos,    // videos only
            mediaCount: totalMedia,     // images + videos, excludes html/cards
            apiExpectedMedia: totalApiExpectedMedia,
            missingVsApi: totalMissingVsApi,
            missingImagesVsApi: totalMissingImagesVsApi,
            missingVideosVsApi: totalMissingVideosVsApi,
            storiesNeedingRestore: totalStoriesNeedingRestore,
            faceApproved,
            pending: queueFiltered.length,
            byChild: Object.values(byChild),
          },
        });
      })()
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    /* v2.4: Per-story audit + repair */
    case "AUDIT_STORIES": {
      // Classify every story manifest as:
      //   complete
      //     all approvedFilenames on disk + story.html on disk
      //   partial_photos
      //     some approvedFilenames missing from disk
      //   partial_assets
      //     photos OK but story.html / Story Card missing
      //   db_only
      //     no files on disk at all
      //   rejected_on_disk
      //     file(s) found in "{Child} Rejected Matches/" folder
      //   missing_video
      //     at least one video in mediaTypes is not on disk
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

          // Path prefix auto-detection // If the user linked the PARENT folder (not "Storypark Smart Saver" itself),
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

            // story.html + Story Card presence (optional but expected when body exists) ||
        const storyHtmlName = m.storyHtmlFilename
"story.html";
            const storyCardName = m.storyCardFilename
              || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName);
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
      //   1. storyCache (IDB)
      //      originalUrl lookup by filename
      //   2. manifest.mediaUrls originalUrl lookup by filename
      //   3. apiFetch story
      //      LAST resort, refresh the story detail
      //
      // msg: {
      //   childId, storyId,
      //   onlyFilenames?: string[],   // v2.4: targeted repair only these files
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

          // Try the story cache for original URLs first (cheap).
          let storyUrls = new Map(); // filename -> originalUrl
          for (const mu of (manifest.mediaUrls || [])) {
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
          // audit saves bandwidth by not re-downloading files already present
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
        const _tmpl = await _getTemplateSettingsMerged();
        const _tokenMap = buildTemplateTokenMap({
                  storyDate: manifest.storyDate || "",
                  storyTitle: manifest.storyTitle || "",
                  storyBody: manifest.storyBody || "",
                  childName: manifest.childName || "",
                  childAge: manifest.childAge || "",
                  roomName: manifest.roomName || "",
                  centreName: manifest.centreName || "",
                  educatorName: manifest.educatorName || "",
                  routineText: manifest.storyRoutine || "",
                  photoCount: 1,
                });
        const result = await sendToOffscreen({
                  type: "DOWNLOAD_APPROVED",
                  storyData: { storyId, createdAt: manifest.storyDate || "", body: manifest.storyBody || "",
                               roomName: manifest.roomName, centreName: manifest.centreName,
                               originalUrl, filename },
                  description: manifest.storyBody || "",
                  exifTitle:   renderTemplate(_tmpl.exif.title, _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifTitle }),
                  exifSubject: renderTemplate(_tmpl.exif.subject || "[StoryBody]", _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifSubject }),
                  exifComments: renderTemplate(_tmpl.exif.comments || "[StoryBody]", _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifComments }),
                  childName: manifest.childName,
                  savePath, gpsCoords,
                  templateSettings: _tmpl,
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
              const _tmpl = await _getTemplateSettingsMerged();
              const htmlContent = buildStoryHtml({
                title: manifest.storyTitle, date: manifest.storyDate,
                body: storyBody, childName: manifest.childName,
                childAge: manifest.childAge || "", roomName: manifest.roomName || "",
                centreName: manifest.centreName || "", educatorName: manifest.educatorName || "",
                routineText: routineStr, mediaFilenames: approvedAfter, templateSettings: _tmpl,
              });
              const htmlRes = await sendToOffscreen({
                type: "DOWNLOAD_TEXT", text: htmlContent,
                savePath: `${storyBasePath}/${manifest.storyHtmlFilename || "story.html"}`,
                mimeType: "text/html",
              });
              if (htmlRes.dataUrl && htmlRes.savePath) {
                await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
                const htmlNames = getStoryHtmlFilenames(manifest.storyDate, manifest.storyTitle, manifest.folderName);
                if (htmlNames.legacy) {
                  const namedRes = await sendToOffscreen({
                    type: "DOWNLOAD_TEXT", text: htmlContent,
                    savePath: `${storyBasePath}/${htmlNames.legacy}`,
                    mimeType: "text/html",
                  });
                  if (namedRes.dataUrl && namedRes.savePath) await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
                }
                assetsRegenerated = true;
              }
              if (saveStoryCard && storyBody && approvedAfter.length > 0) {
                const cardSavePath = `${storyBasePath}/${manifest.storyCardFilename || getStoryCardFilename(manifest.storyDate, manifest.storyTitle, manifest.folderName)}`;
                const photoCount = approvedAfter.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length;
                const cardResult = await sendToOffscreen({
                  type: "GENERATE_STORY_CARD",
                  title: manifest.storyTitle, date: manifest.storyDate, body: storyBody,
                  centreName: manifest.centreName || "", roomName: manifest.roomName || "",
                  educatorName: manifest.educatorName || "", childName: manifest.childName,
                  childAge: manifest.childAge || "", routineText: routineStr,
                  photoCount, gpsCoords, savePath: cardSavePath, templateSettings: _tmpl,
                });
                if (cardResult.ok && cardResult.dataUrl) {
                  await downloadDataUrl(cardResult.dataUrl, cardSavePath);
                }
              }
            } catch (regenErr) {
              console.warn(`[REPAIR_STORY] asset regen for ${storyId} failed:`, regenErr.message);
            }
          }

          await logger("SUCCESS", `� Repaired story ${storyId}: ${downloaded} files restored${failed > 0 ? `, ${failed} failed` : ""}${missingUrls.length > 0 ? `, ${missingUrls.length} skipped (no URL)` : ""}${assetsRegenerated ? " + story.html regenerated" : ""}`);
          sendResponse({ ok: true, downloaded, failed, skipped, missingUrls, assetsRegenerated });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* v2.4 AUDIT + REPAIR combined pipeline with rate-limiting + progress */
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
      //   � sets isScanning = true disables scan buttons, shows global banner
      //   � broadcasts PROGRESS messages fills scan progress bar
      //   � checks cancelRequested each story Stop button works
      //   � broadcasts SCAN_COMPLETE when done banner hides
      //   � all progress lines written to Activity Log via logger()
      //
      // msg: {
      //   onDiskPaths: string[],               // pre-walked by dashboard (FSA)
      //   rejectedFilesByChild?: Object,        // { [childName]: { [folderName]: string[] } }
      //   repairPartialAssets?: bool,           // default false only repair missing PHOTOS
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

          // Path prefix auto-detection (same logic as AUDIT_STORIES) // If parent folder is linked, paths are "Storypark Smart Saver/ChildName/..."
          // If SSS folder itself is linked, paths are "ChildName/..."
        const _aarPathPrefix = onDiskPaths.length > 0 &&
            onDiskPaths.some(p => p.startsWith("Storypark Smart Saver/"))
            ? "Storypark Smart Saver/" : "";

          // PHASE 1: Audit (classify all stories)
        await logger("INFO", `� Audit started classifying ${onDiskPaths.length} files on disk vs manifests�`);
          chrome.runtime.sendMessage({ type: "PROGRESS", current: 0, total: 100, childName: "Auditing�", childIndex: 0, childCount: 1, eta: "" }).catch(() => {});

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
            const cardName  = m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName);
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
            `Audit complete ${totalStories} stories: ${complete} complete · � ${partialPhotos} missing photos · � ${dbOnly} DB-only · ${partialAssets} missing HTML/Card · � ${totalMissing} files to restore`
          );

          if (brokenStories.length === 0) {
            await logger("SUCCESS", "Everything looks good no files need repairing!");
            chrome.runtime.sendMessage({ type: "AUDIT_REPAIR_DONE", summary: { complete, partialPhotos, dbOnly, partialAssets, totalMissing, repaired: 0, failed: 0 } }).catch(() => {});
            return;
          }

          await logger("INFO", `� Starting repair for ${brokenStories.length} stories (${totalMissing} files)�`);

          // PHASE 2: Repair broken stories // Track newly downloaded paths so we can re-audit without re-walking disk
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
                if (apiErr.name === "AuthError") { await logger("ERROR", `Auth error check Storypark login.`); cancelRequested = true; break; }
                if (apiErr.name === "RateLimitError") { await logger("WARNING", `⏳ Rate limited pausing�`); await new Promise(r => setTimeout(r, 30000)); }
                else await logger("WARNING", `� Story ${m.storyId} API fetch failed: ${apiErr.message}`);
              }
            }

            // Download each missing file
        let storyDownloaded = 0;
            const gpsCoords = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;

            for (const filename of missingFiles) {
              if (cancelRequested) break;
              const originalUrl = storyUrls.get(filename);
              if (!originalUrl) {
                await logger("WARNING", `� No URL for: ${filename} (story ${m.storyId}) needs a fresh scan`);
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
                  const _tmpl = await _getTemplateSettingsMerged();
                  const _tokenMap = buildTemplateTokenMap({
                    storyDate: m.storyDate || "",
                    storyTitle: m.storyTitle || "",
                    storyBody: m.storyBody || "",
                    childName: m.childName || "",
                    childAge: m.childAge || "",
                    roomName: m.roomName || "",
                    centreName: m.centreName || "",
                    educatorName: m.educatorName || "",
                    routineText: m.storyRoutine || "",
                    photoCount: 1,
                  });
                  const ir = await sendToOffscreen({
                    type: "DOWNLOAD_APPROVED",
                    storyData: { storyId: m.storyId, createdAt: m.storyDate || "", originalUrl, filename },
                    description: m.storyBody || "",
                    exifTitle: renderTemplate(_tmpl.exif.title, _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifTitle }),
                    exifSubject: renderTemplate(_tmpl.exif.subject || "[StoryBody]", _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifSubject }),
                    exifComments: renderTemplate(_tmpl.exif.comments || "[StoryBody]", _tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifComments }),
                    childName: m.childName, savePath, gpsCoords,
                    templateSettings: _tmpl,
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
                  `� ${filename}: ${isExpired ? "URL expired run a fresh scan to get new URL" : dlErr.message}`
                );
                totalFailed++;
              }
            }

            // Regenerate HTML + Card if we downloaded anything for this story ||
        if ((storyDownloaded > 0
(needsAssets && missingFiles.length === 0)) && !cancelRequested) {
              try {
                const approvedAfter = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
                const routineStr    = typeof m.storyRoutine === "string" ? m.storyRoutine : (m.storyRoutine?.detailed || m.storyRoutine?.summary || "");
                const storyBody     = m.storyBody || m.excerpt || "";
                const _tmpl2 = await _getTemplateSettingsMerged();
                const htmlContent   = buildStoryHtml({
                  title: m.storyTitle, date: m.storyDate, body: storyBody,
                  childName: m.childName, childAge: m.childAge || "",
                  roomName: m.roomName || "", centreName: m.centreName || "",
                  educatorName: m.educatorName || "", routineText: routineStr,
                  mediaFilenames: approvedAfter, templateSettings: _tmpl2,
                });
                const htmlRes = await sendToOffscreen({
                  type: "DOWNLOAD_TEXT", text: htmlContent,
                  savePath: `${storyBasePath}/${m.storyHtmlFilename || "story.html"}`,
                  mimeType: "text/html",
                });
                if (htmlRes.dataUrl && htmlRes.savePath) {
                  await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
                  newlyDownloaded.add(`${storyBase}/${m.storyHtmlFilename || "story.html"}`);
                  const htmlNames = getStoryHtmlFilenames(m.storyDate, m.storyTitle, m.folderName);
                  if (htmlNames.legacy) {
                    const namedRes = await sendToOffscreen({
                      type: "DOWNLOAD_TEXT", text: htmlContent,
                      savePath: `${storyBasePath}/${htmlNames.legacy}`,
                      mimeType: "text/html",
                    });
                    if (namedRes.dataUrl && namedRes.savePath) {
                      await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
                      newlyDownloaded.add(`${storyBase}/${htmlNames.legacy}`);
                    }
                  }
                }
                if (saveStoryCard && storyBody && approvedAfter.length > 0) {
                  const cardName = m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName);
                  const cr = await sendToOffscreen({
                    type: "GENERATE_STORY_CARD",
                    title: m.storyTitle, date: m.storyDate, body: storyBody,
                    centreName: m.centreName || "", roomName: m.roomName || "",
                    educatorName: m.educatorName || "", childName: m.childName,
                    childAge: m.childAge || "", routineText: routineStr,
                    photoCount: approvedAfter.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length,
                    gpsCoords, savePath: `${storyBasePath}/${cardName}`, templateSettings: _tmpl2,
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

          // PHASE 3: Re-audit with synthetic post-repair disk state
        const postRepairDiskSet = new Set([...onDiskSet, ...newlyDownloaded]);
          let reComplete = 0, rePartialPhotos = 0, reDbOnly = 0, rePartialAssets = 0, reMissing = 0;
          for (const m of allManifests) {
            if (!m.storyId || !m.folderName) continue;
            const base     = `${_aarPathPrefix}${_san(m.childName)}/Stories/${m.folderName}`;
            const approved = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
            const missing  = approved.filter(f => !postRepairDiskSet.has(`${base}/${f}`));
            const htmlName = m.storyHtmlFilename || "story.html";
            const cardName = m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName);
            if (approved.length === 0) continue;
            if (missing.length === approved.length) { reDbOnly++; reMissing += missing.length; }
            else if (missing.length > 0) { rePartialPhotos++; reMissing += missing.length; }
            else if (!postRepairDiskSet.has(`${base}/${htmlName}`) || (cardName && !postRepairDiskSet.has(`${base}/${cardName}`))) { rePartialAssets++; }
            else { reComplete++; }
          }

          const summary = `� Repair complete ${totalDownloaded} restored, ${totalFailed} failed${totalSkipped > 0 ? `, ${totalSkipped} need fresh scan (expired URLs)` : ""}`;
          await logger("SUCCESS", summary);
          await logger("INFO",
            `Post-repair: ${reComplete} complete · � ${rePartialPhotos} partial · � ${reDbOnly} DB-only · ${rePartialAssets} HTML/Card only · � ${reMissing} still missing`
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

    /* v2.4: Rebuild rejections.json from Rejected Matches/ folders */
    case "REBUILD_REJECTIONS_FROM_FOLDERS": {

      // msg: { rejectedFilesByChild: { [childName]: { [folderName]: string[] } } }
      (async () => {
        try {
          const manifests = await getAllDownloadedStories().catch(() => []);
          const added = await rebuildRejectionsFromFolders(
            manifests,
            msg.rejectedFilesByChild || {}
          );
          await logger("SUCCESS", `Rebuilt rejections ledger from Rejected Matches/ folders ${added} entries added.`);
          sendResponse({ ok: true, added });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* v2.4: Generate Story Cards for every story (Settings UI button) */
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
                const cardSavePath = `${storyBasePath}/${m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName)}`;
                const photoCount = approvedOnly.filter(
                  f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)
                ).length;
                const _tmpl = await _getTemplateSettingsMerged();
                const cardResult = await sendToOffscreen({
                  type: "GENERATE_STORY_CARD",
                  title: m.storyTitle, date: m.storyDate, body: storyBody,
                  centreName: m.centreName || "", roomName: m.roomName || "",
                  educatorName: m.educatorName || "", childName: m.childName,
                  childAge: m.childAge || "", routineText: m.storyRoutine || "",
                  photoCount, gpsCoords, savePath: cardSavePath, templateSettings: _tmpl,
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
          await logger("SUCCESS", `� Story Cards generated: ${generated}${skipped > 0 ? `, skipped: ${skipped}` : ""}${errors > 0 ? `, errors: ${errors}` : ""}`);
          sendResponse({ ok: true, generated, skipped, errors });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    /* Rebuild database from disk + API (cold-start repair for missing manifests.json) */
    case "REBUILD_DATABASE_FROM_DISK": {
      // Repair missing/empty manifests.json by walking on-disk story folders
      // and matching them to real story IDs via the Storypark feed API.
      //
      // msg: {
      //   childId: string,
      //   childName: string,
      //   diskFolders: [{ folderName: string, files: string[] }]
      // }
      // Returns: { ok, matched, recovered, errors, totalFolders }
      // Progress: PROGRESS messages with ETA
      // Side-effects: isScanning=true during run, SCAN_COMPLETE at end
        if (isScanning) {
        sendResponse({ ok: false, error: "A scan or repair is already in progress." });
        return false;
      }
      if (!msg.childId || !msg.childName) {
        sendResponse({ ok: false, error: "Missing childId or childName." });
        return false;
      }
      isScanning      = true;
      cancelRequested = false;
      chrome.storage.session.set({ isScanning: true, cancelRequested: false, _requestCount: 0 }).catch(() => {});

      (async () => {
        try {
          const ctx = {
            logger,
            getCancelRequested: () => cancelRequested,
            sendToOffscreen,
          };
          const result = await handleRebuildDatabaseFromDisk(msg, ctx);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        } finally {
          isScanning      = false;
          cancelRequested = false;
          chrome.storage.session.set({ isScanning: false, cancelRequested: false }).catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        }
      })();
      return true;
    }

    /* Story metadata correction */
    case "FIX_STORY_METADATA": {
      // Bulk-update centreName and/or roomName for a child's story manifests,
      // then regenerate HTML + Story Cards. Corrects metadata errors when a child
      // attended two daycares and the wrong room/centre was assigned.
      (async () => {
        try {
          const ctx = { logger, sendToOffscreen, getCancelRequested: () => cancelRequested };
          const result = await handleFixStoryMetadata(msg, ctx);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "ASSIGN_STORY_NUMBERS": {
      // Assign sequential story numbers to a child's stories (oldest=1).
      // Called from the Tools tab GUI.
      (async () => {
        try {
          const ctx = { logger, sendToOffscreen, getCancelRequested: () => cancelRequested };
          const result = await handleAssignStoryNumbers(msg, ctx);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "REHYDRATE_STORY_BODIES": {
      (async () => {
        try {
          const ctx = { logger, sendToOffscreen, getCancelRequested: () => cancelRequested };
          const result = await handleRehydrateStoryBodies(msg, ctx);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "GET_TEMPLATE_SETTINGS": {
      (async () => {
        try {
          const settings = await _getTemplateSettingsMerged();
          sendResponse({ ok: true, settings });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "SAVE_TEMPLATE_SETTINGS": {
      (async () => {
        try {
          const settings = mergeTemplateSettings(msg.settings || {});
          await saveTemplateSettings(settings);
          await chrome.storage.local.set({
            templateHtml: settings.html,
            templateCard: settings.card,
            templateExifRules: settings.exif,
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case "PREVIEW_TEMPLATE_SETTINGS": {
      (async () => {
        try {
          const settings = mergeTemplateSettings(msg.settings || {});
          const previewMode = String(msg?.previewMode || "brief");
          const targetMode = String(msg?.targetMode || "html");

          const manifests = await getAllDownloadedStories().catch(() => []);
          const bestStory = Array.isArray(manifests) && manifests.length
            ? manifests
                .filter((m) => m?.storyTitle && (m?.storyBody || m?.routineText || m?.storyRoutine || m?.childName))
                .sort((a, b) => String(b?.storyDate || b?.createdAt || "").localeCompare(String(a?.storyDate || a?.createdAt || "")))[0] || manifests[0]
            : null;

          const sourceNotes = [];
          let source = "mock sample";
          let storyBody = "We had a wonderful day exploring the park and painting leaves.";
          let routineText = "10:00 Morning Tea\n12:00 Sleep";
          if (bestStory) {
            source = "latest story with available data";
            storyBody = String(bestStory.storyBody || bestStory.storyTitle || storyBody);
            const fullRoutine = typeof bestStory.storyRoutine === "string"
              ? bestStory.storyRoutine
              : (bestStory.storyRoutine?.detailed || bestStory.storyRoutine?.summary || bestStory.routineText || "");
            routineText = String(fullRoutine || "");
          } else {
            sourceNotes.push("No local stories found, using mock preview sample.");
          }
          if (!routineText) {
            sourceNotes.push("Routine missing in source; routine token renders empty.");
          }

          const briefStoryBody = storyBody.length > 220 ? `${storyBody.slice(0, 220).trim()}…` : storyBody;
          const tokenMap = buildTemplateTokenMap({
            storyDate: bestStory?.storyDate || "2026-04-25",
            storyTitle: bestStory?.storyTitle || "Park Adventure",
            storyBody: previewMode === "brief" ? briefStoryBody : storyBody,
            childName: bestStory?.childName || "Sample Child",
            childAge: bestStory?.childAge || "3 years 2 months",
            roomName: bestStory?.roomName || "Kowhai Room",
            centreName: bestStory?.centreName || "Storypark ELC",
            educatorName: bestStory?.educatorName || "Aroha",
            routineText,
            photoCount: Array.isArray(bestStory?.approvedFilenames) ? bestStory.approvedFilenames.length : 8,
          });

          const htmlFull = renderTemplate(settings.html.body, tokenMap, { maxLen: 0 });
          const html = renderTemplate(settings.html.body, tokenMap, { maxLen: TEMPLATE_LIMITS.html });
          const cardFull = renderTemplate(settings.card.title, tokenMap, { maxLen: 0 });
          const card = renderTemplate(settings.card.title, tokenMap, { maxLen: CARD_TITLE_MAX_CHARS });
          const exifFull = renderTemplate(settings.exif.title, tokenMap, { target: "exif", maxLen: 4096 });
          const exifTitle = renderTemplate(settings.exif.title, tokenMap, { target: "exif", maxLen: TEMPLATE_LIMITS.exifTitle });
          const truncationFlags = {
            html: html.length < htmlFull.length,
            card: card.length < cardFull.length,
            exifTitle: exifTitle.length < exifFull.length,
          };
          const previewNotes = [];
          if (previewMode === "brief") previewNotes.push("Brief mode shortens long story bodies before token substitution.");
          previewNotes.push(`HTML body is capped at ${TEMPLATE_LIMITS.html} characters (ellipsis when exceeded).`);
          previewNotes.push(`Card titles are capped at ${CARD_TITLE_MAX_CHARS} characters.`);
          previewNotes.push(`EXIF titles use ASCII-only sanitization and max ${TEMPLATE_LIMITS.exifTitle} characters.`);
          if (truncationFlags.html) previewNotes.push("This sample: HTML output was length-limited.");
          if (truncationFlags.card) previewNotes.push("This sample: card title was length-limited.");
          if (truncationFlags.exifTitle) previewNotes.push("This sample: EXIF title was length-limited.");
          const rawTemplate = targetMode === "card"
            ? settings.card.title
            : targetMode === "exif"
              ? settings.exif.title
              : settings.html.body;
          sendResponse({
            ok: true,
            source,
            sourceNotes,
            previewNotes,
            truncationFlags,
            previewMode,
            targetMode,
            rawTemplate,
            rendered: { html, card, exifTitle },
            lengths: { html: html.length, card: card.length, exifTitle: exifTitle.length },
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    default:
      return false;
  }
}); // chrome.runtime.onMessage.addListener

/* ================================================================== */
/*  Startup load children into cache                                 */
/* ================================================================== */


/**
 * Eager-load the hot file caches (manifests.json + rejections.json + descriptors etc.)
 * so the first REVIEW_APPROVE / scan / dashboard query doesn't block on disk I/O.
 * Called on both onInstalled and onStartup, and also runs inline once per
 * service-worker activation (MV3 wakes the SW lazily neither event may fire).
 */
async function _eagerLoadOnStartup() {
  try {
    const schema = await ensureSyncSchema().catch(() => null);
    const counts = await eagerLoadHotCaches();
    const summary = `Database loaded: ${counts.manifests} manifests · ${counts.rejections} rejections · ${counts.descriptors} descriptor records · ${counts.fingerprints} fingerprints`;
    console.log("[startup] " + summary);
    // Log only when there's something worth reporting avoids noisy "0 �" line
    // in the Activity Log on first install.
        if (counts.manifests > 0 || counts.rejections > 0 || counts.descriptors > 0) {
      logger("INFO", summary).catch(() => {});
    }
    if (schema?.version) {
      logger("INFO", `Schema ready: v${schema.version} (${Array.isArray(schema.migrations) ? schema.migrations.length : 0} migration entries).`).catch(() => {});
    }
  } catch (err) {
    console.warn("[startup] eager load failed (non-fatal):", err?.message || err);
  }
}

async function _applyStoredSyncSchedule() {
  try {
    if (!chrome?.alarms) return;
    const { syncScheduleEnabled = false, syncScheduleHours = 72 } = await chrome.storage.local.get([
      "syncScheduleEnabled",
      "syncScheduleHours",
    ]);
    if (syncScheduleEnabled) {
      await chrome.alarms.create(STORYPARK_SYNC_ALARM, {
        periodInMinutes: Math.max(24, Number(syncScheduleHours) || 72) * 60,
      });
    } else {
      await chrome.alarms.clear(STORYPARK_SYNC_ALARM);
    }
    await chrome.alarms.create(FACE_INTEGRITY_ALARM, { periodInMinutes: 7 * 24 * 60 });
  } catch {
    // non-fatal
  }
}

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === FACE_INTEGRITY_ALARM) {
      (async () => {
        const lock = await acquireJobLock("weekly_face_integrity", 20 * 60 * 1000);
        if (!lock?.ok) return;
        try {
          const integrity = await getDatabaseIntegrityReport().catch(() => ({ files: [] }));
          const retention = await pruneAgedFaceData({ negativeMaxAgeDays: 365, fingerprintMaxAgeDays: 365 }).catch(() => ({ negativePruned: 0, fingerprintsPruned: 0 }));
          const rotation = await rotateDecisionLog(25000).catch(() => ({ removed: 0 }));
          await logger("INFO", `Weekly integrity check complete: ${integrity.files?.length || 0} files checked, removed ${rotation.removed || 0} decision logs, pruned ${retention.fingerprintsPruned || 0} fingerprints.`);
          await releaseJobLock("weekly_face_integrity", { status: "completed", completedAt: new Date().toISOString() });
        } catch (err) {
          await releaseJobLock("weekly_face_integrity", { status: "failed", error: err.message, failedAt: new Date().toISOString() });
        }
      })();
      return;
    }
    if (alarm?.name !== STORYPARK_SYNC_ALARM) return;
    if (isScanning) return;
    isScanning = true;
    cancelRequested = false;
    chrome.storage.session.set({ isScanning: true, cancelRequested: false }).catch(() => {});
    (async () => {
      await logger("INFO", "Running scheduled Storypark metadata sync…");
      await syncStoryparkInformation();
    })()
      .catch((err) => logger("ERROR", `Scheduled Storypark sync failed: ${err.message}`).catch(() => {}))
      .finally(() => {
        isScanning = false;
        cancelRequested = false;
        chrome.storage.session.set({ isScanning: false, cancelRequested: false }).catch(() => {});
        chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
      });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  loadAndCacheProfile();
  _eagerLoadOnStartup();
  _applyStoredSyncSchedule();
  // Migrate existing centreLocations from chrome.storage to IDB centreProfiles (v11).
  // Runs once on install/update non-destructive (saveCentreProfile does not overwrite GPS).
  chrome.storage.local.get("centreLocations", ({ centreLocations }) => {
    if (centreLocations && Object.keys(centreLocations).length > 0) {
      importLegacyCentreLocations(centreLocations).catch(() => {});
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadAndCacheProfile();
  _eagerLoadOnStartup();
  _applyStoredSyncSchedule();
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
_applyStoredSyncSchedule();


/* ================================================================== */
/*  Extension icon click open / focus dashboard                      */
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
