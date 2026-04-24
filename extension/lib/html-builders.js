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
    <div class="routine-label">${childFirst ? escHtml(childFirst) + "'s" : "Daily"} Routine</div>
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
    <a href="../index.html">&larr; Back to all stories</a> &middot;
    <a href="../../../index.html">&larr; All children</a>
  </nav>
  <div class="header">
    <h1>${escHtml(title || "Story")}</h1>
    <div class="meta">
      <span>${dateDisplay}</span>
      ${childName ? `<span>${escHtml(childName)}${childAge ? ` (${escHtml(childAge)})` : ""}</span>` : ""}
      ${educatorName ? `<span>${escHtml(educatorName)}</span>` : ""}
      ${roomName ? `<span>${escHtml(roomName)}</span>` : ""}
      ${centreName ? `<span>${escHtml(centreName)}</span>` : ""}
    </div>
  </div>

  ${bodyHtml}

  ${mediaHtml ? `<div class="photos">\n      ${mediaHtml}\n    </div>` : ""}

  ${routineSection}

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
  const sorted = [...manifests].sort((a, b) => (b.storyDate || "").localeCompare(a.storyDate || ""));

  // Story Card filter for index thumbnails and photo counts
  const _scRe = /Story Card\.jpg$/i;

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

