/**
 * metadata-helpers.js — Pure string/date/EXIF helper functions
 *
 * All exports are pure functions with no side effects, no Chrome API calls,
 * and no imports from other lib/ files.  Safe to import from both the
 * service worker (background.js) and extension pages (dashboard.js).
 *
 * Exported functions:
 *   formatDateDMY      — YYYY-MM-DD → DD/MM/YYYY
 *   formatETA          — milliseconds → "~Xh Ym" human string
 *   sanitizeName       — strip filesystem-illegal chars from a name
 *   sanitizeSavePath   — strip non-ASCII from a full save path
 *   stripHtml          — remove HTML tags, collapse whitespace
 *   stripEmojis        — remove emoji/Unicode symbols (for EXIF ASCII fields)
 *   calculateAge       — birthday + date → "X years Y months"
 *   buildExifMetadata  — build structured { title, subject, comments }
 *   sanitiseForExif    — strip to printable ASCII, max 255 chars
 *   sanitiseForIptcCaption — truncate to max UTF-8 byte count (IPTC 2:120)
 */

/* ================================================================== */
/*  Date formatting                                                    */
/* ================================================================== */

/**
 * Convert a YYYY-MM-DD or ISO 8601 date string to DD/MM/YYYY format.
 * Returns the original string unchanged if it cannot be parsed.
 *
 * @param {string} isoOrYMD - e.g. "2024-03-15" or "2024-03-15T10:30:00Z"
 * @returns {string} e.g. "15/03/2024"
 */
export function formatDateDMY(isoOrYMD) {
  if (!isoOrYMD) return "";
  const ymd = isoOrYMD.split("T")[0]; // strip time component if present
  const [year, month, day] = ymd.split("-");
  if (!year || !month || !day) return isoOrYMD;
  if (!/^\d+$/.test(year) || !/^\d+$/.test(month) || !/^\d+$/.test(day)) return isoOrYMD;
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
}

/**
 * Format milliseconds as a human-readable ETA for progress displays.
 * Returns "" if ms is zero, negative, or too few samples to be meaningful.
 * @param {number} ms
 * @returns {string} e.g. "~2h 15m" | "~45m" | "~3m" | "< 1m"
 */
export function formatETA(ms) {
  if (!ms || ms <= 0 || !isFinite(ms)) return "";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return "< 1m";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
  return `~${m}m`;
}

/* ================================================================== */
/*  Name / path sanitization                                           */
/* ================================================================== */

/** Characters forbidden in filesystem filenames across Windows/macOS/Linux. */
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/**
 * Strip filesystem-illegal characters from a child/centre/room name.
 * Returns "Unknown" if the result is empty after stripping.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  return (name || "Unknown").replace(INVALID_FILENAME_CHARS, "_").trim() || "Unknown";
}

/**
 * Sanitize a file system save path before passing to chrome.downloads.download.
 * Applies to each path segment individually, preserving "/" separators.
 * Converts em dash / en dash to regular hyphen, strips other non-ASCII that
 * Chrome's downloads API rejects on some platforms.
 *
 * @param {string} path  e.g. "Storypark Smart Saver/Hugo Hill/Stories/..."
 * @returns {string}     ASCII-safe path
 */
export function sanitizeSavePath(path) {
  return path.split("/")
    .map(seg => seg
      .replace(/[\u2014\u2013\u2012]/g, "-") // em dash, en dash, figure dash → hyphen
      .replace(/[\u2018\u2019]/g, "'")        // curly single quotes → straight
      .replace(/[\u201C\u201D]/g, '"')        // curly double quotes → straight
      .replace(/[^\x20-\x7E]/g, "")           // strip any remaining non-ASCII
      .replace(/\s{2,}/g, " ")                // collapse multiple spaces
      .trim()
    )
    .join("/");
}

/* ================================================================== */
/*  Text cleaning                                                      */
/* ================================================================== */

function _decodeHtmlEntities(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function _normaliseRichTextInput(input) {
  if (input == null) return "";
  if (Array.isArray(input)) {
    return input
      .map((part) => {
        if (typeof part === "string") return part;
        return _normaliseRichTextInput(part?.text || part?.content || part?.value || "");
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof input !== "string") return String(input);
  return input;
}

/**
 * Convert API body/rich-text input to readable plain text with paragraph breaks.
 * Unlike stripHtml(), this preserves paragraph spacing for story rendering.
 * @param {string|Array|Object} input
 * @returns {string}
 */
export function normaliseStoryText(input) {
  const base = _normaliseRichTextInput(input);
  return _decodeHtmlEntities(
    base
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

/**
 * Strip HTML tags from a string, collapse whitespace, and trim.
 * @param {string|Array|Object} html
 * @returns {string}
 */
export function stripHtml(html) {
  return normaliseStoryText(html).replace(/\s+/g, " ").trim();
}

/**
 * Strip emojis and other non-ASCII characters from text to prevent EXIF
 * corruption. EXIF uses ASCII/Latin-1 encoding; emojis and multi-byte
 * Unicode characters can corrupt the image file.
 *
 * @param {string} text
 * @returns {string} ASCII-safe text
 */
export function stripEmojis(text) {
  if (!text) return "";
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "")   // emoticons
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, "")   // misc symbols & pictographs
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "")   // transport & map
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "")   // flags
    .replace(/[\u{2600}-\u{26FF}]/gu, "")      // misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, "")      // dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")      // variation selectors
    .replace(/[\u{200D}]/gu, "")               // zero-width joiner
    .replace(/[\u{20E3}]/gu, "")               // combining enclosing keycap
    .replace(/[\u{E0020}-\u{E007F}]/gu, "")   // tags
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, "")   // supplemental symbols
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, "")   // chess symbols
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, "")   // symbols extended-A
    .replace(/[\u{2300}-\u{23FF}]/gu, "")      // misc technical
    .replace(/[\u{2B50}]/gu, "star")            // star
    .replace(/[\u{2764}]/gu, "heart")           // heart
    .replace(/\s{2,}/g, " ")                    // collapse multiple spaces
    .trim();
}

/* ================================================================== */
/*  Age calculation                                                    */
/* ================================================================== */

/**
 * Calculate child's age at a given date from their birthday.
 * Returns a human-readable string like "2 years 3 months" or "8 months".
 *
 * @param {string} birthday  YYYY-MM-DD format
 * @param {string} atDate    YYYY-MM-DD format (story date)
 * @returns {string} e.g. "1 year 5 months" or "3 months" or ""
 */
export function calculateAge(birthday, atDate) {
  if (!birthday || !atDate) return "";
  const birth = new Date(birthday + "T00:00:00Z");
  const at    = new Date(atDate + "T00:00:00Z");
  if (isNaN(birth.getTime()) || isNaN(at.getTime()) || at < birth) return "";

  let years  = at.getUTCFullYear() - birth.getUTCFullYear();
  let months = at.getUTCMonth() - birth.getUTCMonth();
  if (at.getUTCDate() < birth.getUTCDate()) months--;
  if (months < 0) { years--; months += 12; }

  const parts = [];
  if (years > 0) parts.push(`${years} year${years !== 1 ? "s" : ""}`);
  if (months > 0) parts.push(`${months} month${months !== 1 ? "s" : ""}`);
  if (parts.length === 0) parts.push("newborn");
  return parts.join(" ");
}

/* ================================================================== */
/*  EXIF / IPTC metadata builders                                      */
/* ================================================================== */

/**
 * Build structured EXIF metadata for a photo.
 * Returns { title, subject, comments } where:
 *   title    → EXIF ImageDescription (short: "Harry - 8 months")
 *   subject  → EXIF XPSubject (short story excerpt)
 *   comments → EXIF UserComment (full story + timestamped routine + attribution)
 *
 * Also returns a legacy `description` field (full text) for backward compatibility.
 *
 * @param {string} body              Story body text (may contain HTML)
 * @param {string} childFirstName    First name only
 * @param {string|{summary,detailed}} routineData  Routine text or object
 * @param {string} roomName
 * @param {string} centreName
 * @param {string} [childAge]        e.g. "1 year 5 months"
 * @returns {{ title: string, subject: string, comments: string, description: string }}
 */
export function buildExifMetadata(body, childFirstName, routineData, roomName, centreName, childAge = "") {
  // routineData may be a string (legacy) or { summary, detailed } object
  const routineSummary  = typeof routineData === "string" ? routineData : (routineData?.summary || "");
  const routineDetailed = typeof routineData === "string" ? routineData : (routineData?.detailed || "");

  // ── Title: short identifier ──
  const titleParts = [childFirstName || "Child"];
  if (childAge) titleParts.push(childAge);
  const title = stripEmojis(titleParts.join(" - "));

  // ── Subject: short excerpt of the story ──
  const plainBody = stripHtml(body);
  const subject = stripEmojis((plainBody || "").substring(0, 200));

  // ── Comments: full story + timestamped routine + attribution ──
  const commentParts = [];
  if (plainBody) commentParts.push(plainBody);
  if (routineDetailed || routineSummary) {
    const routineLabel = childFirstName ? `${childFirstName}'s Routine:` : "Routine:";
    const routineBody = routineDetailed || routineSummary;
    commentParts.push("------------------------------");
    commentParts.push(`${routineLabel}\n${routineBody}`);
  }
  commentParts.push("------------------------------");
  if (childFirstName && childAge) commentParts.push(`${childFirstName} @ ${childAge}`);
  if (roomName) commentParts.push(roomName);
  if (centreName) commentParts.push(centreName);
  commentParts.push("Storypark");
  const comments = stripEmojis(commentParts.join("\n"));

  // Legacy single-string description (backward compat)
  const description = comments;

  return { title, subject, comments, description };
}

/**
 * Strip non-ASCII characters for use in EXIF ASCII fields (Artist, Keywords, etc.).
 * Converts common Unicode punctuation to ASCII first, then removes remaining
 * non-printable/non-ASCII bytes.
 *
 * @param {string} text
 * @param {number} [maxLen=255]  EXIF ASCII field limit
 * @returns {string} ASCII-safe string
 */
export function sanitiseForExif(text, maxLen = 255) {
  return (text || "")
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, "--")
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, maxLen);
}

/**
 * Truncate plain text to a maximum UTF-8 byte count for IPTC Caption-Abstract (2:120).
 * Uses TextEncoder for accurate UTF-8 byte measurement, gracefully truncating at a
 * character boundary to avoid splitting multi-byte sequences.
 *
 * @param {string} text     Already HTML-stripped plain text
 * @param {number} maxBytes Max UTF-8 byte count (IPTC limit = 2000)
 * @returns {string}
 */
export function sanitiseForIptcCaption(text, maxBytes = 2000) {
  const clean = (text || "").replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "").trim();
  try {
    const enc = new TextEncoder();
    const bytes = enc.encode(clean);
    if (bytes.length <= maxBytes) return clean;
    return new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.slice(0, maxBytes))
      .replace(/\uFFFD.*$/, "")
      .trim();
  } catch {
    return clean.slice(0, maxBytes);
  }
}

/* ================================================================== */
/*  Template settings + token rendering                                */
/* ================================================================== */

export const TEMPLATE_LIMITS = Object.freeze({
  html: 20000,
  card: 4000,
  exifTitle: 120,
  exifSubject: 200,
  exifComments: 1800,
});

/** Max rendered characters for story card title (canvas layout). */
export const CARD_TITLE_MAX_CHARS = 220;

export const DEFAULT_TEMPLATE_SETTINGS = Object.freeze({
  html: {
    header: "[StoryDate] | [ChildName] | [Class] | [CentreName]",
    body: "[StoryBody]",
    includeRoutine: true,
    includePhotos: true,
    footer: "[EducatorName] | [PhotoCount] photos | Storypark Smart Saver",
    footerSpacingPx: 24,
  },
  card: {
    title: "[StoryTitle]",
    body: "[StoryBody]",
    includeRoutine: true,
    footerLeft: "Educator: [EducatorName] | [PhotoCount] photos",
    footerRight: "Storypark Smart Saver",
  },
  exif: {
    title: "[ChildName] - [ChildAge]",
    subject: "[StoryBody]",
    comments: "[StoryBody]\n---\n[Routine]\n---\n[CentreName] | [Class]",
    includeStoryBody: true,
    includeRoutine: true,
  },
});

function _truncateWithEllipsis(text, maxLen) {
  const s = String(text ?? "");
  if (!maxLen || s.length <= maxLen) return s;
  if (maxLen <= 1) return "…";
  return `${s.slice(0, maxLen - 1)}…`;
}

function _cleanDelimiterRuns(text) {
  return String(text ?? "")
    .replace(/\s+\|\s+\|\s+/g, " | ")
    .replace(/\s+-\s+-\s+/g, " - ")
    .replace(/\s{2,}/g, " ")
    .replace(/(?:\s*[|,-]\s*)+$/g, "")
    .replace(/^(?:\s*[|,-]\s*)+/g, "")
    .trim();
}

export function mergeTemplateSettings(input) {
  const inObj = input && typeof input === "object" ? input : {};
  return {
    html: { ...DEFAULT_TEMPLATE_SETTINGS.html, ...(inObj.html || {}) },
    card: { ...DEFAULT_TEMPLATE_SETTINGS.card, ...(inObj.card || {}) },
    exif: { ...DEFAULT_TEMPLATE_SETTINGS.exif, ...(inObj.exif || {}) },
  };
}

export function sanitizeTemplateText(text, { target = "generic", maxLen = 0 } = {}) {
  let out = String(text ?? "");
  if (target === "exif") out = sanitiseForExif(out, Math.max(1, maxLen || 255));
  else out = out.replace(/\r\n/g, "\n").replace(/[^\x09\x0A\x0D\x20-\uFFFF]/g, "");
  out = _cleanDelimiterRuns(out);
  return maxLen ? _truncateWithEllipsis(out, maxLen) : out;
}

export function buildTemplateTokenMap(data = {}) {
  const cleanBody = normaliseStoryText(data.storyBody || data.body || "");
  const storyDate = data.storyDate || data.date || "";
  const storyTitle = data.storyTitle || data.title || "";
  const centreName = data.centreName || "";
  const childName = data.childName || "";
  const room = data.roomName || data.className || "";
  const educator = data.educatorName || "";
  const photoCount = String(data.photoCount ?? 0);
  return {
    StoryDate: storyDate,
    StoryTitle: storyTitle,
    CentreName: centreName,
    ChildName: childName,
    ChildAge: data.childAge || "",
    Class: room,
    StoryBody: cleanBody,
    Routine: data.routineText || "",
    EducatorName: educator,
    PhotoCount: photoCount,
    /* Aliases — same values as disk naming tokens in buildDynamicName (see AI_RULES §9 Glossary). */
    Date: storyDate,
    Title: storyTitle,
    Daycare: centreName,
    Centre: centreName,
    Child: childName,
    Room: room,
    Educator: educator,
  };
}

export function renderTemplate(template, tokenMap, { target = "generic", maxLen = 0 } = {}) {
  const base = String(template ?? "");
  const rendered = base.replace(/\[([A-Za-z0-9_]+)\]/g, (_m, token) => String(tokenMap?.[token] ?? ""));
  return sanitizeTemplateText(rendered, { target, maxLen });
}
