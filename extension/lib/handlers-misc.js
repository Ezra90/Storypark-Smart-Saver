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
 *   REWRITE_EXIF_ONLY, GENERATE_STORY_CARD, GENERATE_STORY_CARD_SINGLE,
 *   REHYDRATE_STORY_BODIES
 */

import {
  getDownloadedStories, addDownloadedStory, getAllDownloadedStories,
  getStoryDetailRecords, getCachedStory, getRoutineSnapshotRecords,
  countImageFingerprints, countCachedStories,
  clearAllImageFingerprints, clearAllCachedStories,
  clearAllRejections,
  getActiveDatabaseInfo,
  markFilenameApprovedInManifest,
  assignStoryNumbers,
  getCentreGPS,
} from "./db.js";
import { normaliseStoryText, stripHtml } from "./metadata-helpers.js";
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

/* ================================================================== */
/*  Story metadata correction                                          */
/* ================================================================== */

/**
 * FIX_STORY_METADATA — Bulk-update centreName and/or roomName for a child's
 * story manifests, then optionally regenerate HTML + Story Cards.
 *
 * This allows correcting metadata mistakes (e.g. wrong centre/room assigned
 * when a child attended two daycares) without running a full rescan.
 *
 * @param {{
 *   childId:       string,
 *   childName:     string,
 *   centreName?:   string    — New centre name (null = leave unchanged)
 *   roomName?:     string    — New room name   (null = leave unchanged, "" = clear)
 *   dateFrom?:     string    — YYYY-MM-DD start of date range (inclusive)
 *   dateTo?:       string    — YYYY-MM-DD end of date range (inclusive)
 *   regenerateHtml?: boolean — Rebuild story.html + Story Card after patching
 * }} msg
 */
export async function handleFixStoryMetadata(msg, ctx) {
  try {
    const {
      childId, childName,
      centreName: newCentre = null,
      roomName:   newRoom   = null,
      dateFrom = null,
      dateTo   = null,
      regenerateHtml = true,
    } = msg;

    if (!childId) return { ok: false, error: "Missing childId" };
    if (newCentre === null && newRoom === null) return { ok: false, error: "Nothing to change — provide centreName and/or roomName" };

    const manifests = await getDownloadedStories(childId);
    let updated = 0;
    const updatedManifests = [];

    for (const m of manifests) {
      // Apply date range filter
      if (dateFrom && m.storyDate && m.storyDate < dateFrom) continue;
      if (dateTo   && m.storyDate && m.storyDate > dateTo)   continue;

      let changed = false;
      const patched = { ...m };

      if (newCentre !== null && patched.centreName !== newCentre) {
        patched.centreName = newCentre;
        changed = true;
      }
      if (newRoom !== null && patched.roomName !== newRoom) {
        patched.roomName = newRoom;
        changed = true;
      }

      if (changed) {
        await addDownloadedStory(patched).catch(() => {});
        updatedManifests.push(patched);
        updated++;
      }
    }

    await ctx.logger("SUCCESS", `✏️ Metadata updated for ${updated} stories${childName ? ` (${childName})` : ""}${newCentre ? ` → Centre: "${newCentre}"` : ""}${newRoom !== null ? ` → Room: "${newRoom || "(cleared)"}"` : ""}`);

    // Optionally regenerate HTML + Story Cards for all updated stories
    if (regenerateHtml && updatedManifests.length > 0 && ctx.sendToOffscreen) {
      const { saveStoryCard = true } = await chrome.storage.local.get("saveStoryCard");
      let htmlBuilt = 0, cardBuilt = 0;

      for (const m of updatedManifests) {
        try {
          const { downloadDataUrl: _dl, downloadHtmlFile: _dh } = await import("./download-pipe.js");
          const { buildStoryPage: _bp, getStoryHtmlFilenames: _getHtmlNames, getStoryCardFilename: _getCardName } = await import("./html-builders.js");
          const { sanitizeName: _sn } = await import("./metadata-helpers.js");

          const storyBasePath = `Storypark Smart Saver/${_sn(m.childName)}/Stories/${m.folderName}`;
          const rejectedSet   = new Set(m.rejectedFilenames || []);
          const approvedOnly  = (m.approvedFilenames || []).filter(f => !rejectedSet.has(f));
          if (approvedOnly.length === 0) continue;

          const routineStr = typeof m.storyRoutine === "string" ? m.storyRoutine : (m.storyRoutine?.detailed || m.storyRoutine?.summary || "");
          const htmlContent = _bp({
            title: m.storyTitle, date: m.storyDate, body: m.storyBody || "",
            childName: m.childName, childAge: m.childAge || "",
            roomName: m.roomName || "", centreName: m.centreName || "",
            educatorName: m.educatorName || "", routineText: routineStr,
            mediaFilenames: approvedOnly,
          });
          const htmlNames = _getHtmlNames(m.storyDate, m.storyTitle, m.folderName);
          const htmlRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${htmlNames.primary}`, mimeType: "text/html" });
          if (htmlRes?.dataUrl && htmlRes?.savePath) {
            await _dh(htmlRes.dataUrl, htmlRes.savePath);
            if (htmlNames.legacy) {
              const namedRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${htmlNames.legacy}`, mimeType: "text/html" });
              if (namedRes?.dataUrl && namedRes?.savePath) await _dh(namedRes.dataUrl, namedRes.savePath);
            }
            htmlBuilt++;
          }

          if (saveStoryCard && m.storyBody && approvedOnly.length > 0) {
            const gpsCoords = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;
            const cardPath  = `${storyBasePath}/${m.storyCardFilename || _getCardName(m.storyDate, m.storyTitle, m.folderName)}`;
            const cr = await ctx.sendToOffscreen({ type: "GENERATE_STORY_CARD", title: m.storyTitle, date: m.storyDate, body: m.storyBody, centreName: m.centreName || "", roomName: m.roomName || "", educatorName: m.educatorName || "", childName: m.childName, childAge: m.childAge || "", routineText: routineStr, photoCount: approvedOnly.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length, gpsCoords, savePath: cardPath });
            if (cr?.ok && cr?.dataUrl) { await _dl(cr.dataUrl, cardPath); cardBuilt++; }
          }
        } catch (err) {
          console.warn("[handleFixStoryMetadata] regen failed for", m.storyId, err.message);
        }
      }

      await ctx.logger("INFO", `📄 Regenerated ${htmlBuilt} story pages + ${cardBuilt} Story Cards with corrected metadata.`);
    }

    return { ok: true, updated, regenerated: regenerateHtml ? updatedManifests.length : 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * REHYDRATE_STORY_BODIES — One-time repair that restores improved story-body
 * formatting in existing manifests using story_details/cache (no API rescan).
 *
 * @param {{
 *   childId?: string,
 *   regenerateHtml?: boolean,
 *   regenerateCards?: boolean
 * }} msg
 */
export async function handleRehydrateStoryBodies(msg, ctx) {
  try {
    const {
      childId = null,
      regenerateHtml = true,
      regenerateCards = false,
    } = msg || {};

    const manifests = childId
      ? await getDownloadedStories(String(childId))
      : await getAllDownloadedStories();
    if (!Array.isArray(manifests) || manifests.length === 0) {
      return { ok: true, scanned: 0, updated: 0, regeneratedHtml: 0, regeneratedCards: 0 };
    }

    const details = await getStoryDetailRecords(childId ? String(childId) : null).catch(() => []);
    const routineRows = await getRoutineSnapshotRecords(childId ? String(childId) : null).catch(() => []);
    const detailMap = new Map();
    for (const d of (details || [])) {
      const key = d?.key || `${d?.childId || ""}_${d?.storyId || ""}`;
      if (key) detailMap.set(String(key), d);
    }
    const routineMap = new Map();
    for (const r of (routineRows || [])) {
      const key = `${r?.childId || ""}_${r?.storyDate || ""}`;
      if (!key) continue;
      const text = (r?.routineDetailed || r?.routineSummary || "").trim();
      if (text) routineMap.set(key, text);
    }

    const updatedManifests = [];
    let updated = 0;
    for (const m of manifests) {
      const key = `${m.childId}_${m.storyId}`;
      const d = detailMap.get(key) || null;
      const cached = (!d && m.storyId) ? await getCachedStory(String(m.storyId)).catch(() => null) : null;

      const rawBody =
        d?.rawDisplayContent ?? d?.display_content ?? d?.storyBody ?? d?.body ??
        cached?.display_content ?? cached?.body ?? cached?.excerpt ??
        m.storyBody ?? m.excerpt ?? "";
      const repairedBody = normaliseStoryText(rawBody);
      const routineText = (m?.storyRoutine || "").trim() || routineMap.get(`${m.childId}_${m.storyDate}`) || "";
      if (!repairedBody && !routineText) continue;

      if ((m.storyBody || "") !== repairedBody || ((m.storyRoutine || "").trim() !== routineText.trim())) {
        const patched = {
          ...m,
          storyBody: repairedBody || m.storyBody || "",
          excerpt: stripHtml(repairedBody || m.storyBody || "").slice(0, 200),
          storyRoutine: routineText || m.storyRoutine || "",
        };
        await addDownloadedStory(patched).catch(() => {});
        updatedManifests.push(patched);
        updated++;
      }
    }

    let regeneratedHtmlCount = 0;
    let regeneratedCardCount = 0;
    if (updatedManifests.length > 0 && ctx.sendToOffscreen && (regenerateHtml || regenerateCards)) {
      const { downloadDataUrl: _dl, downloadHtmlFile: _dh } = await import("./download-pipe.js");
      const { buildStoryPage: _bp, getStoryHtmlFilenames: _getHtmlNames, getStoryCardFilename: _getCardName } = await import("./html-builders.js");
      const { sanitizeName: _sn } = await import("./metadata-helpers.js");
      const { saveStoryCard = true } = await chrome.storage.local.get("saveStoryCard");

      for (const m of updatedManifests) {
        const storyBasePath = `Storypark Smart Saver/${_sn(m.childName)}/Stories/${m.folderName}`;
        const rejectedSet = new Set(m.rejectedFilenames || []);
        const approvedOnly = (m.approvedFilenames || []).filter((f) => !rejectedSet.has(f));
        if (approvedOnly.length === 0) continue;

        const routineStr = typeof m.storyRoutine === "string" ? m.storyRoutine : (m.storyRoutine?.detailed || m.storyRoutine?.summary || "");

        if (regenerateHtml) {
          try {
            const htmlContent = _bp({
              title: m.storyTitle, date: m.storyDate, body: m.storyBody || "",
              childName: m.childName, childAge: m.childAge || "",
              roomName: m.roomName || "", centreName: m.centreName || "",
              educatorName: m.educatorName || "", routineText: routineStr,
              mediaFilenames: approvedOnly,
            });
            const htmlNames = _getHtmlNames(m.storyDate, m.storyTitle, m.folderName);
            const htmlRes = await ctx.sendToOffscreen({
              type: "DOWNLOAD_TEXT",
              text: htmlContent,
              savePath: `${storyBasePath}/${htmlNames.primary}`,
              mimeType: "text/html",
            });
            if (htmlRes?.dataUrl && htmlRes?.savePath) {
              await _dh(htmlRes.dataUrl, htmlRes.savePath);
              if (htmlNames.legacy) {
                const namedRes = await ctx.sendToOffscreen({
                  type: "DOWNLOAD_TEXT",
                  text: htmlContent,
                  savePath: `${storyBasePath}/${htmlNames.legacy}`,
                  mimeType: "text/html",
                });
                if (namedRes?.dataUrl && namedRes?.savePath) await _dh(namedRes.dataUrl, namedRes.savePath);
              }
              regeneratedHtmlCount++;
            }
          } catch (err) {
            console.warn("[handleRehydrateStoryBodies] HTML regen failed for", m.storyId, err.message);
          }
        }

        if (regenerateCards && saveStoryCard && m.storyBody) {
          try {
            const gpsCoords = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;
            const cardPath = `${storyBasePath}/${m.storyCardFilename || _getCardName(m.storyDate, m.storyTitle, m.folderName)}`;
            const cr = await ctx.sendToOffscreen({
              type: "GENERATE_STORY_CARD",
              title: m.storyTitle,
              date: m.storyDate,
              body: m.storyBody,
              centreName: m.centreName || "",
              roomName: m.roomName || "",
              educatorName: m.educatorName || "",
              childName: m.childName,
              childAge: m.childAge || "",
              routineText: routineStr,
              photoCount: approvedOnly.filter((f) => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length,
              gpsCoords,
              savePath: cardPath,
            });
            if (cr?.ok && cr?.dataUrl) {
              await _dl(cr.dataUrl, cardPath);
              regeneratedCardCount++;
            }
          } catch (err) {
            console.warn("[handleRehydrateStoryBodies] card regen failed for", m.storyId, err.message);
          }
        }
      }
    }

    await ctx.logger(
      "SUCCESS",
      `🧩 Rehydrate complete: ${updated}/${manifests.length} story manifests repaired from cached details.`
    );
    return {
      ok: true,
      scanned: manifests.length,
      updated,
      regeneratedHtml: regeneratedHtmlCount,
      regeneratedCards: regeneratedCardCount,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * ASSIGN_STORY_NUMBERS — Trigger manual story number assignment for a child.
 * Numbers stories oldest→newest (oldest=1). Called from Tools tab GUI.
 *
 * @param {{ childId: string }} msg
 */
export async function handleAssignStoryNumbers(msg, ctx) {
  try {
    const childId = msg.childId ? String(msg.childId) : null;
    if (!childId) {
      // Number all children
      const { children = [] } = await chrome.storage.local.get("children");
      let total = 0;
      for (const child of children) {
        const n = await assignStoryNumbers(child.id).catch(() => 0);
        total += n;
      }
      await ctx.logger("SUCCESS", `🔢 Story numbers assigned for all children: ${total} stories numbered.`);
      return { ok: true, numbered: total };
    }
    const numbered = await assignStoryNumbers(childId);
    await ctx.logger("SUCCESS", `🔢 Story numbers assigned: ${numbered} stories numbered oldest→newest.`);
    return { ok: true, numbered };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
