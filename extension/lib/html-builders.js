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
}) {
  const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const childFirst = (childName || "").split(/\s+/)[0];
  const dateDisplay = formatDateDMY(date) || date || "Unknown date";
  
  // Story Card JPEGs are generated assets for Google Photos, not gallery images
  const _scRe = /Story Card\.jpg$/i;
  const mediaHtml = (mediaFilenames || []).filter(f => !_scRe.test(f)).map(f => {
    const enc = encodeURIComponent(f);
    if (/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f)) {
      return `<div class="photo"><video src="./${enc}" controls preload="metadata" style="width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);"></video></div>`;
    }
    return `<div class="photo"><img src="./${enc}" alt="Story photo" loading="lazy"></div>`;
  }).join("\n      ");

  // Attribution block
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
    : `<div class="body empty">📄 Story text not yet available — run a scan to restore the full story.</div>`;

  // Preview card: thumbnail + date + title + educator + excerpt + photo count
  const firstPhoto = (mediaFilenames || []).filter(f => !_scRe.test(f) && !/\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i.test(f))[0];
  const previewThumb = firstPhoto
    ? `<img src="./${encodeURIComponent(firstPhoto)}" alt="" class="preview-img" onclick="this.closest('.preview-card').nextElementSibling.scrollIntoView({behavior:'smooth'})">`
    : `<div class="preview-img preview-placeholder">📸</div>`;
  const previewExcerpt = (body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().substring(0, 200);
  const displayPhotoCount = (mediaFilenames || []).filter(f => !_scRe.test(f)).length;

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
    <a href="../index.html">← Back to all stories</a> ·
    <a href="../../../index.html">← All children</a>
  </nav>

  <div class="preview-card" onclick="document.querySelector('.full-content').scrollIntoView({behavior:'smooth'})">
    ${previewThumb}
    <div class="preview-info">
      <div class="preview-date">📅 ${dateDisplay}</div>
      <div class="preview-title">${escHtml(title || "Story")}</div>
      ${educatorName ? `<div class="preview-educator">👩‍🏫 ${escHtml(educatorName)}</div>` : ""}
      <div class="preview-excerpt">${escHtml(previewExcerpt)}${previewExcerpt.length >= 200 ? "…" : ""}</div>
      <div class="preview-photos">${displayPhotoCount} photo${displayPhotoCount !== 1 ? "s" : ""}</div>
    </div>
  </div>

  <div class="full-content">
    <h2>${escHtml(title || "Story")}</h2>
    ${bodyHtml}
    ${mediaHtml ? `<div class="photos">\n      ${mediaHtml}\n    </div>` : ""}
    ${routineSection}
  </div>

  <div class="footer">
    Saved from Storypark by Storypark Smart Saver — ${new Date().toISOString().split("T")[0]}
  </div>
</body>
</html>`;
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

    return `<a href="./${encodeURIComponent(m.folderName)}/story.html" class="story-card">
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
