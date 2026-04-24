/**
 * offscreen-card.js — Story Card Canvas renderer
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All Canvas-based story card rendering logic: text layout helpers, │
 * │  the main createStoryCard() function, and JPEG + EXIF stamping.    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Face detection → offscreen.js                                     │
 * │  Image/video downloads → offscreen.js                              │
 * │  Message routing → offscreen.js                                    │
 * │  EXIF writing logic → lib/exif.js                                  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * CARD LAYOUT (top → bottom):
 *   HEADER (HDR_H px)   — navy bar: date + child name, centre + room
 *   TITLE               — bold wrapped text
 *   ─── divider ───
 *   BODY                — full educator text (no truncation)
 *   ROUTINE             — "Child's Routine" header + timestamped events (if present)
 *   ─── divider ───
 *   FOOTER (FTR_H px)   — educator name, photo count, attribution, branding
 *
 * EXPORTS:
 *   createStoryCard(msg, applyExifFn, blobToDataUrlFn)
 *     msg = { title, date, body, centreName, roomName, educatorName,
 *             childName, childAge, routineText, photoCount, gpsCoords,
 *             exifArtist, iptcCaption, iptcKeywords, iptcByline, savePath }
 *     Returns: Promise<string>  — JPEG data URL with EXIF + IPTC stamped
 */

/* ================================================================== */
/*  Text layout helpers                                                */
/* ================================================================== */

/**
 * Strip HTML tags, converting block elements to newlines.
 * Handles: <br>, <p>, <div>, <li>, HTML entities.
 *
 * @param {string} html
 * @returns {string} plain text
 */
export function stripHtmlForCard(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Word-wrap text into lines that fit within maxWidth pixels.
 * Empty strings are emitted for blank paragraph breaks.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapTextToLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) { lines.push(""); continue; }
    const words = para.split(" ");
    let cur = "";
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

/**
 * Draw word-wrapped text starting at baseline y.
 * Returns y position AFTER the last line.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y       — baseline y of the first line
 * @param {number} maxWidth
 * @param {number} lineHeight
 * @returns {number} y after the last line
 */
export function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
  for (const line of wrapTextToLines(ctx, text, maxWidth)) {
    if (line) ctx.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

/**
 * Measure pixel height of a wrapped text block without drawing.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} lineHeight
 * @returns {number}
 */
export function measureWrappedTextHeight(ctx, text, maxWidth, lineHeight) {
  return wrapTextToLines(ctx, text, maxWidth).length * lineHeight;
}

/**
 * Format YYYY-MM-DD to "D Month YYYY" (e.g. "24 April 2026").
 *
 * @param {string} dateStr
 * @returns {string}
 */
export function formatCardDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length < 3) return dateStr;
  const MONTHS = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
  ];
  const d = parseInt(parts[2], 10);
  const m = parseInt(parts[1], 10) - 1;
  return `${d} ${MONTHS[m] || ""} ${parts[0]}`;
}

/* ================================================================== */
/*  Card renderer                                                      */
/* ================================================================== */

/**
 * Render a Story Card JPEG and return a data URL with EXIF + IPTC stamped.
 *
 * @param {Object}   msg               — see module header for field list
 * @param {Function} applyExifFn       — async (blob, date, desc, gps, opts) => Blob
 * @param {Function} blobToDataUrlFn   — async (blob) => dataUrl string
 * @returns {Promise<string>} JPEG data URL
 */
export async function renderStoryCard(msg, applyExifFn, blobToDataUrlFn) {
  const {
    title        = "",
    date         = "",
    body         = "",
    centreName   = "",
    roomName     = "",
    educatorName = "",
    childName    = "",
    childAge     = "",
    routineText  = "",
    photoCount   = 0,
    gpsCoords    = null,
    exifArtist   = "",
    iptcCaption  = "",
    iptcKeywords = [],
    iptcByline   = "",
  } = msg;

  // ── Layout constants ──
  const CARD_W  = 1200;
  const PAD     = 110;    // generous padding prevents text touching edges
  const TEXT_W  = CARD_W - PAD * 2;
  const HDR_H   = 150;    // header height
  const FTR_H   = 200;    // footer height (full attribution)
  const GAP     = 40;     // gap between sections

  const TITLE_SIZE   = 46;
  const TITLE_LINE_H = TITLE_SIZE * 1.3;
  const BODY_SIZE    = 22;
  const BODY_LINE_H  = BODY_SIZE * 1.65;
  const ROU_SIZE     = 20;
  const ROU_LINE_H   = ROU_SIZE * 1.6;

  const plainTitle   = stripHtmlForCard(title);
  const plainBody    = stripHtmlForCard(body);
  const plainRoutine = stripHtmlForCard(routineText);
  const fmtDate      = formatCardDate(date);

  // ── Measure section heights ──
  const tmp   = document.createElement("canvas");
  tmp.width   = CARD_W;
  tmp.height  = 100;
  const mctx  = tmp.getContext("2d");

  mctx.font = `bold ${TITLE_SIZE}px "Segoe UI", Arial, sans-serif`;
  const titleH = measureWrappedTextHeight(mctx, plainTitle, TEXT_W, TITLE_LINE_H);

  mctx.font = `${BODY_SIZE}px "Segoe UI", Arial, sans-serif`;
  const bodyH = plainBody ? measureWrappedTextHeight(mctx, plainBody, TEXT_W, BODY_LINE_H) : 0;

  mctx.font = `${ROU_SIZE}px "Segoe UI", Arial, sans-serif`;
  const rouBodyH  = plainRoutine ? measureWrappedTextHeight(mctx, plainRoutine, TEXT_W, ROU_LINE_H) : 0;
  // Routine section overhead: dividers + header block + gaps = ~134px
  const routineH  = plainRoutine ? (rouBodyH + 134) : 0;

  const totalH = HDR_H
    + PAD + titleH
    + GAP + 2 + GAP       // body divider
    + (bodyH ? bodyH + GAP : 0)
    + routineH
    + 2 + 16              // footer divider + gap
    + FTR_H;

  // ── Create drawing canvas ──
  const canvas  = document.createElement("canvas");
  canvas.width  = CARD_W;
  canvas.height = Math.max(totalH, 500);
  const ctx     = canvas.getContext("2d");

  // ── Background ──
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CARD_W, canvas.height);

  // ── Header bar (navy) ──
  ctx.fillStyle = "#0f3460";
  ctx.fillRect(0, 0, CARD_W, HDR_H);
  ctx.textBaseline = "middle";

  // Left: date + child name/age
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold 28px "Segoe UI", Arial, sans-serif`;
  ctx.fillText(fmtDate, PAD, HDR_H / 2 - 16);
  ctx.font = `20px "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const childLine = childAge ? `${childName}  ·  ${childAge}` : childName;
  ctx.fillText(childLine, PAD, HDR_H / 2 + 18);

  // Right: centre + room
  ctx.textAlign = "right";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold 20px "Segoe UI", Arial, sans-serif`;
  ctx.fillText(centreName, CARD_W - PAD, HDR_H / 2 - 16);
  ctx.font = `17px "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(roomName, CARD_W - PAD, HDR_H / 2 + 18);

  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  let y = HDR_H + PAD;

  // ── Title ──
  ctx.fillStyle = "#0f3460";
  ctx.font = `bold ${TITLE_SIZE}px "Segoe UI", Arial, sans-serif`;
  y = drawWrappedText(ctx, plainTitle, PAD, y + TITLE_SIZE, TEXT_W, TITLE_LINE_H);

  // ── Body divider ──
  y += GAP;
  ctx.fillStyle = "#c5d3e8";
  ctx.fillRect(PAD, y, TEXT_W, 2);
  y += 2 + GAP;

  // ── Body text ──
  if (plainBody) {
    ctx.fillStyle = "#2C2C2C";
    ctx.font = `${BODY_SIZE}px "Segoe UI", Arial, sans-serif`;
    y = drawWrappedText(ctx, plainBody, PAD, y + BODY_SIZE, TEXT_W, BODY_LINE_H);
    y += GAP;
  }

  // ── Routine section ──
  if (plainRoutine) {
    ctx.fillStyle = "#c5d3e8";
    ctx.fillRect(PAD, y, TEXT_W, 2);
    y += 2 + 14;

    const childFirstCard = (childName || "").split(/\s+/)[0];
    ctx.fillStyle = "#0f3460";
    ctx.font = `bold 20px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(childFirstCard ? `${childFirstCard}'s Routine` : "Daily Routine", PAD, y + 20);
    y += 50;

    ctx.fillStyle = "#333";
    ctx.font = `${ROU_SIZE}px "Segoe UI", Arial, sans-serif`;
    y = drawWrappedText(ctx, plainRoutine, PAD, y + ROU_SIZE, TEXT_W, ROU_LINE_H);
    y += 14;

    ctx.fillStyle = "#c5d3e8";
    ctx.fillRect(PAD, y, TEXT_W, 2);
    y += 2 + GAP;
  }

  // ── Footer divider ──
  ctx.fillStyle = "#c5d3e8";
  ctx.fillRect(PAD, y, TEXT_W, 2);
  y += 2 + 16;

  // ── Footer left: attribution ──
  const FOOTER_SIZE = 14;
  const FOOTER_LINE = 22;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign    = "left";
  let fy = y;
  ctx.fillStyle = "#555555";
  ctx.font = `${FOOTER_SIZE}px "Segoe UI", Arial, sans-serif`;
  if (educatorName) { ctx.fillText(`Educator: ${educatorName}`, PAD, fy); fy += FOOTER_LINE; }
  if (photoCount > 0) { ctx.fillText(`📷 ${photoCount} photo${photoCount !== 1 ? "s" : ""}`, PAD, fy); fy += FOOTER_LINE; }
  const childAtAge = (childName && childAge) ? `${childName} @ ${childAge}` : (childName || "");
  if (childAtAge) { ctx.fillStyle = "#666666"; ctx.fillText(childAtAge, PAD, fy); fy += FOOTER_LINE; }
  if (roomName)   { ctx.fillStyle = "#777777"; ctx.fillText(roomName, PAD, fy);   fy += FOOTER_LINE; }
  if (centreName) { ctx.fillStyle = "#777777"; ctx.fillText(centreName, PAD, fy); fy += FOOTER_LINE; }
  ctx.fillStyle = "#999999";
  ctx.font = `12px "Segoe UI", Arial, sans-serif`;
  ctx.fillText("Storypark / Storypark Smart Saver", PAD, fy);

  // ── Footer right: branding ──
  ctx.textAlign = "right";
  ctx.fillStyle = "#AAAAAA";
  ctx.font = `13px "Segoe UI", Arial, sans-serif`;
  ctx.fillText("Storypark Smart Saver", CARD_W - PAD, y);
  ctx.fillStyle = "#C0C0C0";
  ctx.font = `12px "Segoe UI", Arial, sans-serif`;
  ctx.fillText("storypark.com", CARD_W - PAD, y + FOOTER_LINE);
  ctx.textAlign = "left";

  // ── Convert canvas → JPEG Blob ──
  const rawDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const base64b    = rawDataUrl.split(",")[1];
  const binaryb    = atob(base64b);
  const bytesb     = new Uint8Array(binaryb.length);
  for (let i = 0; i < binaryb.length; i++) bytesb[i] = binaryb.charCodeAt(i);
  const blob = new Blob([bytesb], { type: "image/jpeg" });

  // ── Stamp EXIF + IPTC ──
  const dateObj     = date ? new Date(`${date}T12:00:00`) : new Date();
  const cardArtist  = exifArtist || `Storypark Smart Saver — ${centreName}`;
  const cardCaption = iptcCaption
    || [plainTitle, childName, roomName, centreName].filter(Boolean).join(" · ");
  const cardKeywords = (iptcKeywords && iptcKeywords.length > 0)
    ? iptcKeywords
    : [childName, centreName, "Storypark Story Card"].filter(Boolean);

  const stampedBlob = await applyExifFn(blob, dateObj, `${plainTitle} — ${childName}`, gpsCoords, {
    exifTitle:    plainTitle,
    exifSubject:  childName,
    exifComments: `Story by ${educatorName || "Educator"} on ${fmtDate}`,
    exifArtist:   cardArtist,
    iptcCaption:  cardCaption,
    iptcKeywords: cardKeywords,
    iptcByline:   iptcByline || educatorName || "",
  });

  return blobToDataUrlFn(stampedBlob);
}
