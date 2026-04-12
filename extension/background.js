/**
 * background.js – Service Worker (Manifest V3)
 *
 * Implements the headless API approach: calls Storypark's internal v3 JSON
 * APIs directly. No DOM scraping, no content script, no Google Photos.
 *
 * Message handlers exposed to popup / options:
 *   GET_CHILDREN      – Return cached children list
 *   REFRESH_PROFILE   – Re-fetch profile from API and update cache
 *   EXTRACT_LATEST       – Incremental fetch (stops at known stories)
 *   DEEP_RESCAN          – Full paginated fetch ignoring history
 *   EXTRACT_ALL_LATEST   – Incremental fetch for every cached child sequentially
 *   DEEP_RESCAN_ALL      – Full paginated fetch for every cached child sequentially
 *   GET_REVIEW_QUEUE  – Return the IndexedDB HITL queue
 *   REVIEW_APPROVE    – Confirm face, update descriptor, download photo
 *   REVIEW_REJECT     – Discard review queue item
 *   GET_ACTIVITY_LOG  – Return the persisted activity log array
 *   CLEAR_ACTIVITY_LOG – Clear the persisted activity log
 */

import {
  getProcessedStories,
  markStoryProcessed,
  getReviewQueue,
  getReviewQueueItem,
  removeFromReviewQueue,
  addToReviewQueue,
  getAllDescriptors,
  getDescriptors,
  saveDescriptor,
  appendDescriptor,
  setDescriptors,
} from "./lib/db.js";

/* ================================================================== */
/*  Scan state                                                         */
/* ================================================================== */

// Declare ALL volatile scan-state variables here, BEFORE any chrome.storage
// calls, to avoid a Temporal Dead Zone (TDZ) ReferenceError when the service
// worker restarts and the restore .then() runs before the declarations below.

let isScanning      = false;
let cancelRequested = false;

/**
 * Temporary history of the last reviewed item for undo support.
 * Stores { action: "approve"|"reject", item, descriptor? }
 */
let lastReviewAction = null;

/** Global request counter for coffee-break logic. */
let _requestCount = 0;

/** Number of requests before the next Coffee Break. Re-randomised after each break. */
let _coffeeBreakAt = Math.floor(Math.random() * 11) + 15; // 15–25

// Restore volatile scan state from session storage in case the service worker
// was suspended and re-activated (e.g. during a Coffee Break idle period).
// This must run after all variable declarations above to avoid TDZ errors.
chrome.storage.session
  .get(["isScanning", "cancelRequested", "_requestCount", "_coffeeBreakAt"])
  .then((data) => {
    isScanning      = data.isScanning      ?? false;
    cancelRequested = data.cancelRequested ?? false;
    _requestCount   = data._requestCount   ?? 0;

    // Safety check: if the restored _coffeeBreakAt is stale (already exceeded
    // by the restored counter, or not set), reset it to a fresh random value
    // so the next Coffee Break fires at the correct time.
    const restored = data._coffeeBreakAt ?? null;
    if (restored !== null && restored > _requestCount) {
      _coffeeBreakAt = restored;
    } else {
      _coffeeBreakAt = Math.floor(Math.random() * 11) + 15;
    }
  })
  .catch(() => {});

/* ================================================================== */
/*  Activity Log                                                       */
/* ================================================================== */

const LOG_MAX_ENTRIES = 200;

/**
 * Log a message at the given severity level.
 * Saves to chrome.storage.local (rolling 200-entry array) and
 * broadcasts to the popup in real-time.
 *
 * @param {"INFO"|"SUCCESS"|"WARNING"|"ERROR"} level
 * @param {string} message
 */
async function logger(level, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  // Persist to storage (rolling window)
  const { activityLog = [] } = await chrome.storage.local.get("activityLog");
  activityLog.push(entry);
  if (activityLog.length > LOG_MAX_ENTRIES) {
    activityLog.splice(0, activityLog.length - LOG_MAX_ENTRIES);
  }
  await chrome.storage.local.set({ activityLog });

  // Broadcast to popup (fire-and-forget)
  chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }).catch(() => {});
}

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
function formatDateDMY(isoOrYMD) {
  if (!isoOrYMD) return "";
  const ymd = isoOrYMD.split("T")[0]; // strip time component if present
  const [year, month, day] = ymd.split("-");
  if (!year || !month || !day) return isoOrYMD;
  // Validate that all three parts are numeric before reformatting
  if (!/^\d+$/.test(year) || !/^\d+$/.test(month) || !/^\d+$/.test(day)) return isoOrYMD;
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
}

/* ================================================================== */
/*  Anti-bot jitter — Human Pacing Algorithm ("Coffee Break")         */
/* ================================================================== */

/**
 * Delay profiles (ms ranges) keyed by action type.
 */
const DELAY_PROFILES = {
  FEED_SCROLL:     [800,  1500],
  READ_STORY:      [2500, 6000],
  DOWNLOAD_MEDIA:  [1000, 2000],
};

/**
 * Smart human-paced delay that replaces the old sleep().
 * Every 15–25 requests forces an extended "Coffee Break" pause.
 *
 * @param {"FEED_SCROLL"|"READ_STORY"|"DOWNLOAD_MEDIA"} actionType
 */
async function smartDelay(actionType) {
  if (cancelRequested) return;
  _requestCount++;
  // Persist the updated counter so it survives service worker suspension.
  chrome.storage.session.set({ _requestCount }).catch(() => {});

  // Coffee Break when the counter reaches the threshold
  if (_requestCount >= _coffeeBreakAt) {
    const breakMs = Math.floor(Math.random() * (25000 - 12000 + 1)) + 12000;
    await logger(
      "INFO",
      `☕ Coffee Break — pausing ${(breakMs / 1000).toFixed(1)}s to avoid bot detection (request #${_requestCount})`
    );
    // Reset for next break
    _requestCount = 0;
    _coffeeBreakAt = Math.floor(Math.random() * 11) + 15; // 15–25
    chrome.storage.session.set({ _requestCount: 0, _coffeeBreakAt }).catch(() => {});
    await new Promise((r) => {
      const handle = setTimeout(() => { clearInterval(poll); r(); }, breakMs);
      const poll   = setInterval(() => {
        if (cancelRequested) { clearTimeout(handle); clearInterval(poll); r(); }
      }, 100);
    });
    return;
  }

  const [minMs, maxMs] = DELAY_PROFILES[actionType] || [1000, 2000];
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((r) => {
    const handle = setTimeout(() => { clearInterval(poll); r(); }, ms);
    const poll   = setInterval(() => {
      if (cancelRequested) { clearTimeout(handle); clearInterval(poll); r(); }
    }, 100);
  });
}

/* ================================================================== */
/*  Storypark API fetch (credentialed, sequential only)                */
/* ================================================================== */

const STORYPARK_BASE = "https://app.storypark.com";

/** Thrown when the server returns 401 (session expired / not logged in). */
class AuthError extends Error {
  constructor(url) {
    super(`Authentication required — please log in to Storypark (401) — ${url}`);
    this.name = "AuthError";
  }
}

/** Thrown when Cloudflare / Storypark rate-limits us (429 or 403). */
class RateLimitError extends Error {
  constructor(status, url) {
    super(`Rate limited by Storypark (${status}) — ${url}`);
    this.name = "RateLimitError";
  }
}

/**
 * Fetch a Storypark API URL using the browser's active session cookies.
 * Never call this inside Promise.all – always await sequentially.
 *
 * @param {string} url
 * @returns {Promise<Object>} Parsed JSON response body
 * @throws {AuthError}      on HTTP 401
 * @throws {RateLimitError} on HTTP 403 or 429
 */
async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) {
    throw new AuthError(url);
  }
  if (res.status === 429 || res.status === 403) {
    throw new RateLimitError(res.status, url);
  }
  if (!res.ok) {
    throw new Error(
      `Storypark API ${res.status} ${res.statusText} — ${url}`
    );
  }
  return res.json();
}

/* ================================================================== */
/*  Offscreen document                                                 */
/* ================================================================== */

let offscreenReady    = false;
let offscreenCreating = null;

async function ensureOffscreen() {
  if (offscreenReady) return;
  // If another concurrent call is already creating the document, wait for it
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = (async () => {
    const exists = await chrome.offscreen.hasDocument().catch(() => false);
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["BLOBS"],
        justification: "Face recognition and EXIF processing for Storypark images",
      });
    }
    offscreenReady = true;
  })().finally(() => {
    offscreenCreating = null;
  });
  await offscreenCreating;
}

/**
 * Send a message to the offscreen document and await its response.
 */
async function sendToOffscreen(message) {
  await ensureOffscreen();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response || response.error || response.ok === false) {
        reject(new Error(response?.error || "Unknown offscreen error"));
      } else {
        resolve(response);
      }
    });
  });
}

/* ================================================================== */
/*  Profile & children                                                 */
/* ================================================================== */

/**
 * Fetch the Storypark user profile, extract the children list, and cache
 * it in chrome.storage.local as { children: [{id, name}] }.
 *
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function loadAndCacheProfile() {
  try {
    const data = await apiFetch(`${STORYPARK_BASE}/api/v3/users/me`);
    const rawChildren = data.user?.children || data.children || [];
    const children = rawChildren.map((c) => ({
      id: String(c.id),
      name: c.name || c.display_name || `Child ${c.id}`,
    }));
    const totalStoryCount =
      data.user?.administered_family_children_teacher_stories ??
      data.administered_family_children_teacher_stories ??
      null;
    const storageUpdate = { children };
    if (totalStoryCount !== null) storageUpdate.totalStoryCount = totalStoryCount;
    await chrome.storage.local.set(storageUpdate);

    // Auto-discover centres/communities from the profile response.
    // The API may include them under various keys; we merge whatever we find.
    const rawCommunities =
      data.user?.communities  ||
      data.communities        ||
      data.user?.services     ||
      data.services           ||
      [];
    const namesFromArray = rawCommunities
      .map((c) => c.name || c.display_name || c.community_name || c.service_name || "")
      .filter(Boolean);

    // Also capture any scalar centre/service name exposed directly on the user object.
    const scalarNames = [
      data.user?.community_name,
      data.user?.service_name,
      data.user?.centre_name,
    ].filter(Boolean);

    const names = [...new Set([...namesFromArray, ...scalarNames])];
    if (names.length > 0) {
      await discoverCentres(names);
      // Persist the first community as the active centre name for use as a
      // fallback when individual stories do not carry a community_name field.
      const { activeCentreName } = await chrome.storage.local.get("activeCentreName");
      if (!activeCentreName) {
        await chrome.storage.local.set({ activeCentreName: names[0] });
      }
    }

    // Also fetch each child's individual profile to extract companies[].name.
    // Many accounts don't expose centre names at the /users/me level, but the
    // child profile endpoint reliably includes them under child.companies[].
    const childCentreNames = [];
    await Promise.all(
      children.map(async (child) => {
        try {
          const childData = await apiFetch(`${STORYPARK_BASE}/api/v3/children/${child.id}`);
          const childObj  = childData.child || childData;
          const companies = childObj.companies || childObj.services || [];
          for (const co of companies) {
            const n = co.name || co.display_name || "";
            if (n) childCentreNames.push(n);
          }
        } catch (err) {
          // Non-fatal — skip this child if the fetch fails
          console.warn(`Failed to fetch profile for child ${child.id}:`, err.message);
        }
      })
    );
    if (childCentreNames.length > 0) {
      await discoverCentres([...new Set(childCentreNames)]);
      const { activeCentreName } = await chrome.storage.local.get("activeCentreName");
      if (!activeCentreName) {
        await chrome.storage.local.set({ activeCentreName: childCentreNames[0] });
      }
    }

    return children;
  } catch (err) {
    await logger("ERROR", `Profile fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Merge newly-discovered centre names into the persisted centreLocations
 * map without overwriting existing GPS data.  Each key is a centre name;
 * values are { lat: number|null, lng: number|null }.
 *
 * @param {string[]} names  One or more centre/community names
 */
async function discoverCentres(names) {
  if (!names || names.length === 0) return;
  const { centreLocations = {} } = await chrome.storage.local.get("centreLocations");
  let changed = false;
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed && !(trimmed in centreLocations)) {
      centreLocations[trimmed] = { lat: null, lng: null };
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ centreLocations });
  }
}

/* ================================================================== */
/*  Story feed pagination                                              */
/* ================================================================== */

/**
 * Fetch story summaries for a child, paginating until either the end of
 * the feed or (in EXTRACT_LATEST mode) a previously seen story is found.
 *
 * @param {string} childId
 * @param {"EXTRACT_LATEST"|"DEEP_RESCAN"} mode
 * @returns {Promise<Array<{id, created_at}>>}
 */
async function fetchStorySummaries(childId, mode) {
  const knownIds =
    mode === "EXTRACT_LATEST"
      ? new Set((await getProcessedStories()).map((s) => s.storyId))
      : new Set();

  const summaries = [];
  let pageToken   = null;
  let pageNum     = 0;

  while (true) {
    const url = new URL(
      `${STORYPARK_BASE}/api/v3/children/${childId}/stories`
    );
    url.searchParams.set("sort_by", "updated_at");
    url.searchParams.set("story_type", "all");
    if (pageToken) url.searchParams.set("next_page_token", pageToken);

    await logger("INFO", `Fetching story page ${pageNum + 1}…`);
    const data   = await apiFetch(url.toString());
    const stories = data.stories || data.items || [];

    let hitKnown = false;
    for (const s of stories) {
      const id = String(s.id);
      if (knownIds.has(id)) {
        hitKnown = true;
        break;
      }
      summaries.push({ id, created_at: s.created_at });
    }

    pageToken = data.next_page_token || null;
    pageNum++;

    if (hitKnown || !pageToken) break;

    await smartDelay("FEED_SCROLL");
  }

  await logger("INFO", `Found ${summaries.length} stories to process.`);
  return summaries;
}

/* ================================================================== */
/*  Daily routine data                                                 */
/* ================================================================== */

// Cache routine summaries by date string to avoid duplicate fetches
const routineCache = new Map();

async function fetchRoutineSummary(childId, dateStr) {
  if (routineCache.has(dateStr)) return routineCache.get(dateStr);

  try {
    await smartDelay("FEED_SCROLL");
    const url  = `${STORYPARK_BASE}/children/${childId}/routines.json?date=${dateStr}`;
    const data = await apiFetch(url);
    const summary = buildRoutineSummary(data);
    routineCache.set(dateStr, summary);
    return summary;
  } catch {
    return "";
  }
}

function buildRoutineSummary(data) {
  const events = [];

  // Iterate through ALL top-level arrays in the routine response and collect
  // every event description exactly as Storypark outputs them, without
  // filtering or categorizing by type.
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const items = data[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const desc =
          item.description || item.summary || item.type || item.name || "";
        if (desc) events.push(desc);
      }
    }
  }

  return events.join(", ");
}

/* ================================================================== */
/*  Main extraction pipeline                                           */
/* ================================================================== */

/** Characters forbidden in filesystem filenames across Windows/macOS/Linux. */
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/** File extensions that indicate a video media item. */
const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

/**
 * Return true if a Storypark media item is a video rather than an image.
 * Checks content_type first, then falls back to file extension heuristics.
 *
 * @param {{ content_type?: string, type?: string, filename?: string, original_url?: string }} mediaItem
 * @returns {boolean}
 */
function isVideoMedia(mediaItem) {
  const ct = (mediaItem.content_type || mediaItem.type || "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  const url = mediaItem.original_url || "";
  const filename = mediaItem.filename || extractFilenameFromUrl(url);
  return VIDEO_EXTENSIONS.test(filename);
}

/** Extract the filename portion from a URL, stripping query parameters. */
function extractFilenameFromUrl(url) {
  return (url.split("/").pop() || "").split("?")[0];
}

function sanitizeName(name) {
  return (name || "Unknown").replace(INVALID_FILENAME_CHARS, "_").trim() || "Unknown";
}

/**
 * Strip HTML tags from a string, collapse whitespace, and trim.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Build the EXIF ImageDescription string from story metadata,
 * following the structured template format.
 *
 * @param {string} body           Raw story body (may contain HTML)
 * @param {string} childFirstName Child's first name (included in Routine line)
 * @param {string} routineText    Comma-separated routine events (may be empty)
 * @param {string} roomName       Room / group name (may be empty)
 * @param {string} centreName     Centre / service name (may be empty)
 * @returns {string}
 */
function buildDescription(body, childFirstName, routineText, roomName, centreName) {
  const parts = [];

  // 1. Full story text, stripped of HTML
  const plainBody = stripHtml(body);
  if (plainBody) parts.push(plainBody);

  // 2. Routine section (only if routine data exists)
  if (routineText) {
    const routineLabel = childFirstName
      ? `${childFirstName}'s Routine: ${routineText}`
      : `Routine: ${routineText}`;
    parts.push(routineLabel);
  }

  // 3. Location / attribution section
  if (roomName) parts.push(roomName);
  if (centreName) parts.push(centreName);
  parts.push("Storypark");

  return parts.join("\n");
}

/**
 * Orchestrate a full extraction run for one child.
 *
 * @param {string} childId
 * @param {string} childName
 * @param {"EXTRACT_LATEST"|"DEEP_RESCAN"} mode
 * @returns {Promise<{approved, queued, rejected}>}
 */
async function runExtraction(childId, childName, mode) {
  await logger(
    "INFO",
    `Starting ${mode === "EXTRACT_LATEST" ? "incremental" : "deep"} scan for ${childName}…`
  );

  const { autoThreshold = 85, minThreshold = 50, activeCentreName = "" } =
    await chrome.storage.local.get(["autoThreshold", "minThreshold", "activeCentreName"]);

  // Attempt to fetch the child's own centre name from their profile,
  // so that multi-centre parents get per-child GPS coordinates rather than
  // the global first-discovered centre name stored in activeCentreName.
  let childCentreFallback = activeCentreName;
  try {
    const childProfile = await apiFetch(`${STORYPARK_BASE}/api/v3/children/${childId}`);
    const child = childProfile.child || childProfile;
    const companies = child.companies || child.services || [];
    if (companies.length > 0) {
      const name = companies[0].name || companies[0].display_name || "";
      if (name) {
        childCentreFallback = name;
        await discoverCentres([name]);
      }
    }
  } catch {
    // Fall back to activeCentreName if child profile fetch fails
  }

  // Ensure the offscreen document's in-memory face descriptors are fully synced
  // with IndexedDB before the first image fetch begins, preventing any race
  // condition where stale descriptors are used for the initial images.
  await sendToOffscreen({ type: "REFRESH_PROFILES" });

  // Load known face descriptors for all children
  const allDescriptors  = await getAllDescriptors();
  const childEncodings  = allDescriptors.map((d) => ({
    childId:     d.childId,
    childName:   d.childName,
    descriptors: d.descriptors,
  }));

  const summaries = await fetchStorySummaries(childId, mode);
  const totalStories = summaries.length;

  let approved = 0;
  let queued   = 0;
  let rejected = 0;

  try {
  for (let si = 0; si < summaries.length; si++) {
    if (cancelRequested) {
      await logger("WARNING", "Scan cancelled by user.");
      chrome.runtime.sendMessage({ type: "LOG", message: "⏹ Scan cancelled." }).catch(() => {});
      break;
    }

    const summary = summaries[si];
    const dateStr = summary.created_at ? summary.created_at.split("T")[0] : null;

    // Broadcast progress
    chrome.runtime.sendMessage({
      type: "PROGRESS",
      current: si + 1,
      total: totalStories,
      date: formatDateDMY(dateStr),
      childName,
    }).catch(() => {});

    await smartDelay("READ_STORY");
    await logger("INFO", `Processing story ${si + 1} of ${totalStories} for ${childName}${dateStr ? ` (${formatDateDMY(dateStr)})` : ""}…`);

    // Fetch full story detail
    let story;
    try {
      const detail = await apiFetch(
        `${STORYPARK_BASE}/api/v3/stories/${summary.id}`
      );
      story = detail.story || detail;
    } catch (err) {
      if (err.name === "AuthError" || err.message.includes("401")) {
        await logger("ERROR", `🛑 ${err.message} — stopping scan to protect account.`);
        break;
      }
      if (err.name === "RateLimitError" || err.message.includes("429") || err.message.includes("403")) {
        await logger("ERROR", `🛑 ${err.message} — stopping scan to protect account.`);
        break;
      }
      await logger("WARNING", `  ✗ Story ${summary.id} fetch failed: ${err.message}`);
      continue;
    }

    const createdAt    = story.created_at || summary.created_at || "";
    const body         = story.body       || "";
    const roomName     = story.group_name     || "";
    const centreName   = story.community_name || story.centre_name || story.service_name || childCentreFallback || "";
    const storyDateStr = createdAt ? createdAt.split("T")[0] : null;
    const childFirstName = (childName || "").split(/\s+/)[0];

    // Auto-discover this centre name (registers it for GPS lookup in Options)
    if (centreName) {
      await discoverCentres([centreName]);
    }

    // Look up GPS coordinates for this centre (user-configured)
    let gpsCoords = null;
    if (centreName) {
      const { centreLocations = {} } = await chrome.storage.local.get("centreLocations");
      const loc = centreLocations[centreName];
      if (loc && loc.lat != null && loc.lng != null) {
        gpsCoords = { lat: loc.lat, lng: loc.lng };
      }
    }

    // Collect media items with original_url, split into images and videos
    const mediaItems = story.media_items || story.assets || story.media || [];
    const itemsWithUrl = mediaItems.filter((m) => m.original_url);
    const images = itemsWithUrl
      .filter((m) => !isVideoMedia(m))
      .map((m) => ({
        originalUrl: m.original_url,
        filename: sanitizeName(
          m.filename ||
          extractFilenameFromUrl(m.original_url) ||
          `${summary.id}.jpg`
        ),
      }));
    const videos = itemsWithUrl
      .filter((m) => isVideoMedia(m))
      .map((m) => ({
        originalUrl: m.original_url,
        filename: sanitizeName(
          m.filename ||
          extractFilenameFromUrl(m.original_url) ||
          `${summary.id}.mp4`
        ),
      }));

    if (images.length === 0 && videos.length === 0) {
      await markStoryProcessed(summary.id, createdAt, childId);
      continue;
    }

    // Fetch routine data for the story date (deduplicated by cache)
    const routineText  = storyDateStr
      ? await fetchRoutineSummary(childId, storyDateStr)
      : "";

    // Process each image sequentially
    let aborted = false;
    for (const img of images) {
      if (cancelRequested) { aborted = true; break; }
      await smartDelay("DOWNLOAD_MEDIA");

      // Compile metadata string to embed in EXIF ImageDescription
      const description = buildDescription(
        body, childFirstName, routineText, roomName, centreName
      );

      const savePath = `Storypark_Smart_Saver/${sanitizeName(childName)}/${img.filename}`;

      let result;
      try {
        result = await sendToOffscreen({
          type: "PROCESS_IMAGE",
          imageUrl:  img.originalUrl,
          storyData: {
            storyId:     summary.id,
            createdAt,
            body,
            roomName,
            centreName,
            originalUrl: img.originalUrl,
            filename:    img.filename,
          },
          description,
          childId,
          childName,
          savePath,
          childEncodings,
          autoThreshold,
          minThreshold,
          gpsCoords,
        });
      } catch (err) {
        if (err.name === "AuthError" || err.message.includes("401")) {
          await logger("ERROR", `🛑 ${err.message} — stopping scan to protect account.`);
          aborted = true;
          break;
        }
        if (err.name === "RateLimitError" || err.message.includes("429") || err.message.includes("403")) {
          await logger("ERROR", `🛑 ${err.message} — stopping scan to protect account.`);
          aborted = true;
          break;
        }
        await logger("WARNING", `  ✗ Processing error: ${err.message}`);
        continue;
      }

      const dateSuffix = storyDateStr ? ` [${formatDateDMY(storyDateStr)}]` : "";
      const forChild   = ` for ${childName}`;
      if (result?.result === "approve") {
        approved++;
        await logger("SUCCESS", `  ✓ Downloaded: ${img.filename}${forChild}${dateSuffix}`);
      } else if (result?.result === "review") {
        queued++;
        await logger(
          "INFO",
          `  👀 Queued for review: ${img.filename}${forChild}${dateSuffix} (${result.matchPct ?? "?"}% match)`
        );
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
      } else {
        rejected++;
      }
    }

    if (aborted) break;

    // Process videos — download directly, no face matching
    for (const vid of videos) {
      if (cancelRequested) { aborted = true; break; }
      await smartDelay("DOWNLOAD_MEDIA");

      // Build a descriptive filename so Google Photos can read the date from it.
      // Google Photos recognises YYYY-MM-DD at the start of a filename and uses
      // it to place the video on the correct date in the timeline (MP4 containers
      // cannot carry EXIF, so the filename date is the only reliable signal).
      // Format: YYYY-MM-DD_ChildName[_RoomName]_originalname.ext
      const dotIdx     = vid.filename.lastIndexOf(".");
      const baseName   = dotIdx >= 0 ? vid.filename.slice(0, dotIdx) : vid.filename;
      const ext        = dotIdx >= 0 ? vid.filename.slice(dotIdx + 1) : "mp4";
      const nameParts  = [
        storyDateStr,
        sanitizeName(childName),
        roomName ? sanitizeName(roomName) : null,
        baseName,
      ].filter(Boolean);
      const videoFilename = sanitizeName(`${nameParts.join("_")}.${ext}`);
      const savePath = `Storypark_Smart_Saver/${sanitizeName(childName)}/${videoFilename}`;

      try {
        await sendToOffscreen({
          type: "DOWNLOAD_VIDEO",
          videoUrl: vid.originalUrl,
          savePath,
        });
        approved++;
        const dateSuffix = storyDateStr ? ` [${formatDateDMY(storyDateStr)}]` : "";
        await logger("SUCCESS", `  🎬 Downloaded video: ${videoFilename} for ${childName}${dateSuffix}`);
      } catch (err) {
        if (err.name === "AuthError" || err.message.includes("401")) {
          await logger("ERROR", `🛑 ${err.message} — stopping scan.`);
          aborted = true;
          break;
        }
        if (err.name === "RateLimitError" || err.message.includes("429") || err.message.includes("403")) {
          await logger("ERROR", `🛑 ${err.message} — stopping scan.`);
          aborted = true;
          break;
        }
        await logger("WARNING", `  ✗ Video download error: ${err.message}`);
      }
    }

    if (aborted) break;

    await markStoryProcessed(summary.id, createdAt, childId);
  }
  } finally {
    routineCache.clear();
    isScanning      = false;
    cancelRequested = false;
    // Persist cleared state so the popup sees accurate status if it re-opens.
    chrome.storage.session
      .set({ isScanning: false, cancelRequested: false, _requestCount: 0 })
      .catch(() => {});
    // Release the heavy Human AI models immediately to prevent memory leaks.
    await chrome.offscreen.closeDocument().catch(() => {});
    offscreenReady = false;
    chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
  }

  const msg = `Scan complete — Downloaded: ${approved}, Review: ${queued}, Rejected: ${rejected}`;
  await logger("SUCCESS", msg);
  return { approved, queued, rejected };
}

/* ================================================================== */
/*  Review approve handler                                             */
/* ================================================================== */

async function handleReviewApprove(id, selectedFaceIndex = 0) {
  const item = await getReviewQueueItem(id);
  if (!item) throw new Error("Review item not found.");

  // Determine which descriptor to use (multi-face support)
  let descriptor = item.descriptor;
  if (item.allFaces && item.allFaces.length > selectedFaceIndex) {
    descriptor = item.allFaces[selectedFaceIndex].descriptor;
  }

  // Persist the confirmed face descriptor for continuous learning
  if (descriptor && item.childId) {
    await appendDescriptor(item.childId, item.childName, descriptor);
    // Refresh the offscreen document's in-memory profile cache so the next
    // batch of processed photos uses the expanded descriptor set.
    sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
  }

  // Look up GPS coordinates for this centre at review-approve time
  let gpsCoords = null;
  const centreName = item.storyData?.centreName;
  if (centreName) {
    const { centreLocations = {} } = await chrome.storage.local.get("centreLocations");
    const loc = centreLocations[centreName];
    if (loc && loc.lat != null && loc.lng != null) {
      gpsCoords = { lat: loc.lat, lng: loc.lng };
    }
  }

  // Delegate image fetch + EXIF stamp + download to the offscreen document
  await sendToOffscreen({
    type:      "DOWNLOAD_APPROVED",
    storyData: item.storyData,
    description: item.description || "",
    childName:  item.childName,
    savePath:   item.savePath,
    gpsCoords,
  });

  await removeFromReviewQueue(id);

  // Store undo state
  lastReviewAction = {
    action: "approve",
    item,
    descriptor: descriptor ? Array.from(descriptor) : null,
  };

  chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
}

/* ================================================================== */
/*  Message router                                                     */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;

  switch (msg.type) {

    case "GET_CHILDREN": {
      chrome.storage.local.get("children", ({ children = [] }) => {
        sendResponse({ ok: true, children });
      });
      return true; // async
    }

    case "REFRESH_PROFILE": {
      loadAndCacheProfile()
        .then((children) => sendResponse({ ok: true, children }))
        .catch((err)     => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "EXTRACT_LATEST":
    case "DEEP_RESCAN": {
      const { childId, childName } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child selected." });
        return false;
      }
      if (isScanning) {
        sendResponse({ ok: false, error: "A scan is already in progress." });
        return false;
      }
      // Set scanning flag synchronously to prevent race conditions.
      isScanning      = true;
      cancelRequested = false;
      // Persist to session storage so the popup can restore state if re-opened
      // while the service worker is still running.
      chrome.storage.session
        .set({ isScanning: true, cancelRequested: false, _requestCount: 0 })
        .catch(() => {});
      runExtraction(childId, childName || childId, msg.type)
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "EXTRACT_ALL_LATEST":
    case "DEEP_RESCAN_ALL": {
      if (isScanning) {
        sendResponse({ ok: false, error: "A scan is already in progress." });
        return false;
      }
      isScanning      = true;
      cancelRequested = false;
      chrome.storage.session
        .set({ isScanning: true, cancelRequested: false, _requestCount: 0 })
        .catch(() => {});
      (async () => {
        const { children = [] } = await chrome.storage.local.get("children");
        if (children.length === 0) {
          isScanning = false;
          chrome.storage.session.set({ isScanning: false }).catch(() => {});
          sendResponse({ ok: false, error: "No children cached. Refresh your profile first." });
          return;
        }
        const mode = msg.type === "EXTRACT_ALL_LATEST" ? "EXTRACT_LATEST" : "DEEP_RESCAN";
        let totalApproved = 0, totalQueued = 0, totalRejected = 0;
        let wasCancelled  = false;
        try {
          for (let i = 0; i < children.length; i++) {
            // Stop before the next child if a cancel was requested.
            // wasCancelled snapshots the state because runExtraction's finally
            // block resets cancelRequested to false after each child.
            if (wasCancelled) break;
            const child = children[i];
            await logger("INFO", `Scanning ${child.name} (${i + 1}/${children.length})…`);
            chrome.runtime.sendMessage({
              type: "LOG",
              message: `📋 Scanning ${child.name} (${i + 1}/${children.length})…`,
            }).catch(() => {});
            try {
              const stats = await runExtraction(child.id, child.name, mode);
              totalApproved  += stats.approved;
              totalQueued    += stats.queued;
              totalRejected  += stats.rejected;
            } catch (err) {
              await logger("ERROR", `Error scanning ${child.name}: ${err.message}`);
            }
            // Snapshot cancellation state before runExtraction's finally resets it,
            // then re-assert isScanning so the outer loop stays active.
            if (cancelRequested) { wasCancelled = true; } else { isScanning = true; }
          }
        } finally {
          isScanning      = false;
          cancelRequested = false;
          chrome.storage.session
            .set({ isScanning: false, cancelRequested: false })
            .catch(() => {});
          chrome.runtime.sendMessage({ type: "SCAN_COMPLETE" }).catch(() => {});
        }
        sendResponse({
          ok: true,
          stats: { approved: totalApproved, queued: totalQueued, rejected: totalRejected },
        });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "CANCEL_SCAN": {
      cancelRequested = true;
      // Persist so the popup sees the cancellation state even after SW suspend.
      chrome.storage.session.set({ cancelRequested: true }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    case "GET_SCAN_STATUS": {
      sendResponse({ ok: true, isScanning, cancelRequested });
      return false;
    }

    case "TEST_CONNECTION": {
      apiFetch(`${STORYPARK_BASE}/api/v3/users/me`)
        .then((data) => {
          const email = data?.user?.email || data?.email || "";
          sendResponse({ ok: true, email });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_REVIEW_QUEUE": {
      getReviewQueue()
        .then((queue) => sendResponse({ ok: true, queue }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "REVIEW_APPROVE": {
      handleReviewApprove(msg.id, msg.selectedFaceIndex ?? 0)
        .then(()    => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "REVIEW_REJECT": {
      (async () => {
        const item = await getReviewQueueItem(msg.id).catch(() => null);
        await removeFromReviewQueue(msg.id);
        // Store undo state
        if (item) {
          lastReviewAction = { action: "reject", item };
        }
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
        sendResponse({ ok: true });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "UNDO_LAST_REVIEW": {
      (async () => {
        if (!lastReviewAction) {
          sendResponse({ ok: false, error: "Nothing to undo." });
          return;
        }
        const { action, item, descriptor } = lastReviewAction;

        // If we approved and learned a descriptor, remove it
        if (action === "approve" && descriptor && item.childId) {
          const existing = await getDescriptors(item.childId).catch(() => null);
          if (existing?.descriptors) {
            // Remove the last descriptor that matches
            const descStr = JSON.stringify(descriptor);
            const idx = existing.descriptors.findLastIndex(
              (d) => JSON.stringify(d) === descStr
            );
            if (idx !== -1) {
              existing.descriptors.splice(idx, 1);
              await setDescriptors(item.childId, existing.childName, existing.descriptors);
              sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
            }
          }
        }

        // Put the item back in the review queue
        await addToReviewQueue(item);
        lastReviewAction = null;
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
        sendResponse({ ok: true });
      })().catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "RESET_FACE_DATA": {
      const { childId } = msg;
      if (!childId) {
        sendResponse({ ok: false, error: "No child specified." });
        return false;
      }
      setDescriptors(childId, "", [])
        .then(() => {
          sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
          sendResponse({ ok: true });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_ACTIVITY_LOG": {
      chrome.storage.local.get("activityLog", ({ activityLog = [] }) => {
        sendResponse({ ok: true, activityLog });
      });
      return true;
    }

    case "CLEAR_ACTIVITY_LOG": {
      chrome.storage.local.set({ activityLog: [] })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "PROCESS_TRAINING_IMAGE": {
      const { childId, childName, imageDataUri, faceIndex = 0 } = msg;
      if (!childId || !imageDataUri) {
        sendResponse({ ok: false, error: "Missing childId or imageDataUri." });
        return false;
      }
      (async () => {
        try {
          const encRes = await sendToOffscreen({
            type:         "BUILD_ENCODING",
            imageDataUrl: imageDataUri,
            faceIndex,
          });
          if (!encRes?.ok || !encRes.descriptor) {
            sendResponse({ ok: false, error: "No face detected in image." });
            return;
          }
          await saveDescriptor(childId, childName ?? childId, encRes.descriptor);
          // Refresh the offscreen profile cache so new training data is used
          // immediately in any subsequent extraction.
          sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    default:
      return false;
  }
});

/* ================================================================== */
/*  Startup – load children into cache                                 */
/* ================================================================== */

chrome.runtime.onInstalled.addListener(() => {
  loadAndCacheProfile();
});

chrome.runtime.onStartup.addListener(() => {
  loadAndCacheProfile();
});
