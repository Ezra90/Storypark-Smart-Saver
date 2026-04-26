/**
 * storypark-api.js — Storypark endpoint knowledge + schema adapters
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All knowledge about Storypark's API: endpoint URLs, field names,  │
 * │  API response structures, and how they map to our domain types.    │
 * │                                                                    │
 * │  IF STORYPARK CHANGES THEIR API: edit ONLY this file.              │
 * │  Field renames, new endpoints, response structure changes          │
 * │  should require zero edits outside this file.                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  HTTP transport + rate limiting → lib/api-client.js                │
 * │  Database writes → lib/data-service.js (called FROM this file)     │
 * │  Scan loop logic → lib/scan-engine.js                              │
 * │  EXIF/metadata → lib/metadata-helpers.js                           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * SCHEMA ADAPTERS:
 *   Each `parse*()` function documents EVERY Storypark field variant
 *   it handles.  When Storypark adds a new field name for the same
 *   concept, add it here.  Callers get a clean, normalised value.
 *
 * EXPORTS:
 *
 *   Profile & children:
 *     fetchUserProfile()             — GET /api/v3/users/me
 *     fetchChildProfile(childId)     — GET /api/v3/children/{id}
 *     fetchCentres()                 — GET /api/v3/centres
 *     fetchFamilyCentres()           — GET /api/v3/family/centres
 *     fetchInstitutions(list)        — GET /api/v3/institutions/{id} per entry
 *
 *   Story data:
 *     fetchStorySummaries(childId, mode, childName, cutoffDate, toDate)
 *     fetchStoryDetail(storyId)       — GET /api/v3/stories/{id} (with cache)
 *
 *   Routine data:
 *     fetchRoutineSummary(childId, dateStr)
 *     bulkFetchAttendanceDates(childId)
 *
 *   Schema adapters (pure functions — no I/O):
 *     parseBodyText(story)           — story body text (handles array format)
 *     parseCentreName(story, fallback)
 *     parseEducatorName(story)
 *     parseEducatorId(story)
 *     parseMediaItems(story, storyDate, childName, roomName)
 *     isVideoMedia(item)
 *     extractFilenameFromUrl(url)
 */

import { apiFetch, smartDelay, STORYPARK_BASE } from "./api-client.js";
import { captureApiResponse, captureDecision, DEBUG_TAGS } from "./debug.js";
import {
  mergeCentres,
  saveCentre,
  saveChildren,
  saveChildProfile,
  getChildProfile,
} from "./data-service.js";
import {
  cacheStory, getCachedStory,
  saveEducator,
  isChildProfileStale,
} from "./db.js";
import { sanitizeName } from "./metadata-helpers.js";

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

/** Video file extensions matched by isVideoMedia(). */
const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

/** Day names array — index matches Date.getUTCDay() (0 = Sunday). */
export const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/* ================================================================== */
/*  Profile & children                                                 */
/* ================================================================== */

/**
 * Fetch the authenticated user's profile.
 *
 * Storypark API: GET /api/v3/users/me
 *
 * Persists to:
 *   - chrome.storage.local.children[]
 *   - chrome.storage.local.activeCentreName (if not already set)
 *   - IDB centreProfiles (via mergeCentres)
 *   - triggers centre profile discovery
 *
 * @returns {Promise<import('./types.js').Child[]>} — children list
 */
export async function fetchUserProfile() {
  const url  = `${STORYPARK_BASE}/api/v3/users/me`;
  const data = await apiFetch(url);
  captureApiResponse(url, data);

  // ── Extract children ──
  const rawChildren = data.user?.children || data.children || [];
  const children = rawChildren.map(c => ({
    id:   String(c.id),
    name: c.name || c.display_name || `Child ${c.id}`,
  }));

  // Persist children list
  await saveChildren(children);

  // ── Extract + discover centre names ──
  const communities = data.user?.communities || data.communities || data.user?.services || data.services || [];
  const namesFromCommunities = communities.map(c => ({
    name:    (c.name || c.display_name || c.community_name || c.service_name || "").trim(),
    address: _buildAddress(c),
  })).filter(e => e.name);

  const scalarNames = [
    data.user?.community_name,
    data.user?.service_name,
    data.user?.centre_name,
  ].filter(Boolean).map(n => ({ name: n.trim() }));

  await mergeCentres([...namesFromCommunities, ...scalarNames]);

  // ── Trigger institution discovery ──
  const institutions = data.user?.institutions || data.institutions || [];
  if (institutions.length > 0) {
    fetchInstitutions(institutions).catch(() => {});
  }

  // ── Trigger family centre discovery ──
  fetchCentres().catch(() => {});
  fetchFamilyCentres().catch(() => {});

  return children;
}

/**
 * Fetch a single child's profile.
 *
 * Storypark API: GET /api/v3/children/{id}
 *
 * Returns a ChildProfile with birthday, regularDays, companies, centreIds.
 * Uses a 24h IDB cache to avoid redundant API calls.
 *
 * @param {string} childId
 * @param {string} childName
 * @param {string} [activeCentreFallback]
 * @returns {Promise<{
 *   profile: import('./types.js').ChildProfile,
 *   centreName: string,
 *   fromCache: boolean
 * }>}
 */
export async function fetchChildProfile(childId, childName, activeCentreFallback = "") {
  // ── Cache-first ──
  try {
    const cached = await getChildProfile(childId);
    const isStale = cached ? await isChildProfileStale(childId).catch(() => true) : true;
    if (cached && !isStale) {
      const centreName = (cached.companies?.[0]) || activeCentreFallback;
      return { profile: cached, centreName, fromCache: true };
    }
  } catch { /* fall through to API */ }

  // ── Fetch from API ──
  const url  = `${STORYPARK_BASE}/api/v3/children/${childId}`;
  const data = await apiFetch(url);
  captureApiResponse(url, data);

  const child = data.child || data;

  const companies = child.companies || child.services || [];
  const companyNames = companies.map(c => c.name || c.display_name || "").filter(Boolean);

  // If no companies from direct child profile, try family_centres
  let derivedCentreName = companyNames[0] || "";
  if (!derivedCentreName && child.centre_ids?.length > 0) {
    try {
      const fcData = await apiFetch(`${STORYPARK_BASE}/api/v3/family_centres`);
      const centres = fcData.centres || fcData.services || [];
      const centreIds = new Set((child.centre_ids || []).map(id => String(id)));
      const matched = centres.find(c => centreIds.has(String(c.id)));
      if (matched) derivedCentreName = matched.name || matched.display_name || "";
    } catch { /* ignore */ }
  }

  const profile = {
    childId,
    childName: childName || child.name || child.display_name || `Child ${childId}`,
    birthday:     child.birthday     || null,
    regularDays:  child.regular_days || [],
    companies:    companyNames,
    centreIds:    child.centre_ids   || [],
    fetchedAt:    new Date().toISOString(),
  };

  // Persist to IDB
  await saveChildProfile(profile);

  // Discover the centre
  if (derivedCentreName) {
    await mergeCentres([derivedCentreName]);
  }

  // Also trigger institution discovery from child profile
  const childInstitutions = child.institutions || child.institution;
  if (childInstitutions) {
    fetchInstitutions(Array.isArray(childInstitutions) ? childInstitutions : [childInstitutions]).catch(() => {});
  }

  return {
    profile,
    centreName: derivedCentreName || activeCentreFallback,
    fromCache: false,
  };
}

/**
 * Fetch centres from the dedicated /api/v3/centres endpoint.
 * Merges all discovered centres into IDB + chrome.storage.local.
 *
 * Non-fatal: silently returns if endpoint is unavailable.
 *
 * @returns {Promise<number>} — Number of new centres discovered
 */
export async function fetchCentres() {
  try {
    const url  = `${STORYPARK_BASE}/api/v3/centres`;
    const data = await apiFetch(url);
    captureApiResponse(url, data);

    const centres = data.centres || data.services || [];
    const entries = centres.map(c => ({
      name:    (c.name || c.display_name || "").trim(),
      address: _buildAddress(c),
    })).filter(e => e.name);

    return mergeCentres(entries);
  } catch (err) {
    console.warn("[storypark-api] /api/v3/centres unavailable (non-fatal):", err.message);
    return 0;
  }
}

/**
 * Fetch centres from the family centres endpoint.
 * Tries /api/v3/family/centres and /api/v3/family_centres (both variants).
 *
 * @returns {Promise<number>} — Number of new centres discovered
 */
export async function fetchFamilyCentres() {
  const paths = ["/api/v3/family/centres", "/api/v3/family_centres"];
  for (const path of paths) {
    try {
      const url  = `${STORYPARK_BASE}${path}`;
      const data = await apiFetch(url);
      captureApiResponse(url, data);

      const centres = data.centres || data.services || [];
      if (centres.length === 0) continue;

      const entries = centres.map(c => ({
        name:    (c.name || c.display_name || "").trim(),
        address: _buildAddress(c),
      })).filter(e => e.name);

      return mergeCentres(entries);
    } catch { /* try next path */ }
  }
  return 0;
}

/**
 * Fetch institution details for each institution in the list.
 * Merges discovered institution names into centres.
 *
 * @param {Array<{id: string|number, name?: string}>} institutions
 * @returns {Promise<void>}
 */
export async function fetchInstitutions(institutions) {
  if (!Array.isArray(institutions) || institutions.length === 0) return;
  const entries = [];
  for (const inst of institutions) {
    const id = inst?.id;
    if (!id) continue;
    try {
      const url  = `${STORYPARK_BASE}/api/v3/institutions/${id}`;
      const data = await apiFetch(url);
      captureApiResponse(url, data);

      const obj  = data.institution || data;
      const name = (obj.name || obj.display_name || "").trim();
      if (name) {
        entries.push({ name, address: _buildAddress(obj) });
      }
    } catch (err) {
      console.warn(`[storypark-api] institution ${id} fetch failed (non-fatal):`, err.message);
    }
  }
  if (entries.length > 0) {
    await mergeCentres(entries);
  }
}

/* ================================================================== */
/*  Story data                                                         */
/* ================================================================== */

/**
 * Fetch paginated story summaries for a child.
 *
 * Storypark API: GET /api/v3/children/{id}/stories
 *   Params: sort_by=updated_at, story_type=all, page_token=...
 *   Response: { stories: [...], next_page_token: string|null }
 *
 * Stops pagination when:
 *   - EXTRACT_LATEST mode: a story ID is in the known-processed set
 *   - cutoffDate is set: a story is older than the cutoff
 *   - next_page_token is null
 *   - getCancelRequested() returns true
 *
 * @param {string}    childId
 * @param {"EXTRACT_LATEST"|"DEEP_RESCAN"} mode
 * @param {string}    [childName]
 * @param {Date|null} [cutoffDate]  — Stop when stories are older than this
 * @param {Date|null} [toDate]      — Skip stories newer than this
 * @param {Set<string>} [knownIds] — Already-processed story IDs (EXTRACT_LATEST mode)
 * @param {Function}  [getCancelRequested] — () => boolean
 * @param {Function}  [logger]     — async (level, msg) => void
 * @returns {Promise<import('./types.js').StorySummary[]>}
 */
export async function fetchStorySummaries(
  childId,
  mode,
  childName = "",
  cutoffDate = null,
  toDate = null,
  knownIds = new Set(),
  getCancelRequested = () => false,
  logger = async () => {},
) {
  const summaries = [];
  let pageToken = null;

  while (true) {
    if (getCancelRequested()) break;

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

      // EXTRACT_LATEST: stop when we hit an already-processed story
      if (mode === "EXTRACT_LATEST" && knownIds.has(id)) {
        hitKnown = true;
        break;
      }

      // Date upper bound: skip stories newer than toDate
      if (toDate && s.created_at && new Date(s.created_at) > toDate) continue;

      // Date lower bound: stop paginating when story is older than cutoff
      if (cutoffDate && s.created_at && new Date(s.created_at) < cutoffDate) {
        hitCutoff = true;
        break;
      }

      summaries.push({
        id,
        created_at: s.created_at,
        title: s.title || s.excerpt || s.display_title || "",
      });
    }

    pageToken = data.next_page_token || null;

    // Log progress
    const oldest = summaries.length > 0 ? summaries[summaries.length - 1].created_at : null;
    const oldestStr = oldest ? ` (back to ${oldest.split("T")[0]})` : "";
    await logger("INFO", `Scanning${childName ? ` ${childName}` : ""}… found ${summaries.length} stories${oldestStr}`);

    if (hitKnown || hitCutoff || !pageToken) break;
    await smartDelay("FEED_SCROLL");
  }

  await logger("INFO", `Found ${summaries.length} stories to process${childName ? ` for ${childName}` : ""}.`);
  return summaries;
}

/**
 * Fetch full story detail.
 * Uses the IDB story cache — only calls the API if cache is cold.
 *
 * Storypark API: GET /api/v3/stories/{id}
 *   Response: { story: { ...fields... } } OR flat { ...fields... }
 *
 * @param {string} storyId
 * @returns {Promise<Object>} — Raw story object (pass to parse* functions)
 */
export async function fetchStoryDetail(storyId) {
  // ── Cache-first ──
  const cached = await getCachedStory(String(storyId)).catch(() => null);
  if (cached) return cached;

  // ── Fetch from API ──
  const url    = `${STORYPARK_BASE}/api/v3/stories/${storyId}`;
  const detail = await apiFetch(url);
  const story  = detail.story || detail;
  captureApiResponse(url, story);

  // Cache for future re-scans
  await cacheStory(String(storyId), story).catch(() => {});
  return story;
}

/* ================================================================== */
/*  Routine data                                                       */
/* ================================================================== */

/**
 * Fetch daily routine data for a child on a specific date.
 * Tries the v3 paginated endpoint first, falls back to legacy.
 *
 * Storypark API: GET /api/v3/children/{id}/daily_routines?page_token=null
 *   Response: { daily_routines: [{ date, events: [...] }], next_page_token }
 *
 * Returns { summary: string, detailed: string } or { summary: "", detailed: "" }
 *
 * @param {string} childId
 * @param {string} dateStr — YYYY-MM-DD
 * @returns {Promise<{summary: string, detailed: string}>}
 */
export async function fetchRoutineSummary(childId, dateStr) {
  // Try v3 paginated endpoint
  try {
    await smartDelay("FEED_SCROLL");
    return await _fetchRoutineV3(childId, dateStr);
  } catch { /* fall through */ }

  // Legacy endpoint fallback
  try {
    const url  = `${STORYPARK_BASE}/children/${childId}/routines.json?date=${dateStr}`;
    const data = await apiFetch(url);
    return _buildRoutineSummaryLegacy(data);
  } catch {
    return { summary: "", detailed: "" };
  }
}

/**
 * Bulk-fetch ALL routine dates for a child to build an attendance set.
 * Paginates through all available routine data.
 *
 * @param {string} childId
 * @param {number} [maxPages=100]
 * @returns {Promise<{ attendanceMap: Map<string, {summary:string, detailed:string}>, oldestDate: string|null }>}
 */
export async function bulkFetchAttendanceDates(childId, maxPages = 100) {
  const attendanceMap = new Map(); // date → { summary, detailed }
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
      await smartDelay("FEED_SCROLL");
    } catch { break; }
  }

  return { attendanceMap, oldestDate };
}

/* ================================================================== */
/*  Schema adapters — pure functions, no I/O                          */
/* ================================================================== */

/**
 * Extract the story body text from a raw API response.
 *
 * Storypark field variants (newest to oldest):
 *   display_content — current v3 API; may be a STRING or an ARRAY of blocks
 *   body            — older v3 API
 *   excerpt         — summary/preview (fallback when body is absent)
 *   content         — legacy field (rare)
 *
 * Array format: [{type:"paragraph", text:"..."}, ...]  (Contentful-style)
 * This function ALWAYS returns a plain string, never null/undefined/array.
 *
 * @param {Object} story — Raw API response
 * @returns {string}
 */
export function parseBodyText(story) {
  const raw = story.display_content || story.body || story.excerpt || story.content;
  return _normaliseBodyText(raw);
}

/**
 * Extract the centre/community name from a story.
 *
 * Storypark field variants:
 *   community_name — current v3 field name
 *   centre_name    — alternate naming
 *   service_name   — some account types (services)
 *   group_name     — sometimes used for the community (but also used for rooms!)
 *
 * NOTE: group_name can be EITHER the centre name OR the room name depending
 *   on the account configuration.  This function only uses it if it differs
 *   from the expected room name (callers deduplicate using parseCentreName +
 *   parseRoomName together).
 *
 * @param {Object} story         — Raw API response
 * @param {string} [fallback=""] — Fallback from child profile
 * @returns {string}
 */
export function parseCentreName(story, fallback = "") {
  const name = story.community_name || story.centre_name || story.service_name || "";
  const result = (name || fallback || "").trim();
  if (!result) {
    captureDecision(DEBUG_TAGS.CENTRE_NAME_EMPTY, {
      storyId: story.id,
      fields: { community_name: story.community_name, centre_name: story.centre_name, service_name: story.service_name },
      fallback,
    });
  }
  return result;
}

/**
 * Extract the educator's display name from a story.
 *
 * Storypark field variants:
 *   user.display_name  — current v3 field (most common)
 *   user.name          — some API versions
 *   teachers[0].display_name — stories with multiple teachers
 *   creator.display_name — older API format
 *
 * @param {Object} story — Raw API response
 * @returns {string}
 */
export function parseEducatorName(story) {
  const name = story.user?.display_name
    || story.user?.name
    || story.teachers?.[0]?.display_name
    || story.creator?.display_name
    || "";
  if (!name) {
    captureDecision(DEBUG_TAGS.EDUCATOR_NAME_EMPTY, {
      storyId: story.id,
      userField: story.user,
      teachersField: story.teachers,
      creatorField: story.creator,
    });
  }
  return name;
}

/**
 * Extract the educator's user ID for saveEducator().
 *
 * @param {Object} story — Raw API response
 * @returns {string|null}
 */
export function parseEducatorId(story) {
  const id = story.user?.id || story.creator?.id || null;
  return id ? String(id) : null;
}

/**
 * Parse all media items from a story into normalised MediaItem objects,
 * separated into images and videos.
 *
 * Storypark field variants for media list:
 *   story.media       — current v3 API
 *   story.media_items — alternate field name
 *   story.assets      — older API format
 *
 * Storypark field variants per item:
 *   file_name / filename — original uploaded filename
 *   original_url         — CDN URL for the full-resolution file
 *   content_type / type  — MIME type
 *
 * Generates disk filenames in the format:
 *   YYYY-MM-DD_ChildName[_RoomName]_originalname.ext
 *
 * @param {Object} story
 * @param {string} [storyDate]   — YYYY-MM-DD for filename prefix
 * @param {string} [childName]
 * @param {string} [roomName]
 * @returns {{ images: import('./types.js').MediaItem[], videos: import('./types.js').MediaItem[] }}
 */
export function parseMediaItems(story, storyDate = "", childName = "", roomName = "") {
  const rawItems = story.media || story.media_items || story.assets || [];
  const itemsWithUrl = rawItems.filter(m => m.original_url);

  const images = [];
  const videos = [];

  for (const m of itemsWithUrl) {
    const contentType = m.content_type || m.type || "";
    const url         = m.original_url;
    let fname         = m.file_name || m.filename || extractFilenameFromUrl(url) || "file";

    // Infer extension from content-type if filename has no extension
    if (!/\.\w{2,5}$/.test(fname)) {
      const ct = contentType.toLowerCase();
      if (ct.includes("png"))      fname += ".png";
      else if (ct.includes("gif")) fname += ".gif";
      else if (ct.includes("webp"))fname += ".webp";
      else if (ct.includes("mov")) fname += ".mov";
      else if (ct.includes("webm"))fname += ".webm";
      else if (ct.includes("mp4") || ct.startsWith("video/")) fname += ".mp4";
      else                          fname += ".jpg";
    }

    const item = {
      originalUrl: url,
      filename:    _buildDiskFilename(fname, storyDate, childName, roomName),
      contentType,
    };

    if (isVideoMedia(m)) videos.push(item);
    else                  images.push(item);
  }

  return { images, videos };
}

/**
 * Return true if a Storypark media item is a video.
 *
 * Priority:
 *   1. content_type starts with "video/" (reliable)
 *   2. File extension matches VIDEO_EXTENSIONS (fallback)
 *
 * @param {{ content_type?: string, type?: string, filename?: string, original_url?: string }} item
 * @returns {boolean}
 */
export function isVideoMedia(item) {
  const ct = (item.content_type || item.type || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  const fn = item.filename || item.file_name || extractFilenameFromUrl(item.original_url || "");
  return VIDEO_EXTENSIONS.test(fn);
}

/**
 * Extract the filename portion from a URL, stripping query params.
 *
 * @param {string} url
 * @returns {string}
 */
export function extractFilenameFromUrl(url) {
  return (url.split("/").pop() || "").split("?")[0];
}

/* ================================================================== */
/*  Internal helpers                                                   */
/* ================================================================== */

/**
 * Normalise a raw body value to a plain string.
 * Handles: null/undefined, empty array, string, array of block objects.
 *
 * @param {*} raw
 * @returns {string}
 */
function _normaliseBodyText(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    // Rich-text block format: [{ type: "paragraph", text: "..." }, ...]
    return raw.map(block => {
      if (typeof block === "string") return block;
      // Try common block field names
      return block?.text
        || block?.content
        || block?.value
        || block?.children?.map?.(c => c?.text || c?.content || "").join("")
        || "";
    }).filter(Boolean).join("\n").trim();
  }
  // Object with text/content field (uncommon)
  if (typeof raw === "object") return raw.text || raw.content || String(raw);
  return String(raw);
}

/**
 * Build a human-readable street address string from an API object.
 * Handles: { address, suburb, state, postcode }, { street_address, city }, etc.
 *
 * @param {Object} obj — API response object with address fields
 * @returns {string|null}
 */
function _buildAddress(obj) {
  const parts = [
    obj.address || obj.street_address || obj.street,
    obj.suburb  || obj.city || obj.town,
    obj.state   || obj.province || obj.region,
    obj.postcode || obj.postal_code,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Build a disk filename for a media file.
 * Format: YYYY-MM-DD_ChildName[_RoomName]_originalname.ext
 *
 * @param {string} originalName — Original filename from Storypark
 * @param {string} date         — YYYY-MM-DD
 * @param {string} childName
 * @param {string} roomName
 * @returns {string}
 */
function _buildDiskFilename(originalName, date, childName, roomName) {
  const dotIdx   = originalName.lastIndexOf(".");
  const baseName = dotIdx >= 0 ? originalName.slice(0, dotIdx) : originalName;
  const ext      = dotIdx >= 0 ? originalName.slice(dotIdx + 1) : "jpg";
  const parts    = [
    date       || null,
    childName  ? sanitizeName(childName)  : null,
    roomName   ? sanitizeName(roomName)   : null,
    baseName,
  ].filter(Boolean);
  return sanitizeName(`${parts.join("_")}.${ext}`);
}

/**
 * Fetch routine data using the v3 daily_routines paginated endpoint.
 * Searches through pages until the target date is found.
 *
 * @param {string} childId
 * @param {string} dateStr — YYYY-MM-DD
 * @param {number} [maxPages=5]
 * @returns {Promise<{summary: string, detailed: string}>}
 */
async function _fetchRoutineV3(childId, dateStr, maxPages = 5) {
  let pageToken = "null";
  while (maxPages-- > 0) {
    const url  = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${pageToken}`;
    const data = await apiFetch(url);
    for (const routine of (data.daily_routines || [])) {
      if (routine.date === dateStr) {
        return _buildRoutineDataV3(routine.events || []);
      }
    }
    pageToken = data.next_page_token;
    if (!pageToken) break;
    await smartDelay("FEED_SCROLL");
  }
  return { summary: "", detailed: "" };
}

/**
 * Build { summary, detailed } from v3 routine events.
 *
 * Storypark event fields:
 *   title / full_description / description / routine_type — event title
 *   occurred_at — ISO timestamp
 *   notes — free text notes
 *   bottle.quantity / bottle.measurement — for feeding events
 *   nappy.status — "wet", "full", "dry" etc.
 *
 * @param {Object[]} events
 * @returns {{ summary: string, detailed: string }}
 */
function _buildRoutineDataV3(events) {
  const titles = [];
  const lines  = [];
  const sorted = [...events].sort((a, b) => (a.occurred_at || "").localeCompare(b.occurred_at || ""));

  for (const evt of sorted) {
    const title = evt.title || evt.full_description || evt.description || evt.routine_type || "";
    if (!title) continue;
    titles.push(title);

    // Format time as "H:MMam/pm"
    let timeStr = "";
    if (evt.occurred_at) {
      const d = new Date(evt.occurred_at);
      if (!isNaN(d.getTime())) {
        const h = d.getHours(), m = d.getMinutes();
        const ampm = h >= 12 ? "pm" : "am";
        timeStr = `${h % 12 || 12}:${String(m).padStart(2, "0")}${ampm}`;
      }
    }

    const notes = [];
    if (evt.notes) notes.push(evt.notes);
    if (evt.bottle?.quantity) notes.push(`${evt.bottle.quantity}${evt.bottle.measurement || "ml"}`);
    if (evt.nappy?.status && !title.toLowerCase().includes(evt.nappy.status)) notes.push(evt.nappy.status);
    const noteSuffix = notes.length ? ` (${notes.join(", ")})` : "";
    lines.push(timeStr ? `${timeStr} - ${title}${noteSuffix}` : `${title}${noteSuffix}`);
  }

  return { summary: titles.join(", "), detailed: lines.join("\n") };
}

/**
 * Build { summary, detailed } from the legacy /routines.json response.
 * Legacy format: { sleeps: [...], meals: [...], nappies: [...], ... }
 *
 * @param {Object} data
 * @returns {{ summary: string, detailed: string }}
 */
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
