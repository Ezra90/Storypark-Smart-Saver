/**
 * background.js – Service Worker (Manifest V3)
 *
 * Implements the headless API approach: calls Storypark's internal v3 JSON
 * APIs directly. No DOM scraping, no content script, no Google Photos.
 *
 * Message handlers exposed to popup / options:
 *   GET_CHILDREN      – Return cached children list
 *   REFRESH_PROFILE   – Re-fetch profile from API and update cache
 *   EXTRACT_LATEST    – Incremental fetch (stops at known stories)
 *   DEEP_RESCAN       – Full paginated fetch ignoring history
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

let isScanning      = false;
let cancelRequested = false;

/**
 * Temporary history of the last reviewed item for undo support.
 * Stores { action: "approve"|"reject", item, descriptor? }
 */
let lastReviewAction = null;

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
/*  Anti-bot jitter — Human Pacing Algorithm ("Coffee Break")         */
/* ================================================================== */

/**
 * Delay profiles (ms ranges) keyed by action type.
 */
const DELAY_PROFILES = {
  FEED_SCROLL:    [800,  1500],
  READ_STORY:     [2500, 6000],
  DOWNLOAD_IMAGE: [1000, 2000],
};

/** Global request counter for coffee-break logic. */
let _requestCount = 0;

/** Number of requests before the next Coffee Break. Re-randomised after each break. */
let _coffeeBreakAt = Math.floor(Math.random() * 11) + 15; // 15–25

/**
 * Smart human-paced delay that replaces the old sleep().
 * Every 15–25 requests forces an extended "Coffee Break" pause.
 *
 * @param {"FEED_SCROLL"|"READ_STORY"|"DOWNLOAD_IMAGE"} actionType
 */
async function smartDelay(actionType) {
  _requestCount++;

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
    await new Promise((r) => setTimeout(r, breakMs));
    return;
  }

  const [minMs, maxMs] = DELAY_PROFILES[actionType] || [1000, 2000];
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((r) => setTimeout(r, ms));
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

let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  const exists = await chrome.offscreen.hasDocument().catch(() => false);
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["BLOBS"],
      justification: "Face recognition and EXIF processing for Storypark images",
    });
  }
  offscreenReady = true;
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
    await chrome.storage.local.set({ children });
    return children;
  } catch (err) {
    await logger("ERROR", `Profile fetch failed: ${err.message}`);
    return [];
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
    const url  = `${STORYPARK_BASE}/api/v3/children/${childId}/routines?date=${dateStr}`;
    const data = await apiFetch(url);
    const summary = buildRoutineSummary(data);
    routineCache.set(dateStr, summary);
    return summary;
  } catch {
    return "";
  }
}

function buildRoutineSummary(data) {
  const parts = [];

  if (Array.isArray(data.meals) && data.meals.length > 0) {
    parts.push(
      "Meals: " +
        data.meals
          .map((m) => m.description || m.type || "meal")
          .join(", ")
    );
  }
  if (Array.isArray(data.sleeps) && data.sleeps.length > 0) {
    const s = data.sleeps[0];
    parts.push(`Sleep: ${s.start_time || ""}–${s.end_time || ""}`);
  }
  if (Array.isArray(data.toileting) && data.toileting.length > 0) {
    parts.push(`Toileting: ${data.toileting.length} time(s)`);
  }

  return parts.join(" | ");
}

/* ================================================================== */
/*  Main extraction pipeline                                           */
/* ================================================================== */

/** Characters forbidden in filesystem filenames across Windows/macOS/Linux. */
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g;

function sanitizeName(name) {
  return (name || "Unknown").replace(INVALID_FILENAME_CHARS, "_").trim() || "Unknown";
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
  if (isScanning) {
    throw new Error("A scan is already in progress. Please wait or cancel it.");
  }
  isScanning      = true;
  cancelRequested = false;

  await logger(
    "INFO",
    `Starting ${mode === "EXTRACT_LATEST" ? "incremental" : "deep"} scan for ${childName}…`
  );

  const { autoThreshold = 85, minThreshold = 50 } =
    await chrome.storage.local.get(["autoThreshold", "minThreshold"]);

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
      date: dateStr || "",
    }).catch(() => {});

    await smartDelay("READ_STORY");
    await logger("INFO", `Processing story ${summary.id}${dateStr ? ` (${dateStr})` : ""}…`);

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

    const createdAt  = story.created_at || summary.created_at || "";
    const body       = story.body       || "";
    const groupName  = story.group_name || story.community_name || "";
    const storyDateStr = createdAt ? createdAt.split("T")[0] : null;

    // Collect images with original_url
    const mediaItems = story.media_items || story.assets || story.media || [];
    const images = mediaItems
      .filter((m) => m.original_url)
      .map((m) => ({
        originalUrl: m.original_url,
        filename: sanitizeName(
          m.filename ||
          m.original_url.split("/").pop().split("?")[0] ||
          `${summary.id}.jpg`
        ),
      }));

    if (images.length === 0) {
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
      await smartDelay("DOWNLOAD_IMAGE");

      // Compile metadata string to embed in EXIF ImageDescription
      const description = [
        body,
        groupName  ? `Room: ${groupName}`              : "",
        routineText ? `Daily Routine: ${routineText}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

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
            groupName,
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

      const dateSuffix = storyDateStr ? ` [${storyDateStr}]` : "";
      if (result?.result === "approve") {
        approved++;
        await logger("SUCCESS", `  ✓ Downloaded: ${img.filename}${dateSuffix}`);
      } else if (result?.result === "review") {
        queued++;
        await logger(
          "INFO",
          `  👀 Queued for review: ${img.filename}${dateSuffix} (${result.matchPct ?? "?"}% match)`
        );
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
      } else {
        rejected++;
      }
    }

    if (aborted) break;

    await markStoryProcessed(summary.id, createdAt, childId);
  }
  } finally {
    routineCache.clear();
    isScanning      = false;
    cancelRequested = false;
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

  // Delegate image fetch + EXIF stamp + download to the offscreen document
  await sendToOffscreen({
    type:      "DOWNLOAD_APPROVED",
    storyData: item.storyData,
    description: item.description || "",
    childName:  item.childName,
    savePath:   item.savePath,
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
      runExtraction(childId, childName || childId, msg.type)
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "CANCEL_SCAN": {
      cancelRequested = true;
      sendResponse({ ok: true });
      return false;
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
