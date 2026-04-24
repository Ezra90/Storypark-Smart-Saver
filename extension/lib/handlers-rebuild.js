/**
 * handlers-rebuild.js — Rebuild database from on-disk files + Storypark API
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  The REBUILD_DATABASE_FROM_DISK pipeline. Repairs a missing or     │
 * │  corrupt manifests.json by scanning already-downloaded story       │
 * │  folders on disk and matching them to real story IDs via the       │
 * │  Storypark feed API.                                               │
 * │                                                                    │
 * │  WHY THIS FILE EXISTS: handlers-audit.js is at its 600-line       │
 * │  limit. Rebuild is a separate domain (cold-start DB repair vs      │
 * │  ongoing audit/repair of a populated DB).                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Audit/repair of partially-downloaded stories → handlers-audit.js  │
 * │  HTML regeneration → handlers-html.js                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   REBUILD_DATABASE_FROM_DISK
 */

import { apiFetch, smartDelay, STORYPARK_BASE, AuthError, RateLimitError } from "./api-client.js";
import {
  addDownloadedStory, markStoryProcessed, getAllDownloadedStories,
} from "./db.js";
import { rebuildIndexPages } from "./handlers-html.js";
import { sanitizeName, formatDateDMY, formatETA } from "./metadata-helpers.js";

/* ================================================================== */
/*  Title-matching helpers                                             */
/* ================================================================== */

/**
 * Normalise a title for fuzzy comparison.
 * Lowercases, strips punctuation/emoji, collapses whitespace, truncates to 60 chars.
 *
 * @param {string} title
 * @returns {string}
 */
function _normTitle(title) {
  return (title || "")
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, "") // strip common emoji ranges
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")   // replace all non-alphanumeric with space
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim()
    .substring(0, 60);
}

/**
 * Compare a disk folder name to an API story title.
 * Folder format: "YYYY-MM-DD - {sanitized title (max 50 chars)}"
 *
 * Returns a confidence score 0–1:
 *   1.0 = perfect match
 *   0.9 = prefix match (truncation artefact)
 *   0.7+ = acceptable word overlap
 *   <0.6 = poor match
 *
 * @param {string} folderName
 * @param {string} apiTitle
 * @returns {number}
 */
function _titleMatchScore(folderName, apiTitle) {
  // Strip the "YYYY-MM-DD - " prefix from the folder name
  const titlePart = folderName.replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, "").trim();
  const normFolder = _normTitle(titlePart);
  const normApi    = _normTitle(apiTitle);

  if (!normFolder || !normApi) return 0;
  if (normFolder === normApi) return 1.0;

  // Prefix match: the folder name is truncated at 50 chars by sanitizeName()
  // so the folder title may be a prefix of the full API title
  if (normApi.startsWith(normFolder) && normFolder.length >= 8) return 0.9;
  if (normFolder.startsWith(normApi) && normApi.length >= 8) return 0.9;

  // Word overlap: count how many significant words (>2 chars) are shared
  const fWords = normFolder.split(" ").filter(w => w.length > 2);
  const aWords = new Set(normApi.split(" ").filter(w => w.length > 2));
  if (fWords.length === 0) return 0;
  const matching = fWords.filter(w => aWords.has(w)).length;
  return matching / Math.max(fWords.length, aWords.size);
}

/* ================================================================== */
/*  REBUILD_DATABASE_FROM_DISK                                         */
/* ================================================================== */

/**
 * Rebuild manifests.json + processedStories from already-downloaded story folders.
 *
 * Use-case: user has all 500+ story folders on disk but the Database/ JSON files
 * are missing or from an old extension version that didn't write them.  Without
 * this, the next scan re-processes all 500 stories from scratch (hours of work).
 *
 * Algorithm:
 *   1. Fetch the complete story feed from the Storypark API (all pages).
 *      ~26 pages for 501 stories ≈ 30 s with rate-limiting.
 *   2. Build a date → [{ id, created_at, title }] map from the feed.
 *   3. For each disk folder (format: "YYYY-MM-DD - {sanitized title}"):
 *      a. Extract date from folder name.
 *      b. Find API stories on ±1 day of that date.
 *      c. Pick the best title match (score ≥ 0.6).
 *      d. If matched: create manifest entry with real storyId + mark processed.
 *      e. If unmatched: create recovered_ manifest entry.
 *   4. After all folders: rebuild HTML index pages.
 *
 * Anti-abuse: uses smartDelay("FEED_SCROLL") before every feed page API call.
 * Progress: sends PROGRESS messages with ETA.
 * Cancel: checks ctx.getCancelRequested() each folder.
 *
 * @param {{ childId: string, childName: string, diskFolders: Array<{folderName: string, files: string[]}> }} msg
 * @param {import('./types.js').HandlerContext} ctx
 * @returns {Promise<{ ok: boolean, matched: number, recovered: number, errors: number, totalFolders: number }>}
 */
export async function handleRebuildDatabaseFromDisk(msg, ctx) {
  const { childId, childName, diskFolders = [] } = msg;

  if (!childId || !childName) {
    return { ok: false, error: "Missing childId or childName." };
  }
  if (diskFolders.length === 0) {
    return { ok: true, matched: 0, recovered: 0, errors: 0, totalFolders: 0 };
  }

  const totalFolders = diskFolders.length;
  let matched = 0, recovered = 0, errors = 0;

  try {
    await ctx.logger("INFO", `🔄 Rebuilding database for ${childName}: scanning ${totalFolders} story folders…`);

    // ── Phase 1: Fetch complete story feed from API ───────────────────
    // Paginate the story feed to collect { id, created_at, title } for all stories.
    // Uses smartDelay("FEED_SCROLL") before each page — anti-abuse mandatory.
    await ctx.logger("INFO", "📡 Fetching story list from Storypark API…");

    /** @type {Map<string, Array<{id: string, created_at: string, title: string}>>} */
    const byDate = new Map(); // YYYY-MM-DD → [{id, created_at, title}]
    let pageToken = null;
    let feedPages = 0;
    const _feedStart = Date.now();

    while (true) {
      if (ctx.getCancelRequested()) {
        await ctx.logger("WARNING", "⏸ Rebuild cancelled during feed fetch.");
        return { ok: false, error: "cancelled", matched, recovered, errors, totalFolders };
      }

      if (feedPages > 0) await smartDelay("FEED_SCROLL");

      const url = new URL(`${STORYPARK_BASE}/api/v3/children/${childId}/stories`);
      url.searchParams.set("sort_by", "updated_at");
      url.searchParams.set("story_type", "all");
      if (pageToken) url.searchParams.set("page_token", pageToken);

      let data;
      try {
        data = await apiFetch(url.toString());
      } catch (err) {
        if (err.name === "AuthError") {
          await ctx.logger("ERROR", `🛑 Auth error during feed fetch — check Storypark login.`);
          return { ok: false, error: "auth", matched, recovered, errors, totalFolders };
        }
        if (err.name === "RateLimitError") {
          await ctx.logger("WARNING", `⏳ Rate limited during feed fetch — pausing 30s…`);
          await new Promise(r => setTimeout(r, 30000));
          continue; // retry same page
        }
        throw err;
      }

      const stories = data.stories || data.items || [];
      for (const s of stories) {
        const date = s.created_at ? s.created_at.split("T")[0] : null;
        if (!date) continue;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push({
          id:         String(s.id),
          created_at: s.created_at || "",
          title:      s.title || s.display_title || s.excerpt || "",
        });
      }

      pageToken = data.next_page_token || null;
      feedPages++;
      await ctx.logger("INFO", `  Page ${feedPages}: ${byDate.size} dates found so far…`);
      if (!pageToken) break;
    }

    const totalApiStories = [...byDate.values()].reduce((s, arr) => s + arr.length, 0);
    await ctx.logger("INFO", `✅ Feed loaded: ${totalApiStories} stories across ${byDate.size} dates.`);

    // ── Phase 2: Match disk folders to API story IDs ──────────────────
    await ctx.logger("INFO", `🔍 Matching ${totalFolders} disk folders to API stories…`);

    // Get existing manifests so we don't overwrite ones already populated
    const existingManifests = await getAllDownloadedStories().catch(() => []);
    const existingIds = new Set(existingManifests.map(m => String(m.storyId)));

    const _matchStart = Date.now();

    for (let fi = 0; fi < diskFolders.length; fi++) {
      if (ctx.getCancelRequested()) {
        await ctx.logger("WARNING", `⏸ Rebuild cancelled at folder ${fi}/${totalFolders}.`);
        break;
      }

      const { folderName, files = [] } = diskFolders[fi];

      // Progress + ETA
      const _done   = fi + 1;
      const _left   = totalFolders - fi - 1;
      const _elapsed = Date.now() - _matchStart;
      const _avgMs   = _done > 0 ? _elapsed / _done : 0;
      const _eta     = (_done >= 3 && _avgMs > 0 && _left > 0) ? formatETA(_avgMs * _left) : "";
      chrome.runtime.sendMessage({
        type: "PROGRESS",
        current: _done, total: totalFolders,
        childName: `Rebuilding ${childName}`,
        date: formatDateDMY((folderName.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || ""),
        eta: _eta, childIndex: 0, childCount: 1,
      }).catch(() => {});

      try {
        // Extract date from folder name (format: "YYYY-MM-DD - ...")
        const dateMatch = folderName.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) {
          await ctx.logger("WARNING", `  Skipping folder with no date: ${folderName}`);
          errors++;
          continue;
        }
        const storyDate = dateMatch[1];

        // Skip folders already in the manifest with real IDs
        const alreadyPresent = existingManifests.find(
          m => m.folderName === folderName && String(m.childId) === String(childId)
            && !String(m.storyId).startsWith("recovered_")
        );
        if (alreadyPresent && existingIds.has(String(alreadyPresent.storyId))) {
          matched++;
          continue; // already have a real manifest for this folder
        }

        // Gather candidate API stories from this date and ±1 day
        const candidates = [];
        for (const offset of [0, -1, 1]) {
          const d = new Date(storyDate + "T00:00:00Z");
          d.setUTCDate(d.getUTCDate() + offset);
          const key = d.toISOString().split("T")[0];
          const list = byDate.get(key) || [];
          candidates.push(...list);
        }

        // Find best title match
        let bestId = null, bestCreatedAt = "", bestTitle = "", bestScore = 0;
        for (const s of candidates) {
          const score = _titleMatchScore(folderName, s.title);
          if (score > bestScore) {
            bestScore = score; bestId = s.id;
            bestCreatedAt = s.created_at; bestTitle = s.title;
          }
        }

        // Media files (exclude story.html and Story Cards)
        const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;
        const mediaFiles = files.filter(f => MEDIA_EXT.test(f));

        if (bestId && bestScore >= 0.6) {
          // ── Matched story: create real manifest + mark processed ──
          const manifest = {
            childId,
            childName,
            storyId:           bestId,
            storyTitle:        bestTitle || folderName.replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, "").trim(),
            storyDate,
            folderName,
            approvedFilenames: mediaFiles,
            thumbnailFilename: mediaFiles.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))[0] || mediaFiles[0] || "",
            excerpt:           "",
            storyBody:         "",  // enriched on next DEEP_RESCAN
            storyRoutine:      "",
            educatorName:      "",
            roomName:          "",
            centreName:        "",
            childAge:          "",
            mediaUrls:         [],
          };
          await addDownloadedStory(manifest).catch(() => {});
          await markStoryProcessed(bestId, bestCreatedAt, childId).catch(() => {});
          matched++;
        } else {
          // ── No match: create recovered_ entry ──
          const titleFromFolder = folderName.replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, "").trim() || folderName;
          const recoveryId = `recovered_${childId}_${folderName}`;
          const manifest = {
            childId,
            childName,
            storyId:           recoveryId,
            storyTitle:        titleFromFolder,
            storyDate,
            folderName,
            approvedFilenames: mediaFiles,
            thumbnailFilename: mediaFiles.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))[0] || mediaFiles[0] || "",
            excerpt:           "",
            storyBody:         "",
            storyRoutine:      "",
            educatorName:      "",
            roomName:          "",
            centreName:        "",
            childAge:          "",
            mediaUrls:         [],
          };
          await addDownloadedStory(manifest).catch(() => {});
          await markStoryProcessed(recoveryId, storyDate, childId).catch(() => {});
          recovered++;
        }
      } catch (folderErr) {
        await ctx.logger("WARNING", `  ⚠ Folder ${folderName}: ${folderErr.message}`);
        errors++;
      }
    }

    // ── Phase 3: Rebuild index pages ──────────────────────────────────
    try {
      const { children = [] } = await chrome.storage.local.get("children");
      await rebuildIndexPages(children, ctx);
    } catch (idxErr) {
      await ctx.logger("WARNING", `⚠ Index page rebuild failed (non-fatal): ${idxErr.message}`);
    }

    const summary = `🔄 Database rebuilt for ${childName}: ` +
      `${matched} matched to API (real IDs), ${recovered} recovered from disk` +
      `${errors > 0 ? `, ${errors} errors` : ""}.`;
    await ctx.logger("SUCCESS", summary);

    if (recovered > 0) {
      await ctx.logger("INFO",
        `💡 ${recovered} story folders couldn't be matched to the API — ` +
        `run a Deep Rescan to enrich them with full metadata (story text, educator, centre).`
      );
    }

    return { ok: true, matched, recovered, errors, totalFolders };

  } catch (err) {
    await ctx.logger("ERROR", `❌ Rebuild failed: ${err.message}`);
    return { ok: false, error: err.message, matched, recovered, errors, totalFolders };
  }
}
