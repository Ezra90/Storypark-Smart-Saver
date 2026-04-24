/**
 * handlers-rebuild.js — Rebuild database from on-disk files + Storypark API
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  The REBUILD_DATABASE_FROM_DISK pipeline. Repairs a missing or     │
 * │  corrupt manifests.json by scanning already-downloaded story       │
 * │  folders on disk and matching them to real story IDs via the       │
 * │  Storypark feed API. Optionally enriches manifests with full       │
 * │  story data (body, educator, room, centre, routine) and rebuilds   │
 * │  story.html + Story Card JPEGs.                                    │
 * │                                                                    │
 * │  WHY THIS FILE EXISTS: handlers-audit.js is at its 600-line       │
 * │  limit. Rebuild is a separate domain (cold-start DB repair vs      │
 * │  ongoing audit/repair of a populated DB).                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Pipeline phases (all controlled by enrichStories flag):
 *   Phase 1: Fetch story feed from API (~30 sec for 500 stories)
 *   Phase 2: Match on-disk folders to real story IDs by date + title
 *   Phase 3: Bulk-fetch daily routines for all dates (if enrichStories)
 *   Phase 4: Per-story detail fetch — body, educator, room, centre, age
 *   Phase 5: Rebuild story.html + Story Card for enriched stories
 *   Phase 6: Rebuild index pages
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   REBUILD_DATABASE_FROM_DISK
 */

import { apiFetch, smartDelay, discoverCentres, STORYPARK_BASE, AuthError, RateLimitError } from "./api-client.js";
import {
  addDownloadedStory, markStoryProcessed, getAllDownloadedStories,
  getCentreGPS, saveChildProfile, isChildProfileStale, getChildProfile,
  cacheStory, getCachedStory,
} from "./db.js";
import { rebuildIndexPages } from "./handlers-html.js";
import { downloadDataUrl, downloadHtmlFile } from "./download-pipe.js";
import { buildStoryPage } from "./html-builders.js";
import {
  sanitizeName, formatDateDMY, formatETA, stripHtml, calculateAge,
} from "./metadata-helpers.js";

/* ================================================================== */
/*  Title-matching helpers                                             */
/* ================================================================== */

function _normTitle(title) {
  return (title || "")
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
}

function _titleMatchScore(folderName, apiTitle) {
  const titlePart = folderName.replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, "").trim();
  const normFolder = _normTitle(titlePart);
  const normApi    = _normTitle(apiTitle);

  if (!normFolder || !normApi) return 0;
  if (normFolder === normApi) return 1.0;
  if (normApi.startsWith(normFolder) && normFolder.length >= 8) return 0.9;
  if (normFolder.startsWith(normApi) && normApi.length >= 8) return 0.9;

  const fWords = normFolder.split(" ").filter(w => w.length > 2);
  const aWords = new Set(normApi.split(" ").filter(w => w.length > 2));
  if (fWords.length === 0) return 0;
  const matching = fWords.filter(w => aWords.has(w)).length;
  return matching / Math.max(fWords.length, aWords.size);
}

/* ================================================================== */
/*  Routine helpers                                                    */
/* ================================================================== */

/** Build routine summary + detailed text from v3 daily_routine events. */
function _buildRoutineData(events) {
  const titles = [], lines = [];
  const sorted = [...(events || [])].sort((a, b) =>
    (a.occurred_at || "").localeCompare(b.occurred_at || "")
  );
  for (const evt of sorted) {
    const title = evt.title || evt.full_description || evt.description || evt.routine_type || "";
    if (!title) continue;
    titles.push(title);
    let timeStr = "";
    if (evt.occurred_at) {
      const d = new Date(evt.occurred_at);
      if (!isNaN(d.getTime())) {
        const h = d.getHours(), m = d.getMinutes();
        timeStr = `${h % 12 || 12}:${String(m).padStart(2,"0")}${h >= 12 ? "pm" : "am"}`;
      }
    }
    const notes = [];
    if (evt.notes) notes.push(evt.notes);
    if (evt.bottle?.quantity) notes.push(`${evt.bottle.quantity}${evt.bottle.measurement || "ml"}`);
    if (evt.nappy?.status && !title.toLowerCase().includes(evt.nappy.status)) notes.push(evt.nappy.status);
    const suffix = notes.length ? ` (${notes.join(", ")})` : "";
    lines.push(timeStr ? `${timeStr} - ${title}${suffix}` : `${title}${suffix}`);
  }
  return { summary: titles.join(", "), detailed: lines.join("\n") };
}

/**
 * Bulk-fetch all daily routines for a child (paginated).
 * Returns a Map<dateString, {summary, detailed}>.
 *
 * @param {string} childId
 * @param {Function} logger
 * @returns {Promise<Map<string, {summary:string, detailed:string}>>}
 */
async function _fetchAllRoutines(childId, logger) {
  const routineMap = new Map();
  let pageToken = "null";
  let pages = 0;
  while (pages < 120) { // max ~12,000 days of routine data
    try {
      await smartDelay("FEED_SCROLL");
      const url = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${pageToken}`;
      const data = await apiFetch(url);
      for (const r of (data.daily_routines || [])) {
        if (r.date && !routineMap.has(r.date)) {
          routineMap.set(r.date, _buildRoutineData(r.events || []));
        }
      }
      pageToken = data.next_page_token;
      if (!pageToken) break;
      pages++;
    } catch { break; }
  }
  return routineMap;
}

/* ================================================================== */
/*  REBUILD_DATABASE_FROM_DISK                                         */
/* ================================================================== */

/**
 * Full database rebuild from on-disk story folders + Storypark API.
 *
 * Phase 1 (~30 sec): Fetch complete story feed to build date→storyId map.
 * Phase 2 (~1 sec): Match each on-disk folder to a real story ID.
 * Phase 3 (opt, ~5-10 sec): Bulk-fetch all daily routines.
 * Phase 4 (opt, ~45-60 min for 500 stories): Per-story detail enrichment.
 *   - story body, educator name, room/classroom, centre name, child age
 *   - Routine data looked up from Phase 3 bulk fetch
 *   - Uses smartDelay("READ_STORY") before every story fetch (anti-abuse)
 * Phase 5 (opt, ~5-10 min): Rebuild story.html + Story Card JPEGs.
 * Phase 6: Rebuild root + per-child index HTML pages.
 *
 * @param {{
 *   childId: string,
 *   childName: string,
 *   diskFolders: Array<{folderName: string, files: string[]}>,
 *   enrichStories?: boolean  // default true — fetch full story data
 * }} msg
 * @param {import('./types.js').HandlerContext} ctx
 */
export async function handleRebuildDatabaseFromDisk(msg, ctx) {
  const {
    childId,
    childName,
    diskFolders = [],
    enrichStories = true,
  } = msg;

  if (!childId || !childName) return { ok: false, error: "Missing childId or childName." };
  if (diskFolders.length === 0) return { ok: true, matched: 0, recovered: 0, enriched: 0, errors: 0, totalFolders: 0 };

  const totalFolders = diskFolders.length;
  let matched = 0, recovered = 0, enriched = 0, errors = 0;

  // Track manifests created in Phase 2 so Phase 4 knows what to enrich
  const matchedManifests = []; // { manifest, fromPhase1 }

  try {
    await ctx.logger("INFO", `🔄 Rebuilding database for ${childName}: ${totalFolders} story folders…`);

    // ── Phase 1: Fetch complete story feed ─────────────────────────
    await ctx.logger("INFO", "📡 Phase 1: Fetching story list from Storypark API…");

    const byDate = new Map(); // YYYY-MM-DD → [{id, created_at, title}]
    let pageToken = null;
    let feedPages = 0;
    const _feedStart = Date.now();

    while (true) {
      if (ctx.getCancelRequested()) {
        await ctx.logger("WARNING", "⏸ Rebuild cancelled during feed fetch.");
        return { ok: false, error: "cancelled", matched, recovered, enriched, errors, totalFolders };
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
          await ctx.logger("ERROR", "🛑 Auth error — check Storypark login.");
          return { ok: false, error: "auth", matched, recovered, enriched, errors, totalFolders };
        }
        if (err.name === "RateLimitError") {
          await ctx.logger("WARNING", "⏳ Rate limited — pausing 30s…");
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }
        throw err;
      }

      for (const s of (data.stories || data.items || [])) {
        const date = s.created_at ? s.created_at.split("T")[0] : null;
        if (!date) continue;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push({
          id: String(s.id),
          created_at: s.created_at || "",
          title: s.title || s.display_title || s.excerpt || "",
        });
      }

      pageToken = data.next_page_token || null;
      feedPages++;
      if (!pageToken) break;
    }

    const totalApiStories = [...byDate.values()].reduce((s, arr) => s + arr.length, 0);
    await ctx.logger("INFO", `✅ Feed loaded: ${totalApiStories} stories across ${byDate.size} dates.`);

    // ── Phase 2: Match disk folders to story IDs ──────────────────
    await ctx.logger("INFO", `🔍 Phase 2: Matching ${totalFolders} on-disk folders to story IDs…`);

    const existingManifests = await getAllDownloadedStories().catch(() => []);
    const existingIds = new Set(existingManifests.map(m => String(m.storyId)));
    const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;
    const _matchStart = Date.now();

    for (let fi = 0; fi < diskFolders.length; fi++) {
      if (ctx.getCancelRequested()) {
        await ctx.logger("WARNING", `⏸ Rebuild cancelled at folder ${fi}/${totalFolders}.`);
        break;
      }

      const { folderName, files = [] } = diskFolders[fi];
      const _done = fi + 1, _left = totalFolders - fi - 1;
      const _elapsed = Date.now() - _matchStart, _avgMs = _done > 0 ? _elapsed / _done : 0;
      const _eta = (_done >= 3 && _avgMs > 0 && _left > 0) ? formatETA(_avgMs * _left) : "";
      chrome.runtime.sendMessage({
        type: "PROGRESS", current: _done, total: totalFolders,
        childName: `Matching ${childName}`,
        date: formatDateDMY((folderName.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || ""),
        eta: _eta, childIndex: 0, childCount: 1,
      }).catch(() => {});

      try {
        const dateMatch = folderName.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) { errors++; continue; }
        const storyDate = dateMatch[1];

        // Skip if already has a real manifest
        const alreadyPresent = existingManifests.find(
          m => m.folderName === folderName && String(m.childId) === String(childId)
            && !String(m.storyId).startsWith("recovered_")
        );
        if (alreadyPresent && existingIds.has(String(alreadyPresent.storyId))) {
          matched++;
          matchedManifests.push({ manifest: alreadyPresent, isExisting: true });
          continue;
        }

        // Find best API match (±1 day)
        const candidates = [];
        for (const offset of [0, -1, 1]) {
          const d = new Date(storyDate + "T00:00:00Z");
          d.setUTCDate(d.getUTCDate() + offset);
          candidates.push(...(byDate.get(d.toISOString().split("T")[0]) || []));
        }

        let bestId = null, bestCreatedAt = "", bestTitle = "", bestScore = 0;
        for (const s of candidates) {
          const score = _titleMatchScore(folderName, s.title);
          if (score > bestScore) {
            bestScore = score; bestId = s.id;
            bestCreatedAt = s.created_at; bestTitle = s.title;
          }
        }

        // Exclude Story Card JPEGs — they are generated assets for Google Photos import,
        // not downloaded media. Including them in approvedFilenames would make them appear
        // as gallery images in story.html and as index thumbnails.
        const STORY_CARD_RE = /Story Card\.jpg$/i;
        const mediaFiles = files.filter(f => MEDIA_EXT.test(f) && !STORY_CARD_RE.test(f));

        if (bestId && bestScore >= 0.6) {
          const manifest = {
            childId, childName,
            storyId: bestId,
            storyTitle: bestTitle || folderName.replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, "").trim(),
            storyDate, folderName,
            approvedFilenames: mediaFiles,
            thumbnailFilename: mediaFiles.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))[0] || mediaFiles[0] || "",
            excerpt: "", storyBody: "", storyRoutine: "", educatorName: "",
            roomName: "", centreName: "", childAge: "", mediaUrls: [],
          };
          await addDownloadedStory(manifest).catch(() => {});
          await markStoryProcessed(bestId, bestCreatedAt, childId).catch(() => {});
          matched++;
          matchedManifests.push({ manifest, isExisting: false });
        } else {
          const titleFromFolder = folderName.replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, "").trim() || folderName;
          const recoveryId = `recovered_${childId}_${folderName}`;
          const manifest = {
            childId, childName, storyId: recoveryId, storyTitle: titleFromFolder,
            storyDate, folderName, approvedFilenames: mediaFiles,
            thumbnailFilename: mediaFiles.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))[0] || mediaFiles[0] || "",
            excerpt: "", storyBody: "", storyRoutine: "", educatorName: "",
            roomName: "", centreName: "", childAge: "", mediaUrls: [],
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

    await ctx.logger("INFO",
      `✅ Phase 2 complete: ${matched} matched to real IDs, ${recovered} recovered from disk.`
    );

    // ── Phase 3+4+5: Enrich manifests with full story data ────────
    if (enrichStories && matched > 0) {
      // Only enrich stories that have real (non-recovered) IDs
      const toEnrich = matchedManifests
        .filter(m => !String(m.manifest.storyId).startsWith("recovered_"))
        .filter(m => !m.manifest.storyBody); // skip already-enriched

      if (toEnrich.length > 0) {
        // Phase 3: Bulk-fetch all routines (one paginated set of calls)
        await ctx.logger("INFO", "📋 Phase 3: Fetching routine data…");
        const routineMap = await _fetchAllRoutines(childId, ctx.logger);
        await ctx.logger("INFO", `✅ Phase 3 complete: ${routineMap.size} dates with routine data.`);

        // Get child birthday for age calculation
        let childBirthday = null;
        try {
          const cachedProfile = await getChildProfile(childId).catch(() => null);
          const isStale = cachedProfile ? (await isChildProfileStale(childId).catch(() => true)) : true;
          if (cachedProfile && !isStale) {
            childBirthday = cachedProfile.birthday || null;
          } else {
            const profileData = await apiFetch(`${STORYPARK_BASE}/api/v3/children/${childId}`);
            const child = profileData.child || profileData;
            childBirthday = child.birthday || null;
            saveChildProfile({
              childId, childName,
              birthday: child.birthday || null,
              regularDays: child.regular_days || [],
              companies: (child.companies || []).map(c => c.name || c.display_name || "").filter(Boolean),
              centreIds: child.centre_ids || [],
            }).catch(() => {});
          }
        } catch { /* non-fatal */ }

        // Phase 4: Per-story detail enrichment
        await ctx.logger("INFO", `📖 Phase 4: Enriching ${toEnrich.length} stories with full metadata…`);
        const _enrichStart = Date.now();
        const enrichedManifests = [];

        for (let ei = 0; ei < toEnrich.length; ei++) {
          if (ctx.getCancelRequested()) {
            await ctx.logger("WARNING", `⏸ Enrichment cancelled at story ${ei}/${toEnrich.length}.`);
            break;
          }

          const { manifest: m } = toEnrich[ei];
          const _eDone = ei + 1, _eLeft = toEnrich.length - ei - 1;
          const _eElapsed = Date.now() - _enrichStart;
          const _eAvgMs = _eDone > 0 ? _eElapsed / _eDone : 0;
          const _eEta = (_eDone >= 3 && _eAvgMs > 0 && _eLeft > 0) ? formatETA(_eAvgMs * _eLeft) : "";
          chrome.runtime.sendMessage({
            type: "PROGRESS", current: _eDone, total: toEnrich.length,
            childName: `Enriching ${childName}`,
            date: formatDateDMY(m.storyDate || ""),
            eta: _eEta, childIndex: 0, childCount: 1,
          }).catch(() => {});
          // Per-story activity log line — shows current story in the log box
          await ctx.logger("INFO",
            `  📖 ${_eDone}/${toEnrich.length}: ${formatDateDMY(m.storyDate || "")} — ${(m.storyTitle || "Story").substring(0, 50)}` +
            (_eEta ? ` (⏱ ${_eEta})` : ""),
            m.storyDate || null
          );

          try {
            // Try cache first
            let story = await getCachedStory(String(m.storyId)).catch(() => null);
            if (!story) {
              await smartDelay("READ_STORY");
              try {
                const detail = await apiFetch(`${STORYPARK_BASE}/api/v3/stories/${m.storyId}`);
                story = detail.story || detail;
                await cacheStory(String(m.storyId), story).catch(() => {});
              } catch (storyErr) {
                if (storyErr.name === "AuthError") {
                  await ctx.logger("ERROR", "🛑 Auth error during enrichment — stopping.");
                  break;
                }
                if (storyErr.name === "RateLimitError") {
                  await ctx.logger("WARNING", "⏳ Rate limited — pausing 30s…");
                  await new Promise(r => setTimeout(r, 30000));
                  ei--; continue; // retry
                }
                await ctx.logger("WARNING", `  ⚠ Story ${m.storyId} fetch failed: ${storyErr.message}`);
                continue;
              }
            }

            // Extract metadata
            const rawBody = story.display_content || story.body || story.excerpt || story.content || "";
            const storyBody = typeof rawBody === "string" ? rawBody
              : Array.isArray(rawBody) ? rawBody.map(b => typeof b === "string" ? b : String(b?.text || b?.content || "")).join("\n").trim()
              : String(rawBody || "");
            const centreName = story.community_name || story.centre_name || story.service_name || story.group_name || "";
            const educatorName = story.user?.display_name || story.user?.name
              || (story.teachers && story.teachers[0]?.display_name)
              || story.creator?.display_name || "";
            const rawRoom = story.group_name || "";
            const roomName = (rawRoom && rawRoom !== centreName) ? rawRoom : "";
            const childAge = calculateAge(childBirthday, m.storyDate || "");
            const excerpt = stripHtml(storyBody).substring(0, 200);

            // Routine from bulk-fetched map
            const routineData = m.storyDate ? (routineMap.get(m.storyDate) || { summary: "", detailed: "" }) : { summary: "", detailed: "" };
            const storyRoutine = routineData.detailed || routineData.summary || "";

            // Discover centre GPS if new
            if (centreName && centreName !== m.centreName) {
              discoverCentres([centreName]).catch(() => {});
            }

            // Build media URL map from story
            const mediaItems = story.media || story.media_items || story.assets || [];
            const mediaUrls = mediaItems
              .filter(item => item.original_url)
              .map(item => ({
                filename: sanitizeName(item.file_name || item.filename || (item.original_url.split("/").pop() || "").split("?")[0] || ""),
                originalUrl: item.original_url,
              }))
              .filter(mu => mu.filename);

            // Update manifest with full data
            const enrichedManifest = {
              ...m,
              storyBody,
              excerpt,
              educatorName,
              roomName: roomName || m.roomName || "",
              centreName: centreName || m.centreName || "",
              childAge: childAge || m.childAge || "",
              storyRoutine,
              mediaUrls: mediaUrls.length > 0 ? mediaUrls : m.mediaUrls,
              storyTitle: stripHtml(story.display_title || story.title || story.excerpt || m.storyTitle || "Story"),
            };

            await addDownloadedStory(enrichedManifest).catch(() => {});
            enrichedManifests.push(enrichedManifest);
            enriched++;
          } catch (enrErr) {
            await ctx.logger("WARNING", `  ⚠ Enrich ${m.storyId} failed: ${enrErr.message}`);
            errors++;
          }

          // GC yield every 10 stories
          if ((ei + 1) % 10 === 0) await new Promise(r => setTimeout(r, 50));
        }

        await ctx.logger("INFO", `✅ Phase 4 complete: ${enriched} stories enriched with full metadata.`);

        // Phase 5: Rebuild HTML + Story Cards for enriched stories
        if (enrichedManifests.length > 0 && ctx.sendToOffscreen) {
          await ctx.logger("INFO", `📄 Phase 5: Rebuilding story pages + Story Cards for ${enrichedManifests.length} stories…`);
          const { saveStoryCard = true } = await chrome.storage.local.get("saveStoryCard");
          let htmlBuilt = 0, cardBuilt = 0;

          for (const m of enrichedManifests) {
            if (ctx.getCancelRequested()) break;
            try {
              const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;
              const rejectedSet = new Set(m.rejectedFilenames || []);
              const approvedOnly = (m.approvedFilenames || []).filter(f => !rejectedSet.has(f));

              // story.html
              const htmlContent = buildStoryPage({
                title: m.storyTitle, date: m.storyDate, body: m.storyBody,
                childName: m.childName, childAge: m.childAge || "",
                roomName: m.roomName || "", centreName: m.centreName || "",
                educatorName: m.educatorName || "",
                routineText: m.storyRoutine || "",
                mediaFilenames: approvedOnly,
              });
              const htmlRes = await ctx.sendToOffscreen({
                type: "DOWNLOAD_TEXT", text: htmlContent,
                savePath: `${storyBasePath}/story.html`, mimeType: "text/html",
              });
              if (htmlRes?.dataUrl && htmlRes?.savePath) {
                await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
                htmlBuilt++;
              }

              // Story Card JPEG
              if (saveStoryCard && m.storyBody && approvedOnly.length > 0) {
                try {
                  const gpsCoords = m.centreName
                    ? await getCentreGPS(m.centreName).catch(() => null) : null;
                  const cardPath = `${storyBasePath}/${m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "story - Story Card.jpg")}`;
                  const cr = await ctx.sendToOffscreen({
                    type: "GENERATE_STORY_CARD",
                    title: m.storyTitle, date: m.storyDate, body: m.storyBody,
                    centreName: m.centreName || "", roomName: m.roomName || "",
                    educatorName: m.educatorName || "", childName: m.childName,
                    childAge: m.childAge || "", routineText: m.storyRoutine || "",
                    photoCount: approvedOnly.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length,
                    gpsCoords, savePath: cardPath,
                  });
                  if (cr?.ok && cr?.dataUrl) {
                    await downloadDataUrl(cr.dataUrl, cardPath);
                    cardBuilt++;
                  }
                } catch { /* non-fatal */ }
              }
            } catch (htmlErr) {
              await ctx.logger("WARNING", `  ⚠ HTML rebuild failed for ${m.storyId}: ${htmlErr.message}`);
            }
          }

          await ctx.logger("INFO", `✅ Phase 5 complete: ${htmlBuilt} story pages + ${cardBuilt} Story Cards rebuilt.`);
        }
      }
    }

    // Phase 6: Rebuild index pages
    try {
      const { children = [] } = await chrome.storage.local.get("children");
      await rebuildIndexPages(children, ctx);
    } catch (idxErr) {
      await ctx.logger("WARNING", `⚠ Index page rebuild failed (non-fatal): ${idxErr.message}`);
    }

    // Final summary
    const summary = `🔄 Rebuild complete for ${childName}: ` +
      `${matched} matched · ${recovered} recovered` +
      (enriched > 0 ? ` · ${enriched} enriched with full metadata` : "") +
      (errors > 0 ? ` · ⚠ ${errors} errors` : "");
    await ctx.logger("SUCCESS", summary);

    if (recovered > 0 && !enrichStories) {
      await ctx.logger("INFO",
        `💡 ${recovered} folders couldn't be matched to Storypark. Run a Deep Rescan to enrich them with story text, educator, and centre data.`
      );
    }

    return { ok: true, matched, recovered, enriched, errors, totalFolders };

  } catch (err) {
    await ctx.logger("ERROR", `❌ Rebuild failed: ${err.message}`);
    return { ok: false, error: err.message, matched, recovered, enriched, errors, totalFolders };
  }
}
