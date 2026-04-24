/**
 * handlers-audit.js — Audit, repair, and sync message handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  Story audit classification, file repair, manifest sync, and       │
 * │  rejection database rebuild.  All long-running operations here     │
 * │  respect smartDelay() and cancelRequested for anti-abuse.          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  HTML/card generation after repair → lib/handlers-html.js          │
 * │  Index page rebuilding → lib/handlers-html.js (rebuildIndexPages)  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * PATH PREFIX INVARIANT:
 *   walkFolder() returns paths relative to the LINKED folder.
 *   If the user linked "Storypark Smart Saver" itself: "Hugo Hill/Stories/..."
 *   If the user linked its PARENT:  "Storypark Smart Saver/Hugo Hill/Stories/..."
 *   _getPathPrefix(onDiskPaths) auto-detects which mode applies.
 *   ALWAYS use this prefix when comparing manifest paths to disk paths.
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   AUDIT_STORIES, AUDIT_AND_REPAIR, REPAIR_STORY,
 *   REBUILD_REJECTIONS_FROM_FOLDERS, SYNC_PROCESSED_FROM_MANIFEST,
 *   SYNC_PROCESSED_FROM_DISK
 */

import {
  getAllDownloadedStories, getDownloadedStories, addDownloadedStory,
  getProcessedStories, markStoryProcessed,
  getCachedStory, cacheStory,
  getCentreGPS,
  rebuildRejectionsFromFolders,
} from "./db.js";
import { apiFetch, smartDelay, STORYPARK_BASE, AuthError, RateLimitError } from "./api-client.js";
import { downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen } from "./download-pipe.js";
import { buildStoryPage } from "./html-builders.js";
import { sanitizeName, formatDateDMY, formatETA } from "./metadata-helpers.js";
import { extractFilenameFromUrl } from "./storypark-api.js";

const _san = (s) => sanitizeName(s || "Unknown");
const VIDEO_EXT = /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

/* ================================================================== */
/*  Path prefix helper (fixes "Storypark Smart Saver/" parent issue)  */
/* ================================================================== */

/**
 * Detect whether onDiskPaths are relative to the "Storypark Smart Saver"
 * folder itself, or relative to its parent directory.
 *
 * INVARIANT: Apply this prefix to ALL path comparisons between manifests
 * and onDiskPaths.  Without it, all files appear "missing" when the
 * parent folder is linked — causing the audit/repair loop to endlessly
 * re-download already-existing files.
 *
 * @param {string[]} onDiskPaths
 * @returns {string} — "" or "Storypark Smart Saver/"
 */
function _getPathPrefix(onDiskPaths) {
  if (!onDiskPaths?.length) return "";
  return onDiskPaths.some(p => p.startsWith("Storypark Smart Saver/"))
    ? "Storypark Smart Saver/"
    : "";
}

/* ================================================================== */
/*  AUDIT_STORIES                                                      */
/* ================================================================== */

/**
 * AUDIT_STORIES — Classify every story manifest against a pre-walked disk snapshot.
 *
 * Classification statuses:
 *   complete        — all approved files on disk + story.html present
 *   partial_photos  — some approved files missing from disk
 *   partial_assets  — photos OK but story.html or Story Card missing
 *   db_only         — no files on disk at all
 *   rejected_on_disk — one or more files in Rejected Matches/ folder
 *   missing_video   — at least one video file not on disk
 *
 * @param {{ childId?: string, onDiskPaths?: string[], rejectedFilesByChild?: Object }} msg
 */
export async function handleAuditStories(msg, ctx) {
  try {
    const { childId, onDiskPaths = [], rejectedFilesByChild = null } = msg;
    const onDiskSet = new Set(onDiskPaths);
    const prefix    = _getPathPrefix(onDiskPaths);

    const allManifests = childId
      ? await getDownloadedStories(childId).catch(() => [])
      : await getAllDownloadedStories().catch(() => []);

    const stories = [];
    const summary = { total: 0, complete: 0, partial_photos: 0, partial_assets: 0, db_only: 0, rejected_on_disk: 0, missing_video: 0, missing_files: 0 };

    for (const m of allManifests) {
      if (!m.storyId || !m.folderName) continue;
      const childSafe  = _san(m.childName);
      const storyBase  = `${prefix}${childSafe}/Stories/${m.folderName}`;
      const approved   = m.approvedFilenames || [];
      const rejected   = m.rejectedFilenames || [];
      const mediaTypes = m.mediaTypes || {};

      const onDiskFiles   = [];
      const missingFiles  = [];
      const missingVideos = [];
      for (const f of approved) {
        const p = `${storyBase}/${f}`;
        if (onDiskSet.has(p)) onDiskFiles.push(f);
        else {
          missingFiles.push(f);
          if (mediaTypes[f] === "video") missingVideos.push(f);
        }
      }

      const htmlName = m.storyHtmlFilename || "story.html";
      const cardName = m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "");
      const hasHtml  = onDiskSet.has(`${storyBase}/${htmlName}`);
      const hasCard  = !cardName || onDiskSet.has(`${storyBase}/${cardName}`);

      // Rejected-on-disk (from Rejected Matches/ folders)
      const rejectedOnDisk = rejectedFilesByChild?.[m.childName]?.[m.folderName] || [];

      let status;
      if (onDiskFiles.length === 0 && approved.length > 0) {
        status = "db_only"; summary.db_only++;
      } else if (missingFiles.length > 0) {
        status = "partial_photos"; summary.partial_photos++;
      } else if (!hasHtml || !hasCard) {
        status = "partial_assets"; summary.partial_assets++;
      } else {
        status = "complete"; summary.complete++;
      }

      if (rejectedOnDisk.length > 0) summary.rejected_on_disk++;
      if (missingVideos.length > 0) summary.missing_video++;
      summary.missing_files += missingFiles.length;
      summary.total++;

      stories.push({
        childId: m.childId, childName: m.childName,
        storyId: m.storyId, storyDate: m.storyDate, storyTitle: m.storyTitle,
        folderName: m.folderName, status,
        totalFiles: approved.length, onDiskCount: onDiskFiles.length,
        missingFiles, missingVideos, hasHtml, hasCard,
        rejectedOnDisk, rejectedFilenamesCount: rejected.length,
      });
    }

    return { ok: true, summary, stories };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  AUDIT_AND_REPAIR                                                   */
/* ================================================================== */

/**
 * AUDIT_AND_REPAIR — Full audit-then-repair pipeline.
 *
 * Phase 1: Classify all stories (same as AUDIT_STORIES).
 * Phase 2: Re-download missing files with rate limiting + cancel support.
 * Phase 3: Re-audit using post-repair synthetic disk state.
 *
 * IMPORTANT: This handler returns { ok: true, started: true } immediately
 * then runs asynchronously.  Results come via:
 *   • PROGRESS messages (per story during repair)
 *   • AUDIT_REPAIR_DONE message (final summary)
 *   • SCAN_COMPLETE message (triggers setRunning(false) in dashboard)
 *
 * @param {{ onDiskPaths: string[], rejectedFilesByChild?: Object, repairPartialAssets?: boolean }} msg
 */
export async function handleAuditAndRepair(msg, ctx) {
  // This handler is fire-and-forget: the caller receives { started: true }
  // and listens for AUDIT_REPAIR_DONE / SCAN_COMPLETE broadcast messages.
  // Do NOT await the async work here — background.js sets isScanning=true
  // and registers the async loop before calling this handler.
  // The actual implementation is called by background.js in the AUDIT_AND_REPAIR
  // case after acquiring the scanning lock.
  //
  // See background.js for the full AUDIT_AND_REPAIR implementation which
  // wraps this handler with the isScanning guard.
  throw new Error("handleAuditAndRepair: use the background.js inline implementation (needs isScanning lock)");
}

/**
 * Core audit+repair logic — called by background.js after setting isScanning=true.
 * Exported so background.js can call it directly without duplicating the logic.
 *
 * @param {Object} msg
 * @param {import('./types.js').HandlerContext} ctx
 * @param {Function} rebuildIndexPages — (children) => Promise<void>
 * @returns {Promise<void>} — Broadcasts AUDIT_REPAIR_DONE when complete
 */
export async function runAuditAndRepair(msg, ctx, rebuildIndexPages) {
  const {
    onDiskPaths = [],
    rejectedFilesByChild = null,
    repairPartialAssets  = false,
  } = msg;

  const { saveStoryCard = true } = await chrome.storage.local.get("saveStoryCard");
  const onDiskSet  = new Set(onDiskPaths);
  const prefix     = _getPathPrefix(onDiskPaths);
  const loopStart  = Date.now();
  let totalDownloaded = 0, totalFailed = 0, totalSkipped = 0;

  // ── Phase 1: Audit ──
  await ctx.logger("INFO", `🔍 Audit started — classifying ${onDiskPaths.length} files on disk vs manifests…`);
  chrome.runtime.sendMessage({ type: "PROGRESS", current: 0, total: 100, childName: "Auditing…", childIndex: 0, childCount: 1, eta: "" }).catch(() => {});

  const allManifests   = await getAllDownloadedStories().catch(() => []);
  const brokenStories  = [];
  let complete = 0, partialPhotos = 0, dbOnly = 0, partialAssets = 0, totalMissing = 0;

  for (const m of allManifests) {
    if (!m.storyId || !m.folderName) continue;
    const base     = `${prefix}${_san(m.childName)}/Stories/${m.folderName}`;
    const approved = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
    const missing  = approved.filter(f => !onDiskSet.has(`${base}/${f}`));
    const htmlName = m.storyHtmlFilename || "story.html";
    const cardName = m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "");
    const hasHtml  = onDiskSet.has(`${base}/${htmlName}`);
    const hasCard  = !cardName || onDiskSet.has(`${base}/${cardName}`);
    const needsAssets = !hasHtml || !hasCard;

    if (approved.length === 0) continue;
    if (missing.length === approved.length) { dbOnly++;       totalMissing += missing.length; brokenStories.push({ manifest: m, missingFiles: missing, needsAssets: true }); }
    else if (missing.length > 0)            { partialPhotos++; totalMissing += missing.length; brokenStories.push({ manifest: m, missingFiles: missing, needsAssets: true }); }
    else if (needsAssets && repairPartialAssets) { partialAssets++; brokenStories.push({ manifest: m, missingFiles: [], needsAssets: true }); }
    else if (needsAssets)                   { partialAssets++; }
    else                                    { complete++; }
  }

  await ctx.logger("INFO",
    `📊 Audit complete — ${allManifests.length} stories: ✅ ${complete} complete · 📷 ${partialPhotos} missing photos · 💾 ${dbOnly} DB-only · 📄 ${partialAssets} missing HTML/Card · ⚠ ${totalMissing} files to restore`
  );

  if (brokenStories.length === 0) {
    await ctx.logger("SUCCESS", "✅ Everything looks good — no files need repairing!");
    chrome.runtime.sendMessage({ type: "AUDIT_REPAIR_DONE", summary: { complete, partialPhotos, dbOnly, partialAssets, totalMissing, repaired: 0, failed: 0 } }).catch(() => {});
    return;
  }

  await ctx.logger("INFO", `🛠 Starting repair for ${brokenStories.length} stories (${totalMissing} files)…`);

  // ── Phase 2: Repair ──
  const newlyDownloaded = new Set();
  const _total = brokenStories.length;
  let repairAborted = false;

  for (let si = 0; si < _total; si++) {
    if (ctx.getCancelRequested() || repairAborted) {
      await ctx.logger("WARNING", `⏸ Repair cancelled after ${si} of ${_total} stories.`);
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
      type: "PROGRESS", current: si + 1, total: _total,
      date: m.storyDate ? formatDateDMY(m.storyDate) : "",
      childName: `Repairing ${m.childName || ""}`, eta,
      childIndex: 0, childCount: 1,
    }).catch(() => {});

    // Build URL map
    const storyUrls = new Map();
    for (const mu of m.mediaUrls || []) {
      if (mu.filename && mu.originalUrl) storyUrls.set(mu.filename, mu.originalUrl);
    }
    // Fallback: cached story
    if (missingFiles.some(f => !storyUrls.has(f))) {
      const cached = await getCachedStory(String(m.storyId)).catch(() => null);
      if (cached) {
        for (const item of (cached.media || cached.media_items || cached.assets || [])) {
          const fn = item.file_name || item.filename || extractFilenameFromUrl(item.original_url || "");
          if (fn && item.original_url && !storyUrls.has(fn)) storyUrls.set(fn, item.original_url);
        }
      }
    }
    // Last resort: live API fetch
    if (missingFiles.length > 0 && missingFiles.some(f => !storyUrls.has(f)) && !String(m.storyId).startsWith("recovered_")) {
      try {
        await smartDelay("READ_STORY");
        const detail = await apiFetch(`${STORYPARK_BASE}/api/v3/stories/${m.storyId}`);
        const story  = detail.story || detail;
        await cacheStory(String(m.storyId), story).catch(() => {});
        for (const item of (story.media || story.media_items || story.assets || [])) {
          const fn = item.file_name || item.filename || extractFilenameFromUrl(item.original_url || "");
          if (fn && item.original_url && !storyUrls.has(fn)) storyUrls.set(fn, item.original_url);
        }
      } catch (apiErr) {
        if (apiErr.name === "AuthError") { await ctx.logger("ERROR", `🛑 Auth error — check Storypark login.`); break; }
        if (apiErr.name === "RateLimitError") { await ctx.logger("WARNING", `⏳ Rate limited — pausing 30s…`); await new Promise(r => setTimeout(r, 30000)); }
        else await ctx.logger("WARNING", `⚠ Story ${m.storyId} API fetch failed: ${apiErr.message}`);
      }
    }

    // Download missing files
    let storyDownloaded = 0;
    const gpsCoords = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;

    for (const filename of missingFiles) {
      if (ctx.getCancelRequested()) break;
      const originalUrl = storyUrls.get(filename);
      if (!originalUrl) { await ctx.logger("WARNING", `⚠ No URL for: ${filename} (story ${m.storyId}) — needs a fresh scan`); totalSkipped++; continue; }
      const savePath = `${storyBasePath}/${filename}`;
      const isVideo  = VIDEO_EXT.test(filename);
      try {
        await smartDelay("DOWNLOAD_MEDIA");
        if (isVideo) {
          const vr = await ctx.sendToOffscreen({ type: "DOWNLOAD_VIDEO", videoUrl: originalUrl, savePath });
          if (vr?.blobUrl) { await downloadVideoFromOffscreen(vr); storyDownloaded++; totalDownloaded++; newlyDownloaded.add(`${storyBase}/${filename}`); }
          else totalFailed++;
        } else {
          const ir = await ctx.sendToOffscreen({
            type: "DOWNLOAD_APPROVED",
            storyData: { storyId: m.storyId, createdAt: m.storyDate || "", originalUrl, filename },
            description: m.storyBody || "", exifTitle: `${(m.childName || "").split(/\s+/)[0]} - ${m.childAge || ""}`,
            exifSubject: (m.excerpt || "").substring(0, 200), exifComments: m.storyBody || "",
            childName: m.childName, savePath, gpsCoords,
          });
          if (ir?.dataUrl && ir?.savePath) { await downloadDataUrl(ir.dataUrl, ir.savePath); storyDownloaded++; totalDownloaded++; newlyDownloaded.add(`${storyBase}/${filename}`); }
          else totalFailed++;
        }
      } catch (dlErr) {
        if (dlErr.name === "RateLimitError" || dlErr.message.includes("429") || dlErr.message.includes("403")) {
          await ctx.logger("ERROR", "🛑 Rate limited by Storypark. Aborting repair. Please try again later.");
          repairAborted = true;
          break;
        }
        await ctx.logger("WARNING", `⚠ ${filename}: ${dlErr.message}`);
        totalFailed++;
      }
    }

    if (repairAborted) break;

    // Regenerate HTML + Card if files were downloaded
    if ((storyDownloaded > 0 || (needsAssets && missingFiles.length === 0)) && !ctx.getCancelRequested()) {
      try {
        const approvedAfter = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
        const routineStr    = typeof m.storyRoutine === "string" ? m.storyRoutine : (m.storyRoutine?.detailed || m.storyRoutine?.summary || "");
        const storyBody     = m.storyBody || m.excerpt || "";
        const htmlContent   = buildStoryPage({
          title: m.storyTitle, date: m.storyDate, body: storyBody,
          childName: m.childName, childAge: m.childAge || "",
          roomName: m.roomName || "", centreName: m.centreName || "",
          educatorName: m.educatorName || "", routineText: routineStr,
          mediaFilenames: approvedAfter,
        });
        const htmlRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${m.storyHtmlFilename || "story.html"}`, mimeType: "text/html" });
        if (htmlRes.dataUrl && htmlRes.savePath) { await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath); newlyDownloaded.add(`${storyBase}/${m.storyHtmlFilename || "story.html"}`); }
        if (saveStoryCard && storyBody && approvedAfter.length > 0) {
          const cardName = m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "story - Story Card.jpg");
          const cr = await ctx.sendToOffscreen({ type: "GENERATE_STORY_CARD", title: m.storyTitle, date: m.storyDate, body: storyBody, centreName: m.centreName || "", roomName: m.roomName || "", educatorName: m.educatorName || "", childName: m.childName, childAge: m.childAge || "", routineText: routineStr, photoCount: approvedAfter.filter(f => !VIDEO_EXT.test(f)).length, gpsCoords, savePath: `${storyBasePath}/${cardName}` });
          if (cr.ok && cr.dataUrl) { await downloadDataUrl(cr.dataUrl, `${storyBasePath}/${cardName}`); newlyDownloaded.add(`${storyBase}/${cardName}`); }
        }
      } catch (regenErr) {
        console.warn(`[handlers-audit] HTML regen failed for ${m.storyId}:`, regenErr.message);
      }
    }

    // GC yield between stories — drain microtask queue so V8 can collect freed objects
    await new Promise(r => setTimeout(r, 50));
  }

  // Rebuild index pages
  if (totalDownloaded > 0 && !ctx.getCancelRequested() && !repairAborted) {
    const { children = [] } = await chrome.storage.local.get("children");
    await rebuildIndexPages(children).catch(() => {});
  }

  // ── Phase 3: Re-audit using synthetic post-repair disk state ──
  const postRepairSet = new Set([...onDiskSet, ...newlyDownloaded]);
  let reComplete = 0, rePartial = 0, reDbOnly = 0, reAssets = 0, reMissing = 0;
  for (const m of allManifests) {
    if (!m.storyId || !m.folderName) continue;
    const base     = `${prefix}${_san(m.childName)}/Stories/${m.folderName}`;
    const approved = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
    const missing  = approved.filter(f => !postRepairSet.has(`${base}/${f}`));
    const htmlName = m.storyHtmlFilename || "story.html";
    const cardName = m.storyCardFilename || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "");
    if (approved.length === 0) continue;
    if (missing.length === approved.length) { reDbOnly++; reMissing += missing.length; }
    else if (missing.length > 0) { rePartial++; reMissing += missing.length; }
    else if (!postRepairSet.has(`${base}/${htmlName}`) || (cardName && !postRepairSet.has(`${base}/${cardName}`))) { reAssets++; }
    else { reComplete++; }
  }

  const summary = `🛠 Repair complete — ${totalDownloaded} restored, ${totalFailed} failed${totalSkipped > 0 ? `, ${totalSkipped} need fresh scan (expired URLs)` : ""}`;
  await ctx.logger("SUCCESS", summary);
  await ctx.logger("INFO", `📊 Post-repair: ✅ ${reComplete} complete · 📷 ${rePartial} partial · 💾 ${reDbOnly} DB-only · 📄 ${reAssets} HTML/Card only · ⚠ ${reMissing} still missing`);

  chrome.runtime.sendMessage({
    type: "AUDIT_REPAIR_DONE",
    summary: { complete: reComplete, partialPhotos: rePartial, dbOnly: reDbOnly, partialAssets: reAssets, totalMissing: reMissing, repaired: totalDownloaded, failed: totalFailed, skipped: totalSkipped },
  }).catch(() => {});
}

/* ================================================================== */
/*  REPAIR_STORY                                                       */
/* ================================================================== */

/**
 * REPAIR_STORY — Re-download missing files for a single story manifest.
 *
 * @param {{ childId: string, storyId: string, onlyFilenames?: string[], regenerateAssets?: boolean, options?: Object }} msg
 */
export async function handleRepairStory(msg, ctx) {
  try {
    const { childId, storyId, onlyFilenames = null, regenerateAssets = true, options = {} } = msg;
    if (!childId || !storyId) return { ok: false, error: "Missing childId or storyId" };

    const { saveStoryCard = true } = await chrome.storage.local.get("saveStoryCard");
    const manifests = await getDownloadedStories(childId).catch(() => []);
    const manifest  = manifests.find(m => String(m.storyId) === String(storyId));
    if (!manifest) return { ok: false, error: "Manifest not found" };

    // Build URL map (manifest.mediaUrls → cached story → live API)
    const storyUrls = new Map();
    for (const mu of manifest.mediaUrls || []) {
      if (mu.filename && mu.originalUrl) storyUrls.set(mu.filename, mu.originalUrl);
    }
    if (storyUrls.size === 0) {
      const cached = await getCachedStory(String(storyId)).catch(() => null);
      if (cached) {
        for (const item of (cached.media || cached.media_items || cached.assets || [])) {
          const fn = item.file_name || item.filename || extractFilenameFromUrl(item.original_url || "");
          if (fn && item.original_url && !storyUrls.has(fn)) storyUrls.set(fn, item.original_url);
        }
      }
    }

    const rejectedSet  = new Set(manifest.rejectedFilenames || []);
    const approvedSet  = new Set(manifest.approvedFilenames || []);
    const filesToRepair = (Array.isArray(onlyFilenames) && onlyFilenames.length > 0)
      ? onlyFilenames.filter(f => approvedSet.has(f) && !rejectedSet.has(f))
      : [...approvedSet].filter(f => !rejectedSet.has(f));

    if (filesToRepair.length === 0) return { ok: true, downloaded: 0, failed: 0, skipped: 0, missingUrls: [], assetsRegenerated: false };

    // Last-resort: live API refresh if any URLs still missing
    if (filesToRepair.some(f => !storyUrls.has(f)) && !String(storyId).startsWith("recovered_")) {
      try {
        const detail = await apiFetch(`${STORYPARK_BASE}/api/v3/stories/${storyId}`);
        const story  = detail.story || detail;
        await cacheStory(String(storyId), story).catch(() => {});
        for (const m of (story.media || story.media_items || story.assets || [])) {
          const fn = m.file_name || m.filename || extractFilenameFromUrl(m.original_url || "");
          if (fn && m.original_url && !storyUrls.has(fn)) storyUrls.set(fn, m.original_url);
        }
      } catch (apiErr) {
        await ctx.logger("WARNING", `[REPAIR_STORY] Story ${storyId} API refresh failed: ${apiErr.message}`);
      }
    }

    const storyBasePath = `Storypark Smart Saver/${sanitizeName(manifest.childName)}/Stories/${manifest.folderName}`;
    const gpsCoords     = manifest.centreName ? await getCentreGPS(manifest.centreName).catch(() => null) : null;
    let downloaded = 0, failed = 0, skipped = 0;
    const missingUrls = [];

    for (const filename of filesToRepair) {
      const originalUrl = storyUrls.get(filename);
      if (!originalUrl) { skipped++; missingUrls.push(filename); continue; }
      const savePath = `${storyBasePath}/${filename}`;
      const isVideo  = VIDEO_EXT.test(filename);
      try {
        if (isVideo) {
          const vr = await ctx.sendToOffscreen({ type: "DOWNLOAD_VIDEO", videoUrl: originalUrl, savePath });
          if (vr?.blobUrl && vr?.savePath) { await downloadVideoFromOffscreen(vr); downloaded++; } else failed++;
        } else {
          const ir = await ctx.sendToOffscreen({
            type: "DOWNLOAD_APPROVED",
            storyData: { storyId, createdAt: manifest.storyDate || "", body: manifest.storyBody || "", roomName: manifest.roomName, centreName: manifest.centreName, originalUrl, filename },
            description: manifest.storyBody || "", exifTitle: `${(manifest.childName || "").split(/\s+/)[0]} - ${manifest.childAge || ""}`,
            exifSubject: (manifest.excerpt || "").substring(0, 200), exifComments: manifest.storyBody || "",
            childName: manifest.childName, savePath, gpsCoords,
          });
          if (ir.dataUrl && ir.savePath) { await downloadDataUrl(ir.dataUrl, ir.savePath); downloaded++; } else failed++;
        }
      } catch (err) {
        console.warn(`[REPAIR_STORY] ${filename} failed:`, err.message);
        failed++;
      }
    }

    // Regenerate assets if requested
    let assetsRegenerated = false;
    if (regenerateAssets && downloaded > 0) {
      try {
        const approvedAfter = [...approvedSet].filter(f => !rejectedSet.has(f));
        const routineStr = typeof manifest.storyRoutine === "string" ? manifest.storyRoutine : (manifest.storyRoutine?.detailed || manifest.storyRoutine?.summary || "");
        const storyBody  = manifest.storyBody || manifest.excerpt || "";
        const htmlContent = buildStoryPage({ title: manifest.storyTitle, date: manifest.storyDate, body: storyBody, childName: manifest.childName, childAge: manifest.childAge || "", roomName: manifest.roomName || "", centreName: manifest.centreName || "", educatorName: manifest.educatorName || "", routineText: routineStr, mediaFilenames: approvedAfter });
        const htmlRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${manifest.storyHtmlFilename || "story.html"}`, mimeType: "text/html" });
        if (htmlRes.dataUrl && htmlRes.savePath) { await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath); assetsRegenerated = true; }
        if (saveStoryCard && storyBody && approvedAfter.length > 0) {
          const cardPath = `${storyBasePath}/${manifest.storyCardFilename || (manifest.storyDate ? `${manifest.storyDate} - Story Card.jpg` : "story - Story Card.jpg")}`;
          const cr = await ctx.sendToOffscreen({ type: "GENERATE_STORY_CARD", title: manifest.storyTitle, date: manifest.storyDate, body: storyBody, centreName: manifest.centreName || "", roomName: manifest.roomName || "", educatorName: manifest.educatorName || "", childName: manifest.childName, childAge: manifest.childAge || "", routineText: routineStr, photoCount: approvedAfter.filter(f => !VIDEO_EXT.test(f)).length, gpsCoords, savePath: cardPath });
          if (cr.ok && cr.dataUrl) await downloadDataUrl(cr.dataUrl, cardPath);
        }
      } catch (regenErr) {
        console.warn(`[REPAIR_STORY] Asset regen for ${storyId} failed:`, regenErr.message);
      }
    }

    await ctx.logger("SUCCESS", `🛠 Repaired story ${storyId}: ${downloaded} files restored${failed > 0 ? `, ${failed} failed` : ""}${missingUrls.length > 0 ? `, ${missingUrls.length} skipped (no URL)` : ""}${assetsRegenerated ? " + story.html regenerated" : ""}`);
    return { ok: true, downloaded, failed, skipped, missingUrls, assetsRegenerated };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  REBUILD_REJECTIONS_FROM_FOLDERS                                    */
/* ================================================================== */

/**
 * REBUILD_REJECTIONS_FROM_FOLDERS — Rebuild Database/rejections.json from
 * files found in "Rejected Matches/" folders on disk.
 *
 * @param {{ rejectedFilesByChild: Object }} msg
 */
export async function handleRebuildRejections(msg, ctx) {
  try {
    const manifests = await getAllDownloadedStories().catch(() => []);
    const added     = await rebuildRejectionsFromFolders(manifests, msg.rejectedFilesByChild || {});
    await ctx.logger("SUCCESS", `🔄 Rebuilt rejections ledger from Rejected Matches/ folders — ${added} entries added.`);
    return { ok: true, added };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Sync handlers                                                      */
/* ================================================================== */

/**
 * SYNC_PROCESSED_FROM_MANIFEST — Mark every story in manifests.json as processed.
 *
 * @param {{ childId?: string }} msg
 */
export async function handleSyncProcessedFromManifest(msg, ctx) {
  try {
    const targetChildId = msg.childId ? String(msg.childId) : null;
    const manifests     = await getAllDownloadedStories().catch(() => []);
    const byChild       = {};
    let synced = 0;

    for (const m of manifests) {
      if (!m.storyId) continue;
      if (targetChildId && String(m.childId) !== targetChildId) continue;
      try {
        await markStoryProcessed(m.storyId, m.storyDate || "", m.childId);
        byChild[m.childId] = (byChild[m.childId] || 0) + 1;
        synced++;
        if (synced % 20 === 0) await new Promise(r => setTimeout(r, 5));
      } catch { /* skip */ }
    }

    await ctx.logger("SUCCESS", `🔄 Marked ${synced} stories processed from manifests — next scan will resume after story ${synced}.`);
    return { ok: true, synced, byChild };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * SYNC_PROCESSED_FROM_DISK — Mark stories as processed when files are confirmed on disk.
 *
 * @param {{ childId: string, childName: string, onDiskPaths: string[] }} msg
 */
export async function handleSyncProcessedFromDisk(msg, ctx) {
  try {
    const { childId, childName, onDiskPaths = [] } = msg;
    const onDiskSet  = new Set(onDiskPaths);
    const INVALID    = /[/\\:*?"<>|]/g;
    const childSafe  = (childName || "").replace(INVALID, "_").trim() || "Unknown";
    const manifests  = await getDownloadedStories(childId).catch(() => []);
    let synced = 0, missing = 0;

    for (const m of manifests) {
      if (!m.storyId) continue;
      const files = m.approvedFilenames || [];
      if (files.length === 0) continue;
      const anyOnDisk = files.some(f => onDiskSet.has(`${childSafe}/Stories/${m.folderName}/${f}`));
      if (anyOnDisk) { await markStoryProcessed(m.storyId, m.storyDate || "", childId); synced++; }
      else missing++;
    }
    return { ok: true, synced, missing };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
