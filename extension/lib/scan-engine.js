/**
 * scan-engine.js — Main scan pipeline + helpers
 *
 * Exports:
 *   initScanEngine(ctx)         — inject logger, getCancelRequested, sendToOffscreen
 *   runExtraction(childId, childName, mode, opts)  — main scan loop
 *
 * Also exports for background.js message handlers:
 *   _rebuildIndexPages(children)  — regenerate index HTML pages
 *
 * Internal helpers (not exported):
 *   fetchStorySummaries, fetchRoutineSummary, bulkFetchAttendanceDates
 *   extractRoomFromTitle, buildRoomMap, inferRoom
 *   computeAutoThreshold, isVideoMedia, extractFilenameFromUrl
 *
 * Dependencies:
 *   lib/api-client.js      — apiFetch, smartDelay, discoverCentres, STORYPARK_BASE
 *   lib/download-pipe.js   — downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen
 *   lib/html-builders.js   — buildStoryPage, buildChildrenIndex, buildChildStoriesIndex
 *   lib/metadata-helpers.js— formatDateDMY, formatETA, sanitizeName, stripHtml, calculateAge,
 *                            buildExifMetadata, sanitiseForExif, sanitiseForIptcCaption
 *   lib/matching.js        — enhancedMatch, buildCentroids, computeCentroid, matchSimilarityPct
 *   lib/db.js              — all IDB operations
 */

import { apiFetch, smartDelay, discoverCentres, STORYPARK_BASE } from "./api-client.js";
import {
  downloadDataUrl, downloadHtmlFile, downloadVideoFromOffscreen,
} from "./download-pipe.js";
import { manageMemory, shouldRecycleOffscreen } from "./memory-manager.js";
import { recordFileMovement } from "./db.js";
import {
  buildStoryPage, buildChildrenIndex, buildChildStoriesIndex,
} from "./html-builders.js";
import {
  formatDateDMY, formatETA, sanitizeName, stripHtml, calculateAge,
  buildExifMetadata, sanitiseForExif, sanitiseForIptcCaption,
} from "./metadata-helpers.js";
import {
  enhancedMatch, buildCentroids, computeCentroid,
  similarityPct as matchSimilarityPct,
} from "./matching.js";
import {
  getProcessedStories, markStoryProcessed,
  getReviewQueue, removeFromReviewQueue, addToReviewQueue,
  getAllDescriptors, getDescriptors, appendDescriptor, setDescriptors,
  getChildPhase, setChildPhase, getAllChildPhases,
  incrementVerifiedCount, advancePhase, computeModelConfidence,
  addRejection, isRejected, getNegativeDescriptors, appendNegativeDescriptor,
  saveScanCheckpoint, getScanCheckpoint, clearScanCheckpoint,
  addPendingDownload, getPendingDownloads, getAllPendingDownloads, removePendingDownload,
  addDownloadedStory, getDownloadedStories, getAllDownloadedStories,
  saveImageFingerprint, getImageFingerprint, getAllImageFingerprints,
  cacheStory, getCachedStory,
  saveChildProfile, getChildProfile, isChildProfileStale,
  saveCentreProfile, getCentreGPS, updateCentreGPS,
  saveEducator, recordFileDownloaded, assignStoryNumbers,
} from "./db.js";

/* ================================================================== */
/*  Injected context (set via initScanEngine)                         */
/* ================================================================== */

let _ctx = {
  logger:             async () => {},
  getCancelRequested: ()  => false,
  sendToOffscreen:    async () => { throw new Error("[scan-engine] not initialized"); },
  diagLog:            ()  => {},
  getDebugMode:       ()  => false,
};

/**
 * Inject dependencies from background.js.
 * Must be called before runExtraction().
 *
 * @param {object} ctx
 * @param {Function} ctx.logger             async (level, message, storyDate?, meta?) => void
 * @param {Function} ctx.getCancelRequested () => boolean
 * @param {Function} ctx.sendToOffscreen    async (message) => response
 * @param {Function} [ctx.diagLog]          (url, data) => void  (debug logging)
 * @param {Function} [ctx.getDebugMode]     () => boolean
 */
export function initScanEngine(ctx) {
  Object.assign(_ctx, ctx);
}

/* ================================================================== */
/*  Memory helpers (defined here so scan engine is self-contained)    */
/* ================================================================== */

/** Yield the microtask queue so V8 can run GC between stories. */
function idleYield(ms = 10) {
  return new Promise(r => setTimeout(r, ms));
}

/** Log SW memory usage. Non-fatal — never breaks a scan. */
async function logMemorySnapshot(label) {
  try {
    let line = `[MEM] ${label}`;
    if (typeof performance !== "undefined" && performance.memory) {
      const used  = (performance.memory.usedJSHeapSize  / 1048576).toFixed(1);
      const total = (performance.memory.totalJSHeapSize / 1048576).toFixed(1);
      const limit = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0);
      line += ` — JS heap ${used}/${total} MB (limit ${limit} MB)`;
    }
    console.log(line);
  } catch { /* non-fatal */ }
}

/* ================================================================== */
/*  Index page rebuilder (exported for use in message handlers)       */
/* ================================================================== */

/**
 * Regenerate the root children index and each child's per-story index HTML page.
 * Uses conflictAction:"overwrite" so pages always reflect the latest state.
 *
 * @param {Array<{id: string, name: string}>} children
 */
export async function _rebuildIndexPages(children) {
  try {
    const rootHtml = buildChildrenIndex(children);
    const rootRes  = await _ctx.sendToOffscreen({
      type: "DOWNLOAD_TEXT", text: rootHtml,
      savePath: "Storypark Smart Saver/index.html", mimeType: "text/html",
    });
    if (rootRes.dataUrl && rootRes.savePath) await downloadHtmlFile(rootRes.dataUrl, rootRes.savePath);

    for (const child of children) {
      const manifests = await getDownloadedStories(child.id).catch(() => []);
      if (manifests.length === 0) continue;
      const childIndexHtml = buildChildStoriesIndex(child.name, manifests);
      const childPath = `Storypark Smart Saver/${sanitizeName(child.name)}/Stories/index.html`;
      const ciRes = await _ctx.sendToOffscreen({
        type: "DOWNLOAD_TEXT", text: childIndexHtml,
        savePath: childPath, mimeType: "text/html",
      });
      if (ciRes.dataUrl && ciRes.savePath) await downloadHtmlFile(ciRes.dataUrl, ciRes.savePath);
    }
  } catch (err) {
    console.warn("[_rebuildIndexPages] Failed:", err.message);
  }
}

/* ================================================================== */
/*  Story feed pagination                                              */
/* ================================================================== */

/**
 * Fetch story summaries for a child, with optional date cutoff.
 * Stories are returned newest-first by the Storypark API.
 *
 * @param {string}    childId
 * @param {string}    mode         "EXTRACT_LATEST" | "DEEP_RESCAN"
 * @param {string}    childName    For log messages
 * @param {Date|null} cutoffDate   Stop collecting stories older than this.
 * @param {Date|null} toDate       Skip stories newer than this (custom range upper bound).
 */
async function fetchStorySummaries(childId, mode, childName, cutoffDate = null, toDate = null) {
  const _today     = new Date().toISOString().split("T")[0];
  const _yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
  const knownIds   = mode === "EXTRACT_LATEST"
    ? new Set(
        (await getProcessedStories())
          .filter(s => s.date !== _today && s.date !== _yesterday)
          .map(s => s.storyId)
      )
    : new Set();

  const summaries = [];
  // Track group_names seen in story list — used for early centre discovery.
  // Fixes: Hugo's second daycare not appearing in Centre Locations panel.
  // HAR analysis confirmed group_name on the story LIST = centre name.
  const _feedGroupNames = new Set();
  let pageToken   = null;

  while (true) {
    if (_ctx.getCancelRequested()) break;

    const url = new URL(`${STORYPARK_BASE}/api/v3/children/${childId}/stories`);
    url.searchParams.set("sort_by", "updated_at");
    url.searchParams.set("story_type", "all");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const data    = await apiFetch(url.toString());
    const stories = data.stories || data.items || [];

    let hitKnown  = false;
    let hitCutoff = false;
    for (const s of stories) {
      const id = String(s.id);
      if (knownIds.has(id)) { hitKnown = true; break; }
      if (cutoffDate && s.created_at && new Date(s.created_at) < cutoffDate) { hitCutoff = true; break; }
      summaries.push({ id, created_at: s.created_at, title: s.title || s.excerpt || "", group_name: s.group_name || "" });
      // Discover centre from story list immediately (non-blocking).
      // This ensures ALL daycares a child ever attended appear in the Centre Locations panel
      // even before we fetch individual story details — important for GPS pre-population.
      if (s.group_name && !_feedGroupNames.has(s.group_name)) {
        _feedGroupNames.add(s.group_name);
        discoverCentres([s.group_name]).catch(() => {});
      }
    }

    pageToken = data.next_page_token || null;

    const oldest     = summaries.length > 0 ? summaries[summaries.length - 1].created_at : null;
    const oldestDate = oldest ? formatDateDMY(oldest.split("T")[0]) : "";
    const dateRange  = oldestDate ? ` (back to ${oldestDate})` : "";
    const cutoffNote = cutoffDate ? ` [cutoff: ${formatDateDMY(cutoffDate.toISOString().split("T")[0])}]` : "";
    await _ctx.logger("INFO", `Scanning${childName ? ` ${childName}` : ""}… found ${summaries.length} stories${dateRange}${cutoffNote}`);

    if (hitKnown || hitCutoff || !pageToken) break;
    await smartDelay("FEED_SCROLL");
  }

  const cutoffMsg = cutoffDate ? ` (date cutoff: ${formatDateDMY(cutoffDate.toISOString().split("T")[0])})` : "";
  await _ctx.logger("INFO", `Found ${summaries.length} stories to process${childName ? ` for ${childName}` : ""}${cutoffMsg}.`);
  return summaries;
}

/* ================================================================== */
/*  Daily routine data                                                 */
/* ================================================================== */

// Cache routine summaries by date string to avoid duplicate fetches
const routineCache = new Map();

export async function fetchRoutineSummary(childId, dateStr) {
  const cacheKey = `${childId}:${dateStr}`;
  if (routineCache.has(cacheKey)) return routineCache.get(cacheKey);
  try {
    await smartDelay("FEED_SCROLL");
    let summary = "";
    try {
      summary = await _fetchRoutineV3(childId, dateStr);
    } catch {
      try {
        const url  = `${STORYPARK_BASE}/children/${childId}/routines.json?date=${dateStr}`;
        const data = await apiFetch(url);
        summary = _buildRoutineSummaryLegacy(data);
      } catch { /* both failed — return empty */ }
    }
    routineCache.set(cacheKey, summary);
    return summary;
  } catch {
    return { summary: "", detailed: "" };
  }
}

async function _fetchRoutineV3(childId, dateStr) {
  let pageToken = "null";
  let maxPages  = 5;
  while (maxPages-- > 0) {
    const url = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${pageToken}`;
    const data = await apiFetch(url);
    const routines = data.daily_routines || [];
    for (const routine of routines) {
      if (routine.date === dateStr) return _buildRoutineDataV3(routine.events || []);
    }
    pageToken = data.next_page_token;
    if (!pageToken) break;
    await smartDelay("FEED_SCROLL");
  }
  return { summary: "", detailed: "" };
}

function _buildRoutineDataV3(events) {
  const titles = [];
  const lines  = [];
  const sorted = [...events].sort((a, b) => (a.occurred_at || "").localeCompare(b.occurred_at || ""));
  for (const evt of sorted) {
    const title = evt.title || evt.full_description || evt.description || evt.routine_type || "";
    if (!title) continue;
    titles.push(title);
    let timeStr = "";
    if (evt.occurred_at) {
      const d = new Date(evt.occurred_at);
      if (!isNaN(d.getTime())) {
        const h    = d.getHours();
        const m    = d.getMinutes();
        const ampm = h >= 12 ? "pm" : "am";
        const h12  = h % 12 || 12;
        timeStr = `${h12}:${String(m).padStart(2, "0")}${ampm}`;
      }
    }
    const notesParts = [];
    if (evt.notes) notesParts.push(evt.notes);
    if (evt.bottle?.quantity) notesParts.push(`${evt.bottle.quantity}${evt.bottle.measurement || "ml"}`);
    if (evt.nappy?.status && !title.toLowerCase().includes(evt.nappy.status)) notesParts.push(evt.nappy.status);
    const noteSuffix = notesParts.length ? ` (${notesParts.join(", ")})` : "";
    lines.push(timeStr ? `${timeStr} - ${title}${noteSuffix}` : `${title}${noteSuffix}`);
  }
  return { summary: titles.join(", "), detailed: lines.join("\n") };
}

function _buildRoutineSummaryLegacy(data) {
  const events = [];
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const items = data[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const desc = item.description || item.summary || item.type || item.name || "";
        if (desc) events.push(desc);
      }
    }
  }
  const summary = events.join(", ");
  return { summary, detailed: summary };
}

/** Extract a plain string from a routine value (string or { summary, detailed }). */
function _routineStr(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  return r.detailed || r.summary || "";
}

/* ================================================================== */
/*  Attendance filtering                                               */
/* ================================================================== */

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Bulk-fetch routine dates for a child to build an attendance set.
 * @param {string} childId
 * @param {number} [maxPages=100]
 * @returns {Promise<{attendanceMap: Map<string, string>, oldestDate: string|null}>}
 */
async function bulkFetchAttendanceDates(childId, maxPages = 100) {
  const attendanceMap = new Map();
  let oldestDate = null;
  let pageToken  = "null";
  let pages      = 0;
  while (pages < maxPages) {
    try {
      const url  = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${pageToken}`;
      const data = await apiFetch(url);
      for (const r of (data.daily_routines || [])) {
        if (r.date && !attendanceMap.has(r.date)) {
          attendanceMap.set(r.date, _buildRoutineDataV3(r.events || []));
          if (!oldestDate || r.date < oldestDate) oldestDate = r.date;
        }
      }
      pageToken = data.next_page_token;
      if (!pageToken) break;
      pages++;
      await new Promise(r => setTimeout(r, 800));
    } catch { break; }
  }
  return { attendanceMap, oldestDate };
}

/* ================================================================== */
/*  Room name extraction from story titles                            */
/* ================================================================== */

const ROOM_SUFFIXES = [
  "one", "two", "three", "four", "five", "six",
  "1", "2", "3", "4", "5", "6",
  "room", "class", "group",
  "kindy", "kinder", "kindergarten",
  "preschool", "pre-school",
  "nursery", "babies", "toddlers",
  "junior", "senior", "middle",
];

/**
 * Extract a room/classroom name from a story title.
 * Matches patterns like "… in Nursery One", "… in Senior Kindy".
 * @param {string} title
 * @returns {string|null}
 */
export function extractRoomFromTitle(title) {
  if (!title) return null;
  const clean = title
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
    .replace(/\s*-?\s*\d{2}\/\d{2}\/\d{2,4}\s*$/, "")
    .replace(/[!?.]+\s*$/, "")
    .trim();
  const match = clean.match(/\bin\s+([A-Z][a-zA-Z0-9]*(?:\s+[A-Za-z0-9]+)*)\s*$/i);
  if (!match) return null;
  const candidate = match[1].trim();
  const words     = candidate.toLowerCase().split(/\s+/);
  const hasRoomWord = words.some((w) => ROOM_SUFFIXES.includes(w));
  if (!hasRoomWord) return null;
  return normaliseRoomName(candidate);
}

function normaliseRoomName(name) {
  const numMap = { "1": "One", "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six" };
  let normalised = name.replace(/\b(\d)\b/g, (_, d) => numMap[d] || d);
  normalised = normalised.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return normalised;
}

/**
 * Pre-scan story summaries to build a room-by-period map.
 * @param {Array<{id, created_at, title?}>} summaries
 * @returns {Map<string, string>} yearMonth → dominant room name
 */
export function buildRoomMap(summaries) {
  const periodCounts = new Map();
  for (const s of summaries) {
    const title = s.title || s.excerpt || "";
    const room  = extractRoomFromTitle(title);
    if (!room) continue;
    const dateStr = s.created_at ? s.created_at.split("T")[0] : null;
    if (!dateStr) continue;
    const ym = dateStr.substring(0, 7);
    if (!periodCounts.has(ym)) periodCounts.set(ym, new Map());
    const counts = periodCounts.get(ym);
    counts.set(room, (counts.get(room) || 0) + 1);
  }
  const roomMap = new Map();
  for (const [ym, counts] of periodCounts) {
    let bestRoom = "", bestCount = 0;
    for (const [room, count] of counts) {
      if (count > bestCount) { bestRoom = room; bestCount = count; }
    }
    if (bestRoom) roomMap.set(ym, bestRoom);
  }
  return roomMap;
}

function inferRoom(dateStr, roomMap) {
  if (!dateStr || roomMap.size === 0) return "";
  const ym = dateStr.substring(0, 7);
  if (roomMap.has(ym)) return roomMap.get(ym);
  const allPeriods = [...roomMap.keys()].sort();
  let bestDist = Infinity, bestRoom = "";
  for (const p of allPeriods) {
    const [py, pm] = p.split("-").map(Number);
    const [sy, sm] = ym.split("-").map(Number);
    const dist = Math.abs((py * 12 + pm) - (sy * 12 + sm));
    if (dist < bestDist && dist <= 3) { bestDist = dist; bestRoom = roomMap.get(p); }
  }
  return bestRoom;
}

/* ================================================================== */
/*  Media type helpers                                                 */
/* ================================================================== */

const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

function isVideoMedia(mediaItem) {
  const ct = (mediaItem.content_type || mediaItem.type || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  const url      = mediaItem.original_url || "";
  const filename = mediaItem.filename || extractFilenameFromUrl(url);
  return VIDEO_EXTENSIONS.test(filename);
}

function extractFilenameFromUrl(url) {
  return (url.split("/").pop() || "").split("?")[0];
}

/* ================================================================== */
/*  Auto-calibrating threshold                                         */
/* ================================================================== */

/**
 * Compute auto-calibrated face matching thresholds from learned data.
 * Returns null if insufficient data (< 5 positive, < 3 negative).
 */
async function computeAutoThreshold(childId) {
  const descData = await getDescriptors(childId).catch(() => null);
  if (!descData?.descriptors || descData.descriptors.length < 5) return null;
  const negDescs = await getNegativeDescriptors(childId).catch(() => []);
  if (negDescs.length < 3) return null;
  const posDescs = descData.descriptors;

  const posScores = [];
  for (let i = 0; i < posDescs.length && posScores.length < 200; i++) {
    for (let j = i + 1; j < posDescs.length && posScores.length < 200; j++) {
      posScores.push(matchSimilarityPct(posDescs[i], posDescs[j]));
    }
  }
  const negScores = [];
  for (const neg of negDescs) {
    let best = 0;
    for (const pos of posDescs) {
      const s = matchSimilarityPct(neg, pos);
      if (s > best) best = s;
    }
    negScores.push(best);
  }
  if (posScores.length < 3 || negScores.length < 3) return null;

  const avg     = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd      = (arr, m) => Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  const posMean = avg(posScores), negMean = avg(negScores);
  const posStd  = sd(posScores, posMean), negStd = sd(negScores, negMean);

  const autoTh = Math.max(50, Math.min(95, Math.round(posMean - posStd)));
  const minTh  = Math.max(30, Math.min(autoTh - 5, Math.round(negMean + negStd)));

  return {
    autoThreshold: autoTh, minThreshold: minTh,
    posMean: Math.round(posMean), negMean: Math.round(negMean),
    posStd: Math.round(posStd * 10) / 10, negStd: Math.round(negStd * 10) / 10,
    posCount: posDescs.length, negCount: negDescs.length,
    gap: Math.round(posMean - posStd - (negMean + negStd)),
  };
}

/* ================================================================== */
/*  Main extraction pipeline                                           */
/* ================================================================== */

const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/**
 * Orchestrate a full extraction run for one child.
 *
 * @param {string} childId
 * @param {string} childName
 * @param {"EXTRACT_LATEST"|"DEEP_RESCAN"} mode
 * @param {object} [opts]
 * @param {boolean} [opts.closeOffscreenOnExit=true]
 * @param {number}  [opts.startIndex=0]           Resume from this story index
 * @param {string}  [opts.resumeAnchorId=null]     Resume anchor story ID
 * @param {boolean} [opts.suppressEndMessages=false]
 * @param {number}  [opts.childIndex=0]
 * @param {number}  [opts.childCount=1]
 * @returns {Promise<{approved, queued, rejected, skippedAbsent, cancelled}>}
 */
export async function runExtraction(childId, childName, mode, {
  closeOffscreenOnExit = true, startIndex = 0, resumeAnchorId = null,
  suppressEndMessages = false, childIndex = 0, childCount = 1,
} = {}) {
  const logger = _ctx.logger;
  const sendToOffscreen = _ctx.sendToOffscreen;
  const getCancelRequested = _ctx.getCancelRequested;

  await logger("INFO", `Starting ${mode === "EXTRACT_LATEST" ? "incremental" : "deep"} scan for ${childName}…`);

  let approved = 0, queued = 0, rejected = 0, skippedAbsent = 0, skippedAlreadyDownloaded = 0;
  let scanCancelled = false, scanCompletedFully = false, scanAbortReason = null;

  const abortAndCheckpoint = async (si, totalStories, summariesArr, reason) => {
    scanCancelled   = true;
    scanAbortReason = reason;
    try {
      await saveScanCheckpoint({
        childId, childName, mode, storyIndex: si, totalStories,
        lastStoryId: si > 0 && summariesArr?.[si - 1] ? summariesArr[si - 1].id : null,
        abortedReason: reason, abortedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("[runExtraction] checkpoint save on abort failed:", e?.message || e);
    }
  };

  try {
    const {
      activeCentreName = "", attendanceFilter = false,
      saveStoryHtml = true, saveStoryCard = true,
      fillGapsOnly = false, downloadVideos = false,
      scanDateMode = "all", scanCutoffFromDate = null, scanCutoffToDate = null,
    } = await chrome.storage.local.get([
      "activeCentreName",
      "attendanceFilter", "saveStoryHtml", "saveStoryCard", "fillGapsOnly", "downloadVideos",
      "scanDateMode", "scanCutoffFromDate", "scanCutoffToDate",
    ]);

    const isCustomRange = scanDateMode === "custom";
    const scanFromDate  = (isCustomRange && scanCutoffFromDate) ? new Date(scanCutoffFromDate + "T00:00:00") : null;
    const scanToDate    = (isCustomRange && scanCutoffToDate)   ? new Date(scanCutoffToDate   + "T23:59:59") : null;

    if (scanFromDate || scanToDate) {
      const fromLabel = scanFromDate ? formatDateDMY(scanCutoffFromDate) : "all time";
      const toLabel   = scanToDate   ? formatDateDMY(scanCutoffToDate)   : "today";
      await logger("INFO", `Date range: ${fromLabel} to ${toLabel}`);
    }

    await logger("INFO", `Downloading all photos for ${childName} — face sorting happens offline via Smart Sort`);

    // Per-child profile (birthday, regularDays, centre name)
    let childCentreFallback = activeCentreName;
    let childBirthday       = null;
    let childRegularDays    = [];
    try {
      const cachedProfile  = await getChildProfile(childId).catch(() => null);
      const profileIsStale = cachedProfile ? (await isChildProfileStale(childId).catch(() => true)) : true;

      if (cachedProfile && !profileIsStale) {
        childBirthday    = cachedProfile.birthday    || null;
        childRegularDays = cachedProfile.regularDays || [];
        const cachedCompanies = (cachedProfile.companies || []).map(n => ({ name: n }));
        if (cachedCompanies.length > 0) {
          const foundName = cachedCompanies[0].name || "";
          if (foundName) { childCentreFallback = foundName; await discoverCentres([foundName]); }
        }
      } else {
        const childProfileData = await apiFetch(`${STORYPARK_BASE}/api/v3/children/${childId}`);
        const child            = childProfileData.child || childProfileData;
        childBirthday    = child.birthday     || null;
        childRegularDays = child.regular_days || [];

        let foundName = "";
        const companies = child.companies || child.services || [];
        if (companies.length > 0) {
          foundName = companies[0].name || companies[0].display_name || "";
        } else if (child.centre_ids && child.centre_ids.length > 0) {
          try {
            const fcd = await apiFetch(`${STORYPARK_BASE}/api/v3/family_centres`);
            const fcs = fcd.centres || fcd.services || [];
            const mc  = fcs.find(c => child.centre_ids.includes(String(c.id)));
            if (mc) foundName = mc.name || mc.display_name || "";
          } catch { /* ignore */ }
        }

        if (foundName) { childCentreFallback = foundName; await discoverCentres([foundName]); }

        saveChildProfile({
          childId, childName,
          birthday:    child.birthday     || null,
          regularDays: child.regular_days || [],
          companies:   companies.map(c => c.name || c.display_name || "").filter(Boolean),
          centreIds:   child.centre_ids   || [],
        }).catch(() => {});
      }
    } catch { /* fall back to activeCentreName */ }

    // Attendance filter bulk-fetch
    let attendanceMap = new Map(), attendanceOldestDate = null;
    if (attendanceFilter) {
      if (childRegularDays.length > 0) {
        await logger("INFO", `${childName} attends: ${childRegularDays.join(", ")}`);
      }
      await logger("INFO", `Pre-fetching routine/attendance data for ${childName}…`);
      const bulkResult = await bulkFetchAttendanceDates(childId);
      attendanceMap        = bulkResult.attendanceMap;
      attendanceOldestDate = bulkResult.oldestDate;
      await logger("INFO", `Found ${attendanceMap.size} days with routine data${attendanceOldestDate ? ` (back to ${formatDateDMY(attendanceOldestDate)})` : ""}.`);
      for (const [date, summary] of attendanceMap) {
        routineCache.set(`${childId}:${date}`, summary);
      }
    }

    let summaries = await fetchStorySummaries(childId, mode, childName, scanFromDate, scanToDate);

    // Fill Gaps Only mode
    if (fillGapsOnly && summaries.length > 0) {
      const existingManifests = await getDownloadedStories(childId).catch(() => []);
      const downloadedStoryIds = new Set(
        existingManifests
          .filter(m => m.approvedFilenames && m.approvedFilenames.length > 0)
          .map(m => m.storyId).filter(Boolean)
      );
      if (downloadedStoryIds.size > 0) {
        const before = summaries.length;
        summaries = summaries.filter(s => !downloadedStoryIds.has(String(s.id)));
        if (summaries.length < before) {
          await logger("INFO", `Download Missing Only: ${summaries.length} stories without photos (skipping ${before - summaries.length} already downloaded)`);
        }
      }
    }

    const totalStories = summaries.length;

    // Room name map from story titles
    const roomMap = buildRoomMap(summaries);
    if (roomMap.size > 0) {
      const rooms = [...new Set(roomMap.values())];
      await logger("INFO", `Detected room${rooms.length > 1 ? "s" : ""}: ${rooms.join(", ")} (from story titles)`);
    }

    const { centreLocations: _initLocations = {} } = await chrome.storage.local.get("centreLocations");
    const discoveredInScan = new Set(Object.keys(_initLocations));
    if (childCentreFallback) discoveredInScan.add(childCentreFallback);

    // ── Centre-aware room tracking ──────────────────────────────────────
    // Prevents a room from a previous daycare from being "inferred" into
    // stories from a new daycare (the bug: child moves from Centre A to
    // Centre B, and Centre B stories get Centre A's room name applied).
    //
    // centreRoomContext: centre → Set of yearMonths that have an explicit room
    // seenCentres: all distinct centreNames encountered in this scan
    const centreRoomContext = new Map(); // Map<centreName, Set<yearMonth>>
    const seenCentres       = new Set();
    if (childCentreFallback) seenCentres.add(childCentreFallback);

    // Resume support
    let effectiveStartIndex = startIndex;
    if (resumeAnchorId) {
      const anchorIdx = summaries.findIndex(s => s.id === resumeAnchorId);
      if (anchorIdx >= 0) {
        effectiveStartIndex = anchorIdx + 1;
        await logger("INFO", `Resuming from story ${effectiveStartIndex + 1}/${summaries.length}`);
      } else if (startIndex > 0 && startIndex < summaries.length) {
        await logger("INFO", `Resuming from story ${startIndex + 1}/${summaries.length} (raw index)`);
      }
    } else if (startIndex > 0 && startIndex < summaries.length) {
      await logger("INFO", `Resuming from story ${startIndex + 1}/${summaries.length}`);
    }

    const _scanLoopStartTime = Date.now();

    // ─────────────────────────────────────────────────────────────────
    // MAIN STORY LOOP
    // ─────────────────────────────────────────────────────────────────
    for (let si = effectiveStartIndex; si < summaries.length; si++) {
      if (getCancelRequested()) {
        await logger("WARNING", "Scan cancelled by user.");
        chrome.runtime.sendMessage({ type: "LOG", message: "Scan cancelled." }).catch(() => {});
        await abortAndCheckpoint(si, summaries.length, summaries, "user_cancel");
        break;
      }

      // Auto-save checkpoint every 5 stories
      if (si > 0 && si % 5 === 0) {
        await saveScanCheckpoint({
          childId, childName, mode, storyIndex: si,
          totalStories: summaries.length, lastStoryId: summaries[si - 1].id,
        }).catch(() => {});
      }

      const summary     = summaries[si];
      const dateStr     = summary.created_at ? summary.created_at.split("T")[0] : null;

      // Progress + ETA
      const _sDone  = si - effectiveStartIndex + 1;
      const _sLeft  = summaries.length - si - 1;
      const _elapMs = Date.now() - _scanLoopStartTime;
      const _avgMs  = _sDone > 0 ? _elapMs / _sDone : 0;
      const _eta    = (_sDone >= 3 && _avgMs > 0 && _sLeft > 0) ? formatETA(_avgMs * _sLeft) : "";
      chrome.runtime.sendMessage({
        type: "PROGRESS",
        current: si + 1, total: totalStories,
        date: formatDateDMY(dateStr), childName, eta: _eta,
        childIndex, childCount,
      }).catch(() => {});

      // Attendance filter
      if (attendanceFilter && dateStr) {
        const withinRoutineRange = attendanceOldestDate && dateStr >= attendanceOldestDate;
        if (withinRoutineRange) {
          if (attendanceMap.has(dateStr)) {
            // child was present — proceed
          } else {
            const dayName = DAY_NAMES[new Date(dateStr + "T00:00:00Z").getUTCDay()];
            skippedAbsent++;
            await logger("INFO", `  Skipped ${formatDateDMY(dateStr)} (${dayName}) — ${childName} has no routine data (absent)`, dateStr);
            await markStoryProcessed(summary.id, summary.created_at, childId);
            continue;
          }
        }
      }

      if (!(await getCachedStory(String(summary.id)).catch(() => null))) {
        await smartDelay("READ_STORY");
      }
      const storyDateDisplay = dateStr ? formatDateDMY(dateStr) : "unknown date";
      await logger("INFO", `Story ${si + 1}/${totalStories} (${storyDateDisplay}) for ${childName}`, dateStr);

      // Fetch story detail (with cache)
      let story, storyFromCache = false;
      try {
        const cached = await getCachedStory(String(summary.id)).catch(() => null);
        if (cached) {
          story = cached; storyFromCache = true;
        } else {
          const detail = await apiFetch(`${STORYPARK_BASE}/api/v3/stories/${summary.id}`);
          story = detail.story || detail;
          await cacheStory(String(summary.id), story).catch(() => {});
        }
      } catch (err) {
        if (err.name === "AuthError" || err.message.includes("401")) {
          await logger("ERROR", `Auth error — ${err.message}. Checkpoint saved, click Resume to continue.`);
          await abortAndCheckpoint(si, summaries.length, summaries, "auth");
          break;
        }
        if (err.name === "RateLimitError" || err.message.includes("429") || err.message.includes("403")) {
          await logger("ERROR", `Rate limited — ${err.message}. Checkpoint saved at story ${si}, click Resume to continue.`);
          await abortAndCheckpoint(si, summaries.length, summaries, "rate_limit");
          break;
        }
        await logger("WARNING", `  Story ${summary.id} fetch failed: ${err.message}`);
        continue;
      }

      // ── COUNT-BASED DISK VERIFICATION (AI_RULES.md Rule 13) ─────────────
      // "Disk is Truth" strategy: if this story is verified on disk with the
      // correct number of media files, skip the entire download process.
      const apiMediaCount = (story.media || story.attachments || []).length;
      if (apiMediaCount > 0) {
        try {
          const existingManifest = await getDownloadedStories(childId).then(manifests => 
            manifests.find(m => m.storyId === String(summary.id))
          ).catch(() => null);
          
          if (existingManifest && 
              existingManifest.status === "VERIFIED_ON_DISK" &&
              existingManifest.localMediaCount >= apiMediaCount) {
            await logger("INFO", `  ✓ Skipped — ${existingManifest.localMediaCount}/${apiMediaCount} media verified on disk`, dateStr);
            await markStoryProcessed(summary.id, summary.created_at, childId);
            skippedAlreadyDownloaded++;
            continue;
          }
        } catch (err) {
          // Non-fatal — if verification check fails, proceed with download
          console.warn("[scan-engine] Disk verification check failed:", err.message);
        }
      }

      const createdAt    = story.created_at || summary.created_at || "";
      const body         = story.display_content || story.body || story.excerpt || story.content || "";
      const centreName   = story.community_name || story.centre_name || story.service_name || story.group_name || childCentreFallback || "";
      // Prefer story.date (educator-set event date) over created_at.
      // HAR analysis: `date` field is set by educators and better reflects when the story event happened.
      // It also aligns with display_subtitle_children_names and learning_tags grouping.
      const storyDateStr = (story.date || createdAt || "").split("T")[0] || null;

      const rawRoom       = story.group_name || "";
      const storyTitleForRoom = story.display_title || story.title || summary.title || "";
      const extractedRoom = extractRoomFromTitle(storyTitleForRoom);

      // ── Centre-aware room determination ───────────────────────────────
      // Bug fix: If a child attended multiple daycares, don't let the room
      // name from Centre A bleed into stories from Centre B.
      //
      // Track which centre is active in each period. Only infer a room via
      // roomMap (built from titles pre-scan) if:
      //   a) we've only ever seen ONE centre in this scan, OR
      //   b) we've seen multiple centres but THIS centre already has
      //      explicit rooms recorded in centreRoomContext for nearby periods
      if (centreName) seenCentres.add(centreName);
      const hasMultipleCentres = seenCentres.size > 1;

      let inferredRoom = "";
      if (!hasMultipleCentres) {
        // Safe: single centre — use standard title-based inference
        inferredRoom = inferRoom(storyDateStr, roomMap);
      } else if (centreName && centreRoomContext.has(centreName)) {
        // Multiple centres seen, but this centre has known rooms — safe to infer
        inferredRoom = inferRoom(storyDateStr, roomMap);
      }
      // else: multiple centres, no known room for this centre → don't infer

      const roomName = (rawRoom && rawRoom !== centreName) ? rawRoom : (extractedRoom || inferredRoom);

      // Record explicit room for this centre/period (for future centre-aware inference)
      if (roomName && centreName && storyDateStr) {
        const ym = storyDateStr.substring(0, 7);
        if (!centreRoomContext.has(centreName)) centreRoomContext.set(centreName, new Set());
        centreRoomContext.get(centreName).add(ym);
      }

      const childFirstName = (childName || "").split(/\s+/)[0];

      // Auto-discover centre (skip if already known)
      if (centreName && !discoveredInScan.has(centreName)) {
        await discoverCentres([centreName]);
        discoveredInScan.add(centreName);
      }

      // GPS lookup
      let gpsCoords = centreName ? await getCentreGPS(centreName).catch(() => null) : null;
      if (!gpsCoords && centreName) {
        try {
          const { centreLocations: _clFb = {} } = await chrome.storage.local.get("centreLocations");
          const legacyLoc = _clFb[centreName];
          if (legacyLoc?.lat != null && legacyLoc?.lng != null) {
            gpsCoords = { lat: legacyLoc.lat, lng: legacyLoc.lng };
            updateCentreGPS(centreName, legacyLoc.lat, legacyLoc.lng).catch(() => {});
          } else if (!(centreName in _clFb)) {
            discoverCentres([centreName]).catch(() => {});
          }
        } catch { /* ignore GPS fallback errors */ }
      }

      // Collect media items
      const mediaItems  = story.media || story.media_items || story.assets || [];
      const itemsWithUrl = mediaItems.filter((m) => m.original_url);

      const images = itemsWithUrl.filter((m) => !isVideoMedia(m)).map((m) => {
        let fname = m.file_name || m.filename || extractFilenameFromUrl(m.original_url) || `${summary.id}`;
        if (!/\.\w{2,5}$/.test(fname)) {
          const ct = (m.content_type || "").toLowerCase();
          if (ct.includes("png")) fname += ".png";
          else if (ct.includes("gif")) fname += ".gif";
          else if (ct.includes("webp")) fname += ".webp";
          else fname += ".jpg";
        }
        // Sanitize story_pdf_* page filenames.
        // HAR analysis confirmed these are JPEG images (HTTP 200, MIME image/jpeg), fully
        // accessible to family accounts. Convert ugly internal names to clean page numbers:
        //   "story_pdf_{uuid}_{page}_640_wide.jpg"  →  "pdf_page_01.jpg"
        const pdfPageMatch = fname.match(/^story_pdf_[a-z0-9]+_(\d+)_\d+_\w+\.(jpg|jpeg|png|webp)$/i);
        if (pdfPageMatch) {
          const pageNum = String(parseInt(pdfPageMatch[1], 10) + 1).padStart(2, "0");
          fname = `pdf_page_${pageNum}.${pdfPageMatch[2].toLowerCase()}`;
        }
        const dotIdx = fname.lastIndexOf(".");
        const baseName = dotIdx >= 0 ? fname.slice(0, dotIdx) : fname;
        const ext      = dotIdx >= 0 ? fname.slice(dotIdx + 1) : "jpg";
        const nameParts = [storyDateStr, sanitizeName(childName), roomName ? sanitizeName(roomName) : null, baseName].filter(Boolean);
        return { originalUrl: m.original_url, filename: sanitizeName(`${nameParts.join("_")}.${ext}`) };
      });

      const videos = itemsWithUrl.filter((m) => isVideoMedia(m)).map((m) => {
        let fname = m.file_name || m.filename || extractFilenameFromUrl(m.original_url) || `${summary.id}`;
        if (!/\.\w{2,5}$/.test(fname)) {
          const ct = (m.content_type || "").toLowerCase();
          if (ct.includes("mov")) fname += ".mov";
          else if (ct.includes("webm")) fname += ".webm";
          else fname += ".mp4";
        }
        return { originalUrl: m.original_url, filename: sanitizeName(fname) };
      });

      if (images.length === 0 && videos.length === 0) {
        if (saveStoryHtml && body) {
          try {
            const storyTitle   = stripHtml(story.display_title || story.title || story.excerpt || "Story");
            const childAge     = calculateAge(childBirthday, storyDateStr);
            const educatorName = story.user?.display_name || (story.teachers && story.teachers[0]?.display_name) || story.creator?.display_name || "";
            if (educatorName && story.user?.id) {
              saveEducator({ childId, educatorId: String(story.user.id), educatorName, centreName }).catch(() => {});
            }
            const safeDateStr  = storyDateStr || "unknown";
            const safeTitle    = sanitizeName(storyTitle.substring(0, 50));
            const storyFolder  = `${safeDateStr} - ${safeTitle}`;
            const storyBase    = `Storypark Smart Saver/${sanitizeName(childName)}/Stories/${storyFolder}`;
            const routineData  = storyDateStr ? await fetchRoutineSummary(childId, storyDateStr) : "";
            const routineHtml  = _routineStr(routineData);
            const htmlContent  = buildStoryPage({ title: storyTitle, date: storyDateStr, body, childName, childAge, roomName, centreName, educatorName, routineText: routineHtml, mediaFilenames: [] });
            const txtRes = await sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBase}/story.html`, mimeType: "text/html" });
            if (txtRes.dataUrl && txtRes.savePath) await downloadHtmlFile(txtRes.dataUrl, txtRes.savePath);
          } catch (err) {
            console.warn("Story HTML (text-only) export failed:", err.message);
          }
        }
        await markStoryProcessed(summary.id, createdAt, childId);
        continue;
      }

      const storyTitle   = stripHtml(story.display_title || story.title || story.excerpt || "Story");
      const childAge     = calculateAge(childBirthday, storyDateStr);
      const educatorName = story.user?.display_name || (story.teachers && story.teachers[0]?.display_name) || story.creator?.display_name || "";
      if (educatorName && story.user?.id) {
        saveEducator({ childId, educatorId: String(story.user.id), educatorName, centreName }).catch(() => {});
      }
      const safeDateStr  = storyDateStr || "unknown";
      const safeTitle    = sanitizeName(storyTitle.substring(0, 50));
      const storyFolderName = `${safeDateStr} - ${safeTitle}`;
      const storyBasePath   = `Storypark Smart Saver/${sanitizeName(childName)}/Stories/${storyFolderName}`;

      const routineText  = storyDateStr ? await fetchRoutineSummary(childId, storyDateStr) : "";

      // EXIF + IPTC fields
      const exifArtist   = sanitiseForExif(centreName ? `Storypark Smart Saver - ${centreName}` : "Storypark Smart Saver", 255);
      const iptcCaption  = sanitiseForIptcCaption(stripHtml(body), 2000);
      const iptcKeywords = [childName, centreName, roomName, educatorName].filter(Boolean).map(k => sanitiseForExif(k, 64));
      const iptcByline   = exifArtist;

      const approvedFilenames = [];
      const mediaUrls         = [];
      let aborted = false;

      // ─── Process images ───
      for (const img of images) {
        if (getCancelRequested()) { scanCancelled = true; aborted = true; break; }

        await smartDelay("DOWNLOAD_MEDIA");

        const exifMeta  = buildExifMetadata(body, childFirstName, routineText, roomName, centreName, childAge);
        const savePath  = `${storyBasePath}/${img.filename}`;

        let _skipDlSucceeded = false;
        try {
          const skipDlResult = await sendToOffscreen({ type: "DOWNLOAD_APPROVED", storyData: { storyId: summary.id, createdAt, body, roomName, centreName, originalUrl: img.originalUrl, filename: img.filename }, description: exifMeta.description, exifTitle: exifMeta.title, exifSubject: exifMeta.subject, exifComments: exifMeta.comments, exifArtist, iptcCaption, iptcKeywords, iptcByline, childName, savePath, gpsCoords });
          if (skipDlResult.dataUrl && skipDlResult.savePath) {
            await downloadDataUrl(skipDlResult.dataUrl, skipDlResult.savePath);
            _skipDlSucceeded = true;
            recordFileDownloaded({ filePath: skipDlResult.savePath, childId, storyId: String(summary.id), filename: img.filename, fileType: "image" }).catch(() => {});
            recordFileMovement({ type: "downloaded", childId, storyId: String(summary.id), filename: img.filename, toPath: storyBasePath, source: "download_all" }).catch(() => {});
          }
        } catch (skipErr) {
          if (skipErr.name === "RateLimitError" || skipErr.message.includes("429")) {
            await logger("ERROR", `Rate limited at story ${si}. Checkpoint saved, click Resume.`);
            await abortAndCheckpoint(si, summaries.length, summaries, "rate_limit");
            aborted = true; break;
          }
          await logger("WARNING", `  Download failed for ${img.filename}: ${skipErr.message}`);
        }
        
        if (_skipDlSucceeded) {
          approved++;
          approvedFilenames.push(img.filename);
          mediaUrls.push({ filename: img.filename, originalUrl: img.originalUrl });
          await logger("SUCCESS", `  Downloaded: ${img.filename}`, storyDateStr);
        }
      } // end images loop

      if (aborted) break;

      // ─── Process videos (only when downloadVideos setting is enabled) ───
      if (downloadVideos && videos.length > 0) {
        for (const vid of videos) {
          if (getCancelRequested()) { scanCancelled = true; aborted = true; break; }
          await smartDelay("DOWNLOAD_MEDIA");

          const dotIdx     = vid.filename.lastIndexOf(".");
          const baseName   = dotIdx >= 0 ? vid.filename.slice(0, dotIdx) : vid.filename;
          const ext        = dotIdx >= 0 ? vid.filename.slice(dotIdx + 1) : "mp4";
          const nameParts  = [storyDateStr, sanitizeName(childName), roomName ? sanitizeName(roomName) : null, baseName].filter(Boolean);
          const videoFilename = sanitizeName(`${nameParts.join("_")}.${ext}`);
          const savePath   = `${storyBasePath}/${videoFilename}`;

          try {
            const vidResult = await sendToOffscreen({ type: "DOWNLOAD_VIDEO", videoUrl: vid.originalUrl, savePath });
            if (vidResult?.blobUrl && vidResult?.savePath) {
              await downloadVideoFromOffscreen(vidResult);
              recordFileDownloaded({ filePath: vidResult.savePath, childId, storyId: String(summary.id), filename: videoFilename, fileType: "video" }).catch(() => {});
              approved++;
              approvedFilenames.push(videoFilename);
              mediaUrls.push({ filename: videoFilename, originalUrl: vid.originalUrl });
              const sizeMb = vidResult.size ? ` (${(vidResult.size / 1048576).toFixed(1)} MB)` : "";
              await logger("SUCCESS", `  Downloaded video: ${videoFilename}${sizeMb}`, storyDateStr);
            }
          } catch (err) {
            if (err.name === "AuthError" || err.message.includes("401")) {
              await logger("ERROR", `Auth error — checkpoint saved at story ${si}.`);
              await abortAndCheckpoint(si, summaries.length, summaries, "auth");
              aborted = true; break;
            }
            if (err.message.startsWith("Video fetch 403") || err.message.startsWith("Video fetch 404")) {
              await logger("WARNING", `  Video unavailable (skipped): ${videoFilename}`, storyDateStr);
            } else if (err.name === "RateLimitError" || err.message.includes("429")) {
              await logger("ERROR", `Rate limited — checkpoint saved at story ${si}.`);
              await abortAndCheckpoint(si, summaries.length, summaries, "rate_limit");
              aborted = true; break;
            } else {
              await logger("WARNING", `  Video download error: ${err.message}`, storyDateStr);
            }
          }
        } // end videos loop
      } // end downloadVideos gate

      if (aborted) break;

      // Story HTML
      if (saveStoryHtml && approvedFilenames.length > 0) {
        try {
          const routineHtmlStr = _routineStr(routineText);
          const htmlContent = buildStoryPage({ title: storyTitle, date: storyDateStr, body, childName, childAge, roomName, centreName, educatorName, routineText: routineHtmlStr, mediaFilenames: approvedFilenames });
          const txtRes2 = await sendToOffscreen({ type: "DOWNLOAD_TEXT", text: htmlContent, savePath: `${storyBasePath}/story.html`, mimeType: "text/html" });
          if (txtRes2.dataUrl && txtRes2.savePath) {
            await downloadHtmlFile(txtRes2.dataUrl, txtRes2.savePath);
            await logger("INFO", `  story.html saved (${approvedFilenames.length} photos)`, storyDateStr, { childName, centreName, roomName, photoCount: approvedFilenames.length });
          }
        } catch (err) { console.warn("Story HTML export failed:", err.message); }
      }

      // Story Card
      if (saveStoryCard && approvedFilenames.length > 0 && body) {
        try {
          const plainRoutineForCard = _routineStr(routineText);
          const cardSavePath = `${storyBasePath}/${storyDateStr || "story"} - Story Card.jpg`;
          const cardResult   = await sendToOffscreen({ type: "GENERATE_STORY_CARD", title: storyTitle, date: storyDateStr, body, centreName, roomName, educatorName, childName, childAge, routineText: plainRoutineForCard, photoCount: approvedFilenames.length, gpsCoords, exifArtist, iptcCaption, iptcKeywords, iptcByline, savePath: cardSavePath });
          if (cardResult.ok && cardResult.dataUrl) {
            await downloadDataUrl(cardResult.dataUrl, cardSavePath);
            await logger("INFO", `  Story Card saved`, storyDateStr, { childName, centreName, roomName, gps: !!gpsCoords });
          }
        } catch (err) { console.warn("Story Card generation failed:", err.message); }
      }

      // Save story manifest to IDB
      if (approvedFilenames.length > 0) {
        try {
          await addDownloadedStory({ childId, childName, storyId: summary.id, storyTitle: storyTitle || "Story", storyDate: storyDateStr || "", educatorName: educatorName || "", roomName: roomName || "", centreName: centreName || "", folderName: storyFolderName, approvedFilenames, mediaUrls, thumbnailFilename: approvedFilenames[0] || "", excerpt: stripHtml(body).substring(0, 200), storyBody: body || "", childAge: childAge || "", storyRoutine: _routineStr(routineText) });
        } catch (err) { console.warn("Story manifest save failed:", err.message); }
      }

      await markStoryProcessed(summary.id, createdAt, childId);

      // OOM management + GC yield (every 10 stories)
      const _storiesDone = si - effectiveStartIndex + 1;
      if (_storiesDone % 10 === 0) {
        const memPressure = await manageMemory({
          clearRoutineCache: () => routineCache.clear(),
          sendToOffscreen,
          logger,
        });
        if (memPressure === "emergency") {
          await logger("ERROR", `🛑 OOM emergency — aborting scan to protect memory. Click Resume to continue.`);
          await abortAndCheckpoint(si + 1, summaries.length, summaries, "oom");
          break;
        }
      } else {
        await idleYield(50);
      }
    } // end main story loop

    if (!scanCancelled) scanCompletedFully = true;

  } finally {
    routineCache.clear();
    if (closeOffscreenOnExit) {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }

  if (scanCompletedFully) {
    await clearScanCheckpoint(childId).catch(() => {});
    // Assign sequential story numbers (oldest=1) after a successful full scan.
    // Done in the background — non-fatal, never blocks the scan result.
    assignStoryNumbers(childId).catch(err =>
      console.warn("[runExtraction] assignStoryNumbers failed (non-fatal):", err?.message || err)
    );
  }

  const skippedPart = skippedAbsent > 0 ? `, Skipped (absent): ${skippedAbsent}` : "";
  if (scanCompletedFully) {
    await _ctx.logger("SUCCESS", `Scan complete — Downloaded: ${approved}${skippedPart}`, null, { childName, approved, queued, rejected });
  } else if (scanCancelled) {
    const reasonLabel = scanAbortReason === "rate_limit" ? "Rate limited" : scanAbortReason === "auth" ? "Auth error" : scanAbortReason === "user_cancel" ? "Cancelled by user" : "Aborted";
    await _ctx.logger("WARNING", `Scan paused (${reasonLabel}) — Downloaded: ${approved}${skippedPart} — click Resume to continue.`, null, { childName, approved, queued });
    try {
      chrome.notifications.create(`scan-abort-${childId}-${Date.now()}`, { type: "basic", iconUrl: "icons/icon128.png", title: "Storypark Smart Saver — Scan Paused", message: `${reasonLabel}: ${approved} saved so far. Click Resume to continue.` });
    } catch { /* notifications may not be granted */ }
  }

  if (!suppressEndMessages) {
    try {
      chrome.notifications.create(`scan-done-${childId}`, { type: "basic", iconUrl: "icons/icon128.png", title: "Storypark Smart Saver", message: `${childName}: ${approved} downloaded, ${queued} to review${skippedAbsent > 0 ? `, ${skippedAbsent} skipped` : ""}` });
    } catch { /* notifications may not be granted */ }
  }

  return { approved, queued, rejected, skippedAbsent, cancelled: scanCancelled };
}
