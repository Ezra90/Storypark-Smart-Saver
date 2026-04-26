/**
 * handlers-html.js — HTML structure, batch download, and story card handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All message handlers that generate HTML, rebuild index pages,     │
 * │  execute batch downloads of deferred photos, or regenerate story   │
 * │  pages from disk files.                                            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  File repair / audit → lib/handlers-audit.js                       │
 * │  Review queue / pending downloads → lib/handlers-review.js         │
 * │  Download semaphore → lib/download-pipe.js                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * EXPORTED UTILITY:
 *   rebuildIndexPages(children, ctx) — used by handlers-audit.js and background.js
 *   after scan/repair to keep index.html pages up to date.
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   BUILD_HTML_STRUCTURE, BUILD_INDEX_PAGES, BATCH_DOWNLOAD_APPROVED,
 *   REGENERATE_FROM_DISK, GENERATE_STORY_CARDS_ALL
 */

import {
  getDownloadedStories, getAllDownloadedStories, addDownloadedStory,
  getPendingDownloads, getAllPendingDownloads, removePendingDownload,
  getCachedStory, getCentreGPS,
  recordFileDownloaded,
} from "./db.js";
import {
  downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen,
} from "./download-pipe.js";
import {
  buildStoryPage, buildChildrenIndex, buildChildStoriesIndex, getStoryHtmlFilenames, getStoryCardFilename,
} from "./html-builders.js";
import { sanitizeName } from "./metadata-helpers.js";

const VIDEO_EXT = /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

/* ================================================================== */
/*  Shared: Rebuild index pages                                        */
/* ================================================================== */

/**
 * Regenerate the root children index page + each child's per-story index.
 * Called after any operation that changes the set of downloaded stories:
 *   • BUILD_HTML_STRUCTURE
 *   • BATCH_DOWNLOAD_APPROVED (Phase 3→4 downloads)
 *   • runAuditAndRepair (after restoring missing files)
 *
 * @param {import('./types.js').Child[]} children
 * @param {import('./types.js').HandlerContext} ctx
 * @returns {Promise<void>}
 */
export async function rebuildIndexPages(children, ctx) {
  try {
    // Root children index
    const rootHtml = buildChildrenIndex(children);
    const rootRes  = await ctx.sendToOffscreen({
      type: "DOWNLOAD_TEXT", text: rootHtml,
      savePath: "Storypark Smart Saver/index.html", mimeType: "text/html",
    });
    if (rootRes.dataUrl && rootRes.savePath) await downloadHtmlFile(rootRes.dataUrl, rootRes.savePath);

    // Per-child story index pages
    for (const child of children) {
      const manifests = await getDownloadedStories(child.id).catch(() => []);
      if (manifests.length === 0) continue;
      const childIndexHtml = buildChildStoriesIndex(child.name, manifests);
      const childPath = `Storypark Smart Saver/${sanitizeName(child.name)}/Stories/index.html`;
      const ciRes = await ctx.sendToOffscreen({
        type: "DOWNLOAD_TEXT", text: childIndexHtml,
        savePath: childPath, mimeType: "text/html",
      });
      if (ciRes.dataUrl && ciRes.savePath) await downloadHtmlFile(ciRes.dataUrl, ciRes.savePath);
    }
  } catch (err) {
    console.warn("[handlers-html] rebuildIndexPages failed (non-fatal):", err.message);
  }
}

/* ================================================================== */
/*  BUILD_HTML_STRUCTURE                                               */
/* ================================================================== */

/**
 * BUILD_HTML_STRUCTURE — Regenerate ALL story HTML files + story cards
 * + index pages from stored manifests.  No photo downloads.
 * Overwrites existing HTML so pages always reflect the latest state.
 *
 * @param {Object} msg — (no required fields)
 * @param {import('./types.js').HandlerContext} ctx
 */
export async function handleBuildHtmlStructure(msg, ctx) {
  try {
    const { children = [], saveStoryCard = true } = await chrome.storage.local.get(["children", "saveStoryCard"]);
    let storyCount = 0, cardCount = 0;

    for (const child of children) {
      const manifests = await getDownloadedStories(child.id).catch(() => []);
      for (const m of manifests) {
        try {
          const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;
          const routineText   = m.storyRoutine || "";
          let storyBody = m.storyBody || "";
          // Try to hydrate from story cache if body is empty
          if (!storyBody && m.storyId && !m.storyId.startsWith("recovered_")) {
            const cached = await getCachedStory(m.storyId).catch(() => null);
            if (cached) {
              const raw = cached.display_content || cached.body || cached.excerpt || "";
              storyBody = typeof raw === "string" ? raw : (Array.isArray(raw) ? raw.map(b => b?.text || b?.content || "").join("\n") : "");
              if (storyBody) addDownloadedStory({ ...m, storyBody }).catch(() => {});
            }
          }

          const rejectedSet   = new Set(m.rejectedFilenames || []);
          const approvedOnly  = (m.approvedFilenames || []).filter(f => !rejectedSet.has(f));

          // story.html
          const htmlContent = buildStoryPage({
            title: m.storyTitle, date: m.storyDate, body: storyBody,
            childName: m.childName, childAge: m.childAge || "",
            roomName: m.roomName || "", centreName: m.centreName || "",
            educatorName: m.educatorName || "", routineText, mediaFilenames: approvedOnly,
          });
          const htmlNames = getStoryHtmlFilenames(m.storyDate, m.storyTitle, m.folderName);
          const primaryName = m.storyHtmlFilename || htmlNames.primary;
          const res = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${primaryName}`, mimeType: "text/html" });
          if (res.dataUrl && res.savePath) {
            await downloadHtmlFile(res.dataUrl, res.savePath);
            if (htmlNames.legacy) {
              const namedRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${htmlNames.legacy}`, mimeType: "text/html" });
              if (namedRes.dataUrl && namedRes.savePath) await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
            }
            storyCount++;
          }

          // story card
          if (saveStoryCard && storyBody && approvedOnly.length > 0) {
            try {
              const gpsCoords  = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;
              const cardPath   = `${storyBasePath}/${m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName)}`;
              const photoCount = approvedOnly.filter(f => !VIDEO_EXT.test(f)).length;
              const cr = await ctx.sendToOffscreen({ type: "GENERATE_STORY_CARD", title: m.storyTitle, date: m.storyDate, body: storyBody, centreName: m.centreName || "", roomName: m.roomName || "", educatorName: m.educatorName || "", childName: m.childName, childAge: m.childAge || "", routineText, photoCount, gpsCoords, savePath: cardPath });
              if (cr.ok && cr.dataUrl) { await downloadDataUrl(cr.dataUrl, cardPath); cardCount++; }
            } catch { /* non-fatal */ }
          }
        } catch (err) {
          console.warn(`[BUILD_HTML_STRUCTURE] Story ${m.storyId} failed:`, err.message);
        }
      }
    }

    await rebuildIndexPages(children, ctx);
    await ctx.logger("SUCCESS", `📄 HTML rebuilt: ${storyCount} pages${cardCount > 0 ? `, ${cardCount} cards` : ""} + index pages`);
    return { ok: true, storyCount };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * BUILD_INDEX_PAGES — Rebuild ONLY root + per-child index pages.
 *
 * @param {Object} msg
 */
export async function handleBuildIndexPages(msg, ctx) {
  try {
    const { children = [] } = await chrome.storage.local.get("children");
    await rebuildIndexPages(children, ctx);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  BATCH_DOWNLOAD_APPROVED                                            */
/* ================================================================== */

/**
 * BATCH_DOWNLOAD_APPROVED — Download all deferred (pending) photos.
 * After all media, generates story HTML + story cards, then index pages.
 *
 * Order: ALL media downloads → story HTML per story → index pages.
 * This ensures no broken image references in generated HTML.
 *
 * @param {{ childId?: string }} msg
 */
export async function handleBatchDownloadApproved(msg, ctx) {
  try {
    const items = msg.childId
      ? await getPendingDownloads(msg.childId)
      : await getAllPendingDownloads();
    if (items.length === 0) return { ok: true, downloaded: 0 };

    const { saveStoryHtml = true } = await chrome.storage.local.get("saveStoryHtml");

    // ── Phase 1: Group by storyId ──
    const storyGroups = new Map(); // storyId → { items[], downloadedFilenames[] }
    for (const item of items) {
      const sid = item.storyId || item.storyData?.storyId || "unknown";
      if (!storyGroups.has(sid)) storyGroups.set(sid, { items: [], downloadedFilenames: [] });
      storyGroups.get(sid).items.push(item);
    }

    // ── Phase 2: Download ALL media ──
    let downloaded = 0, failed = 0, done = 0;
    const total = items.length;
    const _gpsCache = new Map();

    for (const [, group] of storyGroups) {
      for (const item of group.items) {
        let wrote = false;
        try {
          // GPS lookup (cached per centre)
          let gpsCoords = item.gpsCoords || null;
          if (!gpsCoords) {
            const cName = item.centreName || item.storyData?.centreName;
            if (cName) {
              if (!_gpsCache.has(cName)) _gpsCache.set(cName, await getCentreGPS(cName).catch(() => null));
              gpsCoords = _gpsCache.get(cName);
            }
          }

          if ((item.itemType || "image") === "video") {
            const vr = await ctx.sendToOffscreen({ type: "DOWNLOAD_VIDEO", videoUrl: item.imageUrl, savePath: item.savePath });
            if (vr?.blobUrl && vr?.savePath) { await downloadVideoFromOffscreen(vr); group.downloadedFilenames.push(item.filename); downloaded++; wrote = true; }
          } else {
            const ir = await ctx.sendToOffscreen({ type: "DOWNLOAD_APPROVED", storyData: item.storyData || { originalUrl: item.imageUrl }, description: item.description || "", exifTitle: item.exifTitle || "", exifSubject: item.exifSubject || "", exifComments: item.exifComments || "", childName: item.childName, savePath: item.savePath, gpsCoords });
            if (ir.dataUrl && ir.savePath) { await downloadDataUrl(ir.dataUrl, ir.savePath); group.downloadedFilenames.push(item.filename); downloaded++; wrote = true; }
          }
        } catch (err) {
          console.warn(`[BATCH_DOWNLOAD] item ${item.id} failed:`, err.message);
        }

        if (wrote) await removePendingDownload(item.id);
        else failed++;

        done++;
        if (done % 10 === 0 || done === total) {
          chrome.runtime.sendMessage({ type: "BATCH_PROGRESS", done, total, downloaded, failed }).catch(() => {});
        }
      }
    }

    // ── Phase 3: Story HTML per story ──
    if (saveStoryHtml && downloaded > 0) {
      const childIds = new Set([...storyGroups.values()].flatMap(g => g.items.map(i => i.childId).filter(Boolean)));
      for (const childId of childIds) {
        const storyManifests = await getDownloadedStories(childId).catch(() => []);
        for (const manifest of storyManifests) {
          const group = storyGroups.get(manifest.storyId);
          if (!group?.downloadedFilenames.length) continue;
          try {
            const storyBasePath = `Storypark Smart Saver/${sanitizeName(manifest.childName)}/Stories/${manifest.folderName}`;
            const storyBody = manifest.storyBody || manifest.excerpt || "";
            const routineText = manifest.storyRoutine || "";

            const htmlContent = buildStoryPage({ title: manifest.storyTitle, date: manifest.storyDate, body: storyBody, childName: manifest.childName, childAge: manifest.childAge || "", roomName: manifest.roomName || "", centreName: manifest.centreName || "", educatorName: manifest.educatorName || "", routineText, mediaFilenames: manifest.approvedFilenames || [] });
            const htmlNames = getStoryHtmlFilenames(manifest.storyDate, manifest.storyTitle, manifest.folderName);
            const txtRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${htmlNames.primary}`, mimeType: "text/html" });
            if (txtRes.dataUrl && txtRes.savePath) {
              await downloadHtmlFile(txtRes.dataUrl, txtRes.savePath);
              if (htmlNames.legacy) {
                const namedRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${htmlNames.legacy}`, mimeType: "text/html" });
                if (namedRes.dataUrl && namedRes.savePath) await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
              }
            }

            if (storyBody && (manifest.approvedFilenames || []).length > 0) {
              const gpsCoords = manifest.centreName ? await getCentreGPS(manifest.centreName).catch(() => null) : null;
              const cardPath  = `${storyBasePath}/${manifest.storyCardFilename || getStoryCardFilename(manifest.storyDate, manifest.storyTitle, manifest.folderName)}`;
              const cr = await ctx.sendToOffscreen({ type: "GENERATE_STORY_CARD", title: manifest.storyTitle, date: manifest.storyDate, body: storyBody, centreName: manifest.centreName || "", roomName: manifest.roomName || "", educatorName: manifest.educatorName || "", childName: manifest.childName, childAge: manifest.childAge || "", routineText, photoCount: (manifest.approvedFilenames || []).filter(f => !VIDEO_EXT.test(f)).length, gpsCoords, savePath: cardPath });
              if (cr.ok && cr.dataUrl) await downloadDataUrl(cr.dataUrl, cardPath);
            }
          } catch (err) {
            console.warn(`[BATCH_DOWNLOAD] HTML for story ${manifest.storyId} failed:`, err.message);
          }
        }
      }
    }

    // ── Phase 4: Index pages ──
    const { children = [] } = await chrome.storage.local.get("children");
    await rebuildIndexPages(children, ctx);

    return { ok: true, downloaded, failed, remaining: failed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  REGENERATE_FROM_DISK                                               */
/* ================================================================== */

/**
 * REGENERATE_FROM_DISK — Rebuild story HTML for stories whose actual on-disk
 * file list was supplied by dashboard.js (from walkFolder via FSA).
 * Updates manifest approvedFilenames to match what's actually on disk.
 *
 * @param {{ filesByFolder: Object, childId?: string }} msg
 */
export async function handleRegenerateFromDisk(msg, ctx) {
  try {
    const { filesByFolder = {}, childId: targetChildId } = msg;
    const { children = [], saveStoryCard = true } = await chrome.storage.local.get(["children", "saveStoryCard"]);
    const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;
    // Story Card JPEGs are generated assets for Google Photos — not downloaded media.
    // They must never appear in approvedFilenames or be rendered as gallery images.
    const STORY_CARD_RE = /Story Card\.jpg$/i;
    let rebuilt = 0, updated = 0, errors = 0;

    const relevantChildren = targetChildId
      ? children.filter(c => String(c.id) === String(targetChildId))
      : children;

    for (const child of relevantChildren) {
      const manifests = await getDownloadedStories(child.id).catch(() => []);
      for (const m of manifests) {
        const diskFiles = filesByFolder[m.folderName];
        if (!diskFiles) continue;
        // Filter Story Cards — generated assets, must never be in approvedFilenames
        const mediaFiles = diskFiles.filter(f => MEDIA_EXT.test(f) && !STORY_CARD_RE.test(f));
        if (mediaFiles.length === 0) continue;

        try {
          // Update manifest with live file list
          const currentFiles = new Set(m.approvedFilenames || []);
          const diskSet = new Set(mediaFiles);
          let manifestChanged = false;
          for (const f of diskSet) if (!currentFiles.has(f)) { currentFiles.add(f); manifestChanged = true; }
          for (const f of [...currentFiles]) if (!diskSet.has(f)) { currentFiles.delete(f); manifestChanged = true; }

          const updatedFilenames = [...currentFiles];
          const updatedManifest  = { ...m, approvedFilenames: updatedFilenames, thumbnailFilename: m.thumbnailFilename && diskSet.has(m.thumbnailFilename) ? m.thumbnailFilename : (updatedFilenames[0] || "") };
          if (manifestChanged) { await addDownloadedStory(updatedManifest).catch(() => {}); updated++; }

          // Get story body
          let storyBody = m.storyBody || "";
          if (!storyBody && m.storyId && !m.storyId.startsWith("recovered_")) {
            const cached = await getCachedStory(m.storyId).catch(() => null);
            if (cached) {
              const raw = cached.display_content || cached.body || cached.excerpt || "";
              storyBody = typeof raw === "string" ? raw : (Array.isArray(raw) ? raw.map(b => b?.text || b?.content || "").join("\n") : "");
              if (storyBody) addDownloadedStory({ ...updatedManifest, storyBody }).catch(() => {});
            }
          }

          const routineText   = m.storyRoutine || "";
          const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;

          // Rebuild story.html
          const htmlContent = buildStoryPage({ title: m.storyTitle, date: m.storyDate, body: storyBody, childName: m.childName, childAge: m.childAge || "", roomName: m.roomName || "", centreName: m.centreName || "", educatorName: m.educatorName || "", routineText, mediaFilenames: updatedFilenames });
          const htmlNames = getStoryHtmlFilenames(m.storyDate, m.storyTitle, m.folderName);
          const htmlRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${htmlNames.primary}`, mimeType: "text/html" });
          if (htmlRes.dataUrl && htmlRes.savePath) {
            await downloadHtmlFile(htmlRes.dataUrl, htmlRes.savePath);
            if (htmlNames.legacy) {
              const namedRes = await ctx.sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/${htmlNames.legacy}`, mimeType: "text/html" });
              if (namedRes.dataUrl && namedRes.savePath) await downloadHtmlFile(namedRes.dataUrl, namedRes.savePath);
            }
            rebuilt++;
          }

          // Rebuild story card
          if (saveStoryCard && storyBody && updatedFilenames.length > 0) {
            try {
              const gpsCoords  = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;
              const cardPath   = `${storyBasePath}/${m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName)}`;
              const cr = await ctx.sendToOffscreen({ type: "GENERATE_STORY_CARD", title: m.storyTitle, date: m.storyDate, body: storyBody, centreName: m.centreName || "", roomName: m.roomName || "", educatorName: m.educatorName || "", childName: m.childName, childAge: m.childAge || "", routineText, photoCount: updatedFilenames.filter(f => !VIDEO_EXT.test(f)).length, gpsCoords, savePath: cardPath });
              if (cr.ok && cr.dataUrl) await downloadDataUrl(cr.dataUrl, cardPath);
            } catch { /* non-fatal */ }
          }
        } catch (err) {
          console.warn(`[REGENERATE_FROM_DISK] Story ${m.storyId} failed:`, err.message);
          errors++;
        }
      }
    }

    await rebuildIndexPages(children, ctx);
    await ctx.logger("SUCCESS", `🔄 Regenerated from disk: ${rebuilt} story pages rebuilt${updated > 0 ? `, ${updated} manifests updated` : ""}${errors > 0 ? `, ${errors} errors` : ""}`);
    return { ok: true, rebuilt, updated, errors };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  GENERATE_STORY_CARDS_ALL                                           */
/* ================================================================== */

/**
 * GENERATE_STORY_CARDS_ALL — Regenerate Story Card JPEGs for all (or one child's) stories.
 * Respects rejectedFilenames so the photo count is accurate.
 *
 * @param {{ childId?: string }} msg
 */
export async function handleGenerateStoryCardsAll(msg, ctx) {
  try {
    const { children = [] } = await chrome.storage.local.get("children");
    const targetChildId = msg.childId ? String(msg.childId) : null;
    const relevant = targetChildId ? children.filter(c => String(c.id) === String(targetChildId)) : children;
    let generated = 0, skipped = 0, errors = 0;

    for (const child of relevant) {
      const manifests = await getDownloadedStories(child.id).catch(() => []);
      for (const m of manifests) {
        try {
          const storyBody = m.storyBody || m.excerpt || "";
          const approvedOnly = (m.approvedFilenames || []).filter(f => !(m.rejectedFilenames || []).includes(f));
          if (!storyBody || approvedOnly.length === 0) { skipped++; continue; }

          const storyBasePath = `Storypark Smart Saver/${sanitizeName(m.childName)}/Stories/${m.folderName}`;
          const gpsCoords = m.centreName ? await getCentreGPS(m.centreName).catch(() => null) : null;
          const cardPath  = `${storyBasePath}/${m.storyCardFilename || getStoryCardFilename(m.storyDate, m.storyTitle, m.folderName)}`;
          const cr = await ctx.sendToOffscreen({ type: "GENERATE_STORY_CARD", title: m.storyTitle, date: m.storyDate, body: storyBody, centreName: m.centreName || "", roomName: m.roomName || "", educatorName: m.educatorName || "", childName: m.childName, childAge: m.childAge || "", routineText: m.storyRoutine || "", photoCount: approvedOnly.filter(f => !VIDEO_EXT.test(f)).length, gpsCoords, savePath: cardPath });
          if (cr.ok && cr.dataUrl) { await downloadDataUrl(cr.dataUrl, cardPath); generated++; }
        } catch (err) {
          console.warn(`[GENERATE_STORY_CARDS_ALL] Story ${m.storyId} failed:`, err.message);
          errors++;
        }
        if ((generated + skipped + errors) % 20 === 0) await new Promise(r => setTimeout(r, 30));
      }
    }

    await ctx.logger("SUCCESS", `🎴 Story Cards generated: ${generated}${skipped > 0 ? `, skipped: ${skipped}` : ""}${errors > 0 ? `, errors: ${errors}` : ""}`);
    return { ok: true, generated, skipped, errors };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
