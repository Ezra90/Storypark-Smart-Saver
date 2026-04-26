/**
 * html-builders.js — Smart Template HTML Generation
 * 
 * Generates responsive, offline-first HTML artifacts:
 * • story.html — full story page with photos, videos, routine, metadata
 * • index.html (root) — children grid
 * • index.html (per-child) — story card grid
 * 
 * All templates use native emoji, CSS Grid, and work offline.
 */
import {
  TEMPLATE_LIMITS,
  mergeTemplateSettings,
  buildTemplateTokenMap,
  renderTemplate,
  sanitizeName,
} from "./metadata-helpers.js";

/**
 * Build a complete story HTML page.
 * 
 * @param {Object} params
 * @param {string} params.title - Story title
 * @param {string} params.date - Story date (YYYY-MM-DD)
 * @param {string} params.body - Story text content
 * @param {string} params.childName - Child's name
 * @param {string} params.childAge - Formatted age (e.g. "2 years 3 months")
 * @param {string} params.roomName - Classroom/room name
 * @param {string} params.centreName - Daycare centre name
 * @param {string} params.educatorName - Educator who created the story
 * @param {string} params.routineText - Daily routine summary
 * @param {string[]} params.mediaFilenames - Array of photo/video filenames
 * @returns {string} Complete HTML document
 */
export function buildStoryPage({
  title,
  date,
  body,
  childName,
  childAge,
  roomName,
  centreName,
  educatorName,
  routineText,
  mediaFilenames,
  templateSettings,
}) {
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const childFirst = (childName || "").split(/\s+/)[0];
  const dateDisplay = formatDateDMY(date) || date || "Unknown date";
  const tmpl = mergeTemplateSettings(templateSettings);
  const tokenMap = buildTemplateTokenMap({
    storyDate: date,
    storyTitle: title,
    storyBody: body,
    childName,
    childAge,
    roomName,
    centreName,
    educatorName,
    routineText,
    photoCount: (mediaFilenames || []).length,
  });
  
  // Story Card JPEGs are generated assets for Google Photos, not gallery images
  const _scRe = /Story Card\.jpg$/i;
  const mediaHtml = (mediaFilenames || []).filter(f => !_scRe.test(f)).map(f => {
    const enc = encodeURIComponent(f);
    if (/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)) {
      return `<div class="photo"><video src="./${enc}" controls preload="metadata" style="width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);"></video></div>`;
    }
    return `<div class="photo"><img src="./${enc}" alt="Story photo" loading="lazy"></div>`;
  }).join("\n      ");

  const renderedBody = renderTemplate(tmpl.html.body, tokenMap, { maxLen: TEMPLATE_LIMITS.html });
  const renderedRoutine = tmpl.html.includeRoutine
    ? renderTemplate("[Routine]", tokenMap, { maxLen: TEMPLATE_LIMITS.html })
    : "";
  const mediaList = (mediaFilenames || []).filter(f => !_scRe.test(f));
  const photoCount = mediaList.filter(f => !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length;
  const videoCount = mediaList.filter(f => /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)).length;
  const footerInfoLines = [
    educatorName ? `Educator: ${escHtml(educatorName)}` : "",
    `📷 ${photoCount} photo${photoCount !== 1 ? "s" : ""}${videoCount > 0 ? ` · 🎬 ${videoCount} video${videoCount !== 1 ? "s" : ""}` : ""}`,
    `${escHtml(childName || "")}${childAge ? ` @ ${escHtml(childAge)}` : ""}`.trim(),
    roomName ? escHtml(roomName) : "",
    centreName ? escHtml(centreName) : "",
  ].filter(Boolean);
  // Routine section (displayed below photos, above footer)
  const routineSection = renderedRoutine
    ? `
  <div class="routine-separator" aria-hidden="true"></div>
  <section class="routine-block">
    <div class="routine-label">📋 ${childFirst ? escHtml(childFirst) + "'s" : "Daily"} Routine</div>
    <div class="routine-text">${escHtml(renderedRoutine)}</div>
  </section>`
    : "";

  // Story body — placeholder when empty
  const bodyHtml = renderedBody
    ? `<div class="body">${escHtml(renderedBody).replace(/\n/g, "<br>")}</div>`
    : `<div class="body empty">📄 Story text not yet available — run a scan to restore the full story.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title || "Story")} — ${dateDisplay}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1120px; margin: 0 auto; padding: 40px 36px; color: #333; line-height: 1.7; background: #f5f7fa; }
    nav { margin-bottom: 20px; font-size: 13px; color: #888; }
    nav a { color: #0f3460; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
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
    .full-content { background: #fff; border-radius: 20px; box-shadow: 0 3px 18px rgba(0,0,0,0.08); margin-bottom: 28px; overflow: hidden; }
    .story-header-bar { background:#0f3460; color:#fff; padding:18px 22px; display:flex; justify-content:space-between; align-items:flex-start; gap:14px; }
    .story-header-left { font-size:14px; line-height:1.45; font-weight:500; }
    .story-header-left .date { font-size:30px; line-height:1.1; font-weight:700; margin-bottom:4px; }
    .story-header-right { text-align:right; font-size:14px; line-height:1.45; font-weight:600; opacity:0.95; }
    .story-content { padding: 44px 42px; }
    .full-content h2 { font-size: 46px; line-height: 1.08; color: #1f2d45; margin-bottom: 14px; letter-spacing: -0.01em; max-width: 740px; }
    .story-meta { display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; margin-bottom:18px; padding-bottom:12px; border-bottom:1px solid #d9e2ef; font-size:13px; color:#5d6674; }
    .story-meta .meta-pill { background:#f3f6fb; border:1px solid #dce6f4; border-radius:999px; padding:4px 10px; font-size:12px; color:#3d4e66; }
    .body { font-size: 18px; line-height: 1.8; margin-bottom: 22px; white-space: pre-wrap; color: #313946; max-width: 820px; font-weight: 400; letter-spacing: -0.005em; }
    .body.empty { color: #999; font-style: italic; font-size: 13px; }
    .photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .photo:first-child { grid-column: 1 / -1; }
    .photo img { width: 100%; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.10); cursor: pointer; transition: opacity 0.15s; display: block; }
    .photo:first-child img { max-height: 640px; object-fit: cover; }
    .photo video { width:100%; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.10); display:block; background:#000; }
    .photo img:hover { opacity: 0.88; }
    .photo img.zoomed { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; object-fit: contain; background: rgba(0,0,0,0.92); z-index: 9999; border-radius: 0; cursor: zoom-out; padding: 24px; opacity: 1; }
    .divider-line { border-top: 2px solid #c5d3e8; margin: 16px 0; }
    .routine-separator { border-top: 2px solid #c5d3e8; margin: 12px 0 14px; width: 100%; }
    .routine-block { margin: 0 0 24px; padding: 16px 18px; background:#f7f9fc; border:1px solid #dce6f4; border-radius:12px; }
    .routine-label { font-size: 16px; font-weight: 700; color: #0f3460; margin-bottom: 10px; }
    .routine-text { font-size: 15px; white-space: pre-line; color: #2f3a48; line-height: 1.9; margin-bottom: 0; max-width: 820px; }
    .story-footer { border-top:1px solid #cdd9e7; margin-top:22px; padding-top:10px; display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
    .story-footer-left { font-size:11px; color:#666; line-height:1.65; }
    .story-footer-right { text-align:right; font-size:11px; color:#9aa3b2; line-height:1.5; }
    .footer { font-size: 11px; color: #aaa; text-align: center; margin-top: 16px; }
    @media (max-width: 900px) { .full-content h2 { font-size: 36px; } .body { font-size: 16px; } }
    @media (max-width: 600px) { .preview-card { flex-direction: column; } .preview-img, .preview-placeholder { width: 100%; min-width: 0; height: 200px; } body { padding: 16px; } .story-header-bar { padding:12px; } .story-header-left .date { font-size:20px; } .story-content { padding: 22px; } .full-content h2 { font-size: 30px; } .body { font-size: 16px; max-width: 100%; } .photos { grid-template-columns: 1fr; } }
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
    <a href="../index.html">← Back to all stories</a> ·
    <a href="../../../index.html">← All children</a>
  </nav>

  <div class="full-content">
    <div class="story-header-bar">
      <div class="story-header-left">
        <div class="date">${dateDisplay}</div>
        <div>${escHtml(childName || "Child")}${childAge ? ` · ${escHtml(childAge)}` : ""}</div>
      </div>
      <div class="story-header-right">
        ${escHtml(centreName || "")}<br>${escHtml(roomName || "")}
      </div>
    </div>
    <div class="story-content">
    <h2>${escHtml(title || "Story")}</h2>
    <div class="story-meta">
      <span class="meta-pill">📅 ${dateDisplay}</span>
      ${educatorName ? `<span class="meta-pill">👩‍🏫 ${escHtml(educatorName)}</span>` : ""}
      ${childName ? `<span class="meta-pill">👶 ${escHtml(childName)}${childAge ? ` @ ${escHtml(childAge)}` : ""}</span>` : ""}
      ${roomName ? `<span class="meta-pill">🏠 ${escHtml(roomName)}</span>` : ""}
      ${centreName ? `<span class="meta-pill">📍 ${escHtml(centreName)}</span>` : ""}
      <span class="meta-pill">🖼 ${photoCount} photo${photoCount !== 1 ? "s" : ""}</span>
      ${videoCount > 0 ? `<span class="meta-pill">🎬 ${videoCount} video${videoCount !== 1 ? "s" : ""}</span>` : ""}
    </div>
    ${bodyHtml}
    ${mediaHtml ? `<div class="photos">\n      ${mediaHtml}\n    </div>` : ""}
    ${routineSection}
    <div class="story-footer">
      <div class="story-footer-left">
        ${footerInfoLines.join("<br>")}
      </div>
      <div class="story-footer-right">
        Storypark Smart Saver<br>
        storypark.com
      </div>
    </div>
    </div>
  </div>

  <div class="footer">Saved from Storypark by Storypark Smart Saver</div>
</body>
</html>`;
}

/**
 * Build a stable export base name that matches story folder naming:
 *   "YYYY-MM-DD - Story Title"
 */
export function getStoryExportBaseName(folderName, storyDate, storyTitle) {
  const raw = String(folderName || "").trim()
    || `${String(storyDate || "").trim() || "story"} - ${String(storyTitle || "Story").trim() || "Story"}`;
  // Windows-safe filename base:
  // - remove illegal path chars (sanitizeName)
  // - strip non-ASCII/emoji
  // - collapse spacing
  // - cap length to avoid path/FS issues
  const asciiSafe = sanitizeName(raw)
    .replace(/_/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const MAX_BASE_LEN = 100;
  return (asciiSafe.slice(0, MAX_BASE_LEN).trim() || "story");
}

/**
 * Return HTML export filename(s) for a story folder.
 * Primary is folder-style naming:
 *   "YYYY-MM-DD - Story Title.html"
 * A legacy fallback is kept for backward compatibility with old exports.
 */
export function getStoryHtmlFilenames(storyDate, storyTitle, folderName = "") {
  const base = getStoryExportBaseName(folderName, storyDate, storyTitle);
  const primary = `${base || "story"}.html`;
  const legacy = primary.toLowerCase() === "story.html" ? "" : "story.html";
  return { primary, legacy };
}

/**
 * Return card filename aligned to story folder structure:
 *   "YYYY-MM-DD - Story Title.jpg"
 */
export function getStoryCardFilename(storyDate, storyTitle, folderName = "") {
  return `${getStoryExportBaseName(folderName, storyDate, storyTitle)}.jpg`;
}

/**
 * Build the root-level children index HTML page.
 * @param {Array<{id: string, name: string}>} children
 * @returns {string} HTML document
 */
export function buildChildrenIndexHtml(children) {
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sanitize = (s) => (s || "Unknown").replace(/[/\\:*?"<>|]/g, "_").trim() || "Unknown";
  
  const cards = (children || []).map(c => {
    const safeName = sanitize(c.name);
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
 * Build the per-child story index HTML page.
 * @param {string} childName
 * @param {Array} manifests - Story manifests from getDownloadedStories()
 * @returns {string} HTML document
 */
export function buildMasterIndexHtml(childName, manifests) {
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const _scRe = /Story Card\.jpg$/i;
  
  // Dedup by storyId
  const _dd = new Map();
  for (const m of (manifests || [])) {
    const sid = m.storyId || m.folderName;
    const ex = _dd.get(sid);
    const cnt = (m.approvedFilenames || []).filter(f => !_scRe.test(f)).length;
    if (!ex || cnt > (ex.approvedFilenames || []).filter(f => !_scRe.test(f)).length) _dd.set(sid, m);
  }
  const sorted = [..._dd.values()].sort((a, b) => (b.storyDate || "").localeCompare(a.storyDate || ""));

  const cards = sorted.map(m => {
    const thumb = m.thumbnailFilename && !_scRe.test(m.thumbnailFilename)
      ? `<img src="./${encodeURIComponent(m.folderName)}/${encodeURIComponent(m.thumbnailFilename)}" alt="" loading="lazy">`
      : ((m.approvedFilenames || []).find(f => !_scRe.test(f))
          ? `<img src="./${encodeURIComponent(m.folderName)}/${encodeURIComponent((m.approvedFilenames).find(f => !_scRe.test(f)))}" alt="" loading="lazy">`
          : `<div class="no-thumb">📸</div>`);
    const date = formatDateDMY(m.storyDate) || m.storyDate || "";
    const meta = [
      m.educatorName ? `👩‍🏫 ${escHtml(m.educatorName)}` : "",
      m.roomName ? `🏠 ${escHtml(m.roomName)}` : "",
    ].filter(Boolean).join(" · ");
    const photoCount = (m.approvedFilenames || []).length;

    const htmlNames = getStoryHtmlFilenames(m.storyDate, m.storyTitle, m.folderName);
    const storyHtmlTarget = m.storyHtmlFilename || htmlNames.primary;
    return `<a href="./${encodeURIComponent(m.folderName)}/${encodeURIComponent(storyHtmlTarget)}" class="story-card">
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

/** Format date string from YYYY-MM-DD to DD/MM/YYYY */
function formatDateDMY(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return "";
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return dateStr;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

// Compatibility aliases for background.js (which uses buildStoryHtml)
// and scan-engine.js (which may also use the old names)
export const buildStoryHtml = buildStoryPage;
export const buildChildrenIndex = buildChildrenIndexHtml;
export const buildChildStoriesIndex = buildMasterIndexHtml;
