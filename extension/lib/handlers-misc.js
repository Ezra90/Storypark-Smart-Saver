/**
 * handlers-misc.js — Miscellaneous utility message handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  Small utility handlers that don't fit a specific domain file.     │
 * │  Each handler here is < 30 lines; larger handlers go in their own  │
 * │  domain file (see .clinerules for the threshold rule).             │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Audit/repair → lib/handlers-audit.js                              │
 * │  HTML/downloads → lib/handlers-html.js                             │
 * │  Backup → lib/handlers-backup.js                                   │
 * │  Face phases → lib/handlers-phase.js                               │
 * │  Review queue → lib/handlers-review.js                             │
 * │  Debug log → lib/handlers-debug.js                                 │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   TEST_CONNECTION, DISCOVER_CENTRES, GET_DOWNLOADED_STORIES,
 *   ADD_FILE_TO_MANIFEST, GET_CACHE_STATS, CLEAR_CACHES,
 *   CLEAR_ALL_REJECTIONS, RECYCLE_OFFSCREEN, ACTIVE_DATABASE_INFO,
 *   GET_ACTIVITY_LOG, CLEAR_ACTIVITY_LOG, LOG_TO_ACTIVITY,
 *   REWRITE_EXIF_ONLY, GENERATE_STORY_CARD, GENERATE_STORY_CARD_SINGLE
 */

import {
  getDownloadedStories, addDownloadedStory,
  countImageFingerprints, countCachedStories,
  clearAllImageFingerprints, clearAllCachedStories,
  clearAllRejections,
  getActiveDatabaseInfo,
  markFilenameApprovedInManifest,
} from "./db.js";
import { apiFetch, STORYPARK_BASE } from "./api-client.js";
import { getActivityLog, clearActivityLog } from "./log-manager.js";
import { requireId } from "./msg-validator.js";
import { fetchUserProfile } from "./storypark-api.js";
import { validateLevel } from "./msg-validator.js";

/* ================================================================== */
/*  Connection + profile                                               */
/* ================================================================== */

/**
 * TEST_CONNECTION — Verify Storypark session is active.
 */
export async function handleTestConnection(msg, ctx) {
  try {
    const data  = await apiFetch(`${STORYPARK_BASE}/api/v3/users/me`);
    const email = data?.user?.email || data?.email || "";
    return { ok: true, email };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * DISCOVER_CENTRES — Trigger centre discovery from all Storypark API endpoints.
 * Calls fetchUserProfile() which also triggers fetchCentres() and fetchFamilyCentres().
 */
export async function handleDiscoverCentres(msg, ctx) {
  try {
    await fetchUserProfile();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Story manifest utilities                                           */
/* ================================================================== */

/**
 * GET_DOWNLOADED_STORIES — Return manifests for one child.
 */
export async function handleGetDownloadedStories(msg, ctx) {
  try {
    const childId = msg.childId ? String(msg.childId) : null;
    const stories = childId ? await getDownloadedStories(childId) : [];
    return { ok: true, stories };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * ADD_FILE_TO_MANIFEST — Re-add a filename to a story's approvedFilenames.
 * Used when a rescued-from-rejected photo is approved in Review tab.
 */
export async function handleAddFileToManifest(msg, ctx) {
  try {
    const childId  = requireId(msg.childId,  "childId");
    const storyId  = requireId(msg.storyId,  "storyId");
    const filename = requireId(msg.filename, "filename");

    // markFilenameApprovedInManifest atomically:
    //   - removes filename from rejectedFilenames[]  (fixes rescued-file data integrity bug)
    //   - adds filename to approvedFilenames[]
    //   - updates thumbnailFilename if empty
    //   - writes to file cache + IDB
    const changed = await markFilenameApprovedInManifest(childId, storyId, filename);
    return { ok: true, changed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Cache utilities                                                    */
/* ================================================================== */

/**
 * GET_CACHE_STATS — Return counts of fingerprint cache + story cache entries.
 */
export async function handleGetCacheStats(msg, ctx) {
  try {
    const fingerprints = await countImageFingerprints();
    const stories      = await countCachedStories();
    return { ok: true, fingerprints, stories };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * CLEAR_CACHES — Clear fingerprint cache, story cache, or both.
 *
 * @param {{ which?: "fingerprints"|"stories"|"all" }} msg
 */
export async function handleClearCaches(msg, ctx) {
  try {
    const which = msg.which || "all";
    if (which === "fingerprints" || which === "all") await clearAllImageFingerprints();
    if (which === "stories"      || which === "all") await clearAllCachedStories();
    await ctx.logger("INFO", `🗑 Cache cleared: ${which}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * CLEAR_ALL_REJECTIONS — Remove all rejection records so previously-rejected
 * photos can be re-evaluated on the next scan.
 */
export async function handleClearAllRejections(msg, ctx) {
  try {
    await clearAllRejections();
    await ctx.logger("INFO", "🔄 All rejected image records cleared — next scan will re-evaluate them.");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Offscreen lifecycle                                               */
/* ================================================================== */

/**
 * RECYCLE_OFFSCREEN — Close and re-create the offscreen document.
 * Called every ~50 photos during offline scans to flush TF.js GPU memory.
 */
export async function handleRecycleOffscreen(msg, ctx) {
  try {
    await chrome.offscreen.closeDocument().catch(() => {});
    // background.js will reset offscreenReady after receiving this handler's return
    return { ok: true, recycled: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Database info                                                     */
/* ================================================================== */

/**
 * ACTIVE_DATABASE_INFO — Return info about the Database/ folder files.
 * Shows which JSON files exist, their sizes, and last update time.
 */
export async function handleActiveDatabaseInfo(msg, ctx) {
  try {
    const info = await getActiveDatabaseInfo();
    return { ok: true, info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Activity log                                                      */
/* ================================================================== */

/**
 * GET_ACTIVITY_LOG — Return the persisted user-facing activity log.
 */
export async function handleGetActivityLog(msg, ctx) {
  try {
    const activityLog = await getActivityLog();
    return { ok: true, activityLog };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * CLEAR_ACTIVITY_LOG — Clear the persisted activity log from storage.
 * Does NOT affect Database/activity_log.jsonl on disk.
 */
export async function handleClearActivityLog(msg, ctx) {
  try {
    await clearActivityLog();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * LOG_TO_ACTIVITY — Write a structured entry to the activity log.
 * Called from dashboard.js for operations that run in the page context
 * (Rewrite Metadata, Repair Database, Reconcile, etc.).
 *
 * @param {{ level: string, message: string, storyDate?: string, meta?: Object }} msg
 */
export async function handleLogToActivity(msg, ctx) {
  try {
    const level   = validateLevel(msg.level);
    const message = (msg.message || "").trim();
    if (message) {
      await ctx.logger(level, message, msg.storyDate || null, msg.meta || null);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Offscreen forwarding (trivial: just route to offscreen)           */
/* ================================================================== */

/**
 * REWRITE_EXIF_ONLY — Re-stamp EXIF + IPTC on an already-downloaded JPEG.
 * Routes directly to offscreen; response shape is { ok, dataUrl, readBack }.
 */
export async function handleRewriteExifOnly(msg, ctx) {
  try {
    return await ctx.sendToOffscreen(msg);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * GENERATE_STORY_CARD — Render a story card JPEG using Canvas API (offscreen).
 * Routes directly to offscreen; response shape is { ok, dataUrl, savePath }.
 */
export async function handleGenerateStoryCard(msg, ctx) {
  try {
    return await ctx.sendToOffscreen(msg);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
