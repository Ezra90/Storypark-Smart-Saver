/**
 * html-builders.js — Story HTML + index page generators
 *
 * All exports are pure functions: they take data and return HTML strings.
 * No side effects, no Chrome API calls, no I/O.
 *
 * Exported functions:
 *   buildStoryPage           — Print-friendly story HTML page (one story)
 *   buildChildrenIndex       — Root children index (links to each child's stories)
 *   buildChildStoriesIndex   — Per-child story grid index (all stories for one child)
 *
 * NAMING CONVENTION:
 *   These functions build HTML STRING content only — no file I/O.
 *   "Page" = one story page   "Index" = navigation/listing page
 *
 * Usage (background.js):
 *   import { buildStoryPage, buildChildrenIndex, buildChildStoriesIndex } from './lib/html-builders.js';
 */

import { formatDateDMY, sanitizeName } from "./metadata-helpers.js";

/* ================================================================== */
/*  Story page                                                         */
/* ================================================================== */

/**
 * Build a print-friendly HTML page for a story.
 *
 * Layout:
 *   Story body / blurb
 *   ────────────────── (only when routine exists)
 *   Child's Routine
 *   9:11am - Toilet Nappy Full
 *   ────────────────── (only when routine exists)
 *   Child Name @ 1 year 2 months   ← always shown
 *   Nursery One
 *   Centre Name
 *   Storypark / Storypark Smart Saver
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.date            YYYY-MM-DD
 * @param {string} opts.body            HTML or plain text story body
 * @param {string} opts.childName
 * @param {string} [opts.childAge]      e.g. "1 year 5 months"
 * @param {string} [opts.roomName]
 * @param {string} [opts.centreName]
 * @param {string} [opts.educatorName]
 * @param {string} [opts.routineText]   Plain text routine (newlines = <br>)
 * @param {string[]} [opts.mediaFilenames]  Filenames of approved photos/videos
 * @returns {string} Complete HTML document string
 */
export function buildStoryPage({ title, date, body, childName, childAge, roomName, centreName, educatorName, routineText, mediaFilenames }) {
  const dateDisplay = formatDateDMY(date) || date || "Unknown date";
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const childFirst = (childName || "").split(/\s+/)[0];

  // Media files live alongside story.html in the same folder.
  // Exclude Story Card JPEGs — they are generated assets for Google Photos
  // import and should NOT appear as gallery images in the HTML page.
  const STORY_CARD_RE = /Story Card\.jpg$/i;
  const mediaHtml = (mediaFilenames || []).filter(f => !STORY_CARD_RE.test(f)).map(f => {
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

  // Story body — placeholder when empty
  const bodyHtml = body
    ? `<div class="body">${escHtml(body).replace(/\n/g, "<br>")}</div>`
    : `<div class="body empty">Story text not yet available — run a scan to restore the full story.</div>`;

  // Card preview: thumbnail + date + title + educator + excerpt + photo count
  // Shows a Storypark-style card at the top so you see the summary at a glance.
  const firstPhoto = (mediaFilenames || []).filter(f => !STORY_CARD_RE.test(f) && !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f))[0];
  const previewThumb = firstPhoto
    ? `<img src="./${encodeURIComponent(firstPhoto)}" alt="" class="preview-img" onclick="this.closest('.preview-card').nextElementSibling.scrollIntoView({behavior:'smooth'})" title="Click to scroll to full story">`
    : `<div class="preview-img preview-placeholder">📸</div>`;
  const previewExcerpt = (body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().substring(0, 200);
  const displayPhotoCount = (mediaFilenames || []).filter(f => !STORY_CARD_RE.test(f)).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title || "Story")} — ${dateDisplay}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 860px; margin: 0 auto; padding: 40px 32px; color: #333; line-height: 1.6; background: #f5f7fa; }
    nav { margin-bottom: 20px; font-size: 13px; color: #888; }
    nav a { color: #0f3460; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    /* Card preview */
    .preview-card { background: #fff; border-radius: 14px; box-shadow: 0 2px 16px rgba(0,0,0,0.10); overflow: hidden; display: flex; margin-bottom: 32px; cursor: pointer; transition: box-shadow 0.15s; }
    .preview-card:hover { box-shadow: 0 6px 28px rgba(0,0,0,0.14); }
    .preview-img { width: 220px; min-width: 220px; height: 200px; object-fit: cover; flex-shrink: 0; border: none; display: block; }
    .preview-placeholder { width: 220px; min-width: 220px; height: 200px; background: #e8edf3; display: flex; align-items: center; justify-content: center; font-size: 48px; flex-shrink: 0; }
    .preview-info { padding: 20px 22px; display: flex; flex-direction: column; gap: 5px; }
    .preview-date { font-size: 12px; color: #888; }
    .preview-title { font-size: 18px; font-weight: 700; color: #0f3460; line-height: 1.3; }
    .preview-educator { font-size: 13px; color: #666; }
    .preview-excerpt { font-size: 13px; color: #555; line-height: 1.5; margin-top: 4px; flex: 1; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
    .preview-photos { font-size: 13px; color: #4a90d9; font-weight: 600; margin-top: 6px; }
    /* Full content */
    .full-content { background: #fff; border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,0.07); padding: 32px; margin-bottom: 24px; }
    .full-content h2 { font-size: 20px; color: #0f3460; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 2px solid #e8edf3; font-family: Georgia, serif; }
    .body { font-size: 15px; margin-bottom: 20px; white-space: pre-wrap; font-family: Georgia, 'Times New Roman', serif; }
    .body.empty { color: #999; font-style: italic; font-size: 13px; }
    .photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .photo img { width: 100%; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); cursor: pointer; transition: opacity 0.15s; }
    .photo img:hover { opacity: 0.88; }
    .photo img.zoomed { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; object-fit: contain; background: rgba(0,0,0,0.92); z-index: 9999; border-radius: 0; cursor: zoom-out; padding: 24px; opacity: 1; }
    .divider-line { border-top: 2px solid #c5d3e8; margin: 16px 0; }
    .routine-block { margin-bottom: 0; }
    .routine-label { font-size: 14px; font-weight: bold; color: #0f3460; margin-bottom: 8px; }
    .routine-text { font-size: 13px; white-space: pre-line; color: #444; line-height: 1.9; margin-bottom: 14px; }
    .attribution { font-size: 12px; color: #666; line-height: 2.0; }
    .attribution.solo { border-top: 1px solid #e8edf3; padding-top: 14px; }
    .footer { font-size: 11px; color: #aaa; text-align: center; margin-top: 24px; }
    @media (max-width: 600px) { .preview-card { flex-direction: column; } .preview-img, .preview-placeholder { width: 100%; min-width: 0; height: 200px; } body { padding: 16px; } .full-content { padding: 20px; } }
    @media print { body { background: #fff; padding: 20px; } .preview-card { box-shadow: none; } nav { display: none; } .photo img.zoomed { display: none; } }
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
    <a href="../index.html">&larr; Back to all stories</a> &middot;
    <a href="../../../index.html">&larr; All children</a>
  </nav>

  <!-- Card preview — click to scroll to full content -->
  <div class="preview-card" onclick="document.querySelector('.full-content').scrollIntoView({behavior:'smooth'})">
    ${previewThumb}
    <div class="preview-info">
      <div class="preview-date">${dateDisplay}</div>
      <div class="preview-title">${escHtml(title || "Story")}</div>
      ${educatorName ? `<div class="preview-educator">${escHtml(educatorName)}</div>` : ""}
      <div class="preview-excerpt">${escHtml(previewExcerpt)}${previewExcerpt.length >= 200 ? "&hellip;" : ""}</div>
      <div class="preview-photos">${displayPhotoCount} photo${displayPhotoCount !== 1 ? "s" : ""}</div>
    </div>
  </div>

  <!-- Full story content -->
  <div class="full-content">
    <h2>${escHtml(title || "Story")}</h2>

    ${bodyHtml}

    ${mediaHtml ? `<div class="photos">\n      ${mediaHtml}\n    </div>` : ""}

    ${routineSection}
  </div>

  <div class="footer">
    Saved from Storypark by Storypark Smart Saver &mdash; ${new Date().toISOString().split("T")[0]}
  </div>
</body>
</html>`;
}

/* ================================================================== */
/*  Root children index                                                */
/* ================================================================== */

/**
 * Build the root-level children index HTML page.
 * Shows all children with links to their story grids.
 *
 * @param {Array<{id: string, name: string}>} children
 * @returns {string} HTML document string
 */
export function buildChildrenIndex(children) {
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
    <h1>Storypark Smart Saver</h1>
    <p class="subtitle">Choose a child to browse their stories</p>
    <div class="children-grid">
    ${cards}
    </div>
    <div class="footer">
      Saved from Storypark &mdash; ${new Date().toISOString().split("T")[0]}
    </div>
  </div>
</body>
</html>`;
}

/* ================================================================== */
/*  Per-child story index                                              */
/* ================================================================== */

/**
 * Build the per-child master story index HTML page.
 * Shows all downloaded stories as a responsive card grid.
 *
 * @param {string} childName
 * @param {Array} manifests  From getDownloadedStories()
 * @returns {string} HTML document string
 */
export function buildChildStoriesIndex(childName, manifests) {
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Story Card filter + dedup by storyId (keep manifest with most approved photos).
  // Prevents duplicate index cards when IDB has both old em-dash and new hyphen folder
  // manifests for the same story (different folder names, same storyId).
  const _scRe = /Story Card\.jpg$/i;
  const _dedup = new Map();
  for (const m of (manifests || [])) {
    const sid = m.storyId || m.folderName; // fallback for recovered_ entries
    const existing = _dedup.get(sid);
    const cnt  = (m.approvedFilenames || []).filter(f => !_scRe.test(f)).length;
    const eCnt = existing ? (existing.approvedFilenames || []).filter(f => !_scRe.test(f)).length : -1;
    if (!existing || cnt > eCnt) _dedup.set(sid, m);
  }
  const sorted = [..._dedup.values()].sort((a, b) => (b.storyDate || "").localeCompare(a.storyDate || ""));

  const cards = sorted.map(m => {
    // Use thumbnailFilename only if it's a real photo (not a Story Card).
    // Fall back to the first non-Story-Card approved filename.
    const safeThumbnail = m.thumbnailFilename && !_scRe.test(m.thumbnailFilename)
      ? m.thumbnailFilename
      : (m.approvedFilenames || []).find(f => !_scRe.test(f)) || null;
    const thumb = safeThumbnail
      ? `<img src="./${encodeURIComponent(m.folderName)}/${encodeURIComponent(safeThumbnail)}" alt="" loading="lazy">`
      : `<div class="no-thumb">📸</div>`;
    const date = formatDateDMY(m.storyDate) || m.storyDate || "";
    const meta = [
      m.educatorName ? `${escHtml(m.educatorName)}` : "",
      m.roomName     ? `${escHtml(m.roomName)}`     : "",
    ].filter(Boolean).join(" · ");
    // Photo count excludes Story Cards (generated assets, not downloaded photos)
    const photoCount = (m.approvedFilenames || []).filter(f => !_scRe.test(f)).length;

    return `<a href="./${encodeURIComponent(m.folderName)}/story.html" class="story-card">
      <div class="card-thumb">${thumb}</div>
      <div class="card-body">
        <div class="card-date">${date}</div>
        <div class="card-title">${escHtml(m.storyTitle)}</div>
        ${meta ? `<div class="card-meta">${meta}</div>` : ""}
        <div class="card-excerpt">${escHtml((m.excerpt || "").substring(0, 120))}${(m.excerpt || "").length > 120 ? "&hellip;" : ""}</div>
        <div class="card-photos">${photoCount} photo${photoCount !== 1 ? "s" : ""}</div>
      </div>
    </a>`;
  }).join("\n    ");

  const totalPhotos = sorted.reduce((sum, m) => sum + (m.approvedFilenames || []).length, 0);
  const dateRange = sorted.length > 0
    ? `${formatDateDMY(sorted[sorted.length - 1].storyDate) || "?"} &mdash; ${formatDateDMY(sorted[0].storyDate) || "?"}`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(childName)} &mdash; Stories</title>
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
    <nav><a href="../../index.html">&larr; All children</a></nav>
    <h1>${escHtml(childName)}'s Stories</h1>
    <p class="stats">${sorted.length} stories &middot; ${totalPhotos} photos${dateRange ? ` &middot; ${dateRange}` : ""} &middot; Last updated ${new Date().toISOString().split("T")[0]}</p>
    <div class="grid">
    ${cards}
    </div>
    <div class="footer">Saved from Storypark by Storypark Smart Saver</div>
  </div>
</body>
</html>`;
}

