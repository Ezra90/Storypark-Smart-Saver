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
 */

import {
  getProcessedStories,
  markStoryProcessed,
  getReviewQueue,
  getReviewQueueItem,
  removeFromReviewQueue,
  getAllDescriptors,
  saveDescriptor,
} from "./lib/db.js";

/* ================================================================== */
/*  Anti-bot jitter                                                    */
/* ================================================================== */

/**
 * Sleep for a random duration between min and max milliseconds.
 * All sequential API calls must be wrapped with this to avoid Cloudflare bans.
 *
 * @param {number} min  Default 1500 ms
 * @param {number} max  Default 3500 ms
 */
function sleep(min = 1500, max = 3500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

/* ================================================================== */
/*  Storypark API fetch (credentialed, sequential only)                */
/* ================================================================== */

const STORYPARK_BASE = "https://app.storypark.com";

/**
 * Fetch a Storypark API URL using the browser's active session cookies.
 * Never call this inside Promise.all – always await sequentially.
 *
 * @param {string} url
 * @returns {Promise<Object>} Parsed JSON response body
 */
async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(
      `Storypark API ${res.status} ${res.statusText} — ${url}`
    );
  }
  return res.json();
}

/* ================================================================== */
/*  Progress log                                                       */
/* ================================================================== */

function sendLog(message) {
  // Fire-and-forget; popup may not be open
  chrome.runtime.sendMessage({ type: "LOG", message }).catch(() => {});
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
    const data = await apiFetch(`${STORYPARK_BASE}/api/v3/profile`);
    const children = (data.children || []).map((c) => ({
      id: String(c.id),
      name: c.name || c.display_name || `Child ${c.id}`,
    }));
    await chrome.storage.local.set({ children });
    return children;
  } catch (err) {
    console.error("[background] Profile fetch failed:", err.message);
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

    sendLog(`Fetching story page ${pageNum + 1}…`);
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

    await sleep();
  }

  sendLog(`Found ${summaries.length} stories to process.`);
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
    await sleep(500, 1500);
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

function sanitizeName(name) {
  return (name || "Unknown").replace(/[/\\:*?"<>|]/g, "_").trim() || "Unknown";
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
  sendLog(
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

  let approved = 0;
  let queued   = 0;
  let rejected = 0;

  for (const summary of summaries) {
    await sleep();
    sendLog(`Processing story ${summary.id}…`);

    // Fetch full story detail
    let story;
    try {
      const detail = await apiFetch(
        `${STORYPARK_BASE}/api/v3/stories/${summary.id}`
      );
      story = detail.story || detail;
    } catch (err) {
      sendLog(`  ✗ Story ${summary.id} fetch failed: ${err.message}`);
      continue;
    }

    const createdAt  = story.created_at || summary.created_at || "";
    const body       = story.body       || "";
    const groupName  = story.group_name || story.community_name || "";

    // Collect images with original_url
    const mediaItems = story.media_items || story.assets || story.media || [];
    const images = mediaItems
      .filter((m) => m.original_url)
      .map((m) => ({
        originalUrl: m.original_url,
        filename:
          m.filename ||
          m.original_url.split("/").pop().split("?")[0] ||
          `${summary.id}.jpg`,
      }));

    if (images.length === 0) {
      await markStoryProcessed(summary.id, createdAt, childId);
      continue;
    }

    // Fetch routine data for the story date (deduplicated by cache)
    const dateStr      = createdAt ? createdAt.split("T")[0] : null;
    const routineText  = dateStr
      ? await fetchRoutineSummary(childId, dateStr)
      : "";

    // Process each image sequentially
    for (const img of images) {
      await sleep();

      // Compile metadata string to embed in EXIF ImageDescription
      const description = [
        body,
        groupName  ? `Room: ${groupName}`              : "",
        routineText ? `Daily Routine: ${routineText}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const savePath = `Storypark_Extracts/${sanitizeName(childName)}/${img.filename}`;

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
        sendLog(`  ✗ Processing error: ${err.message}`);
        continue;
      }

      if (result?.result === "approve") {
        approved++;
        sendLog(`  ✓ Downloaded: ${img.filename}`);
      } else if (result?.result === "review") {
        queued++;
        sendLog(
          `  👀 Queued for review: ${img.filename} (${result.matchPct ?? "?"}% match)`
        );
        chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
      } else {
        rejected++;
      }
    }

    await markStoryProcessed(summary.id, createdAt, childId);
  }

  routineCache.clear();
  const msg = `Scan complete — Downloaded: ${approved}, Review: ${queued}, Rejected: ${rejected}`;
  sendLog(msg);
  return { approved, queued, rejected };
}

/* ================================================================== */
/*  Review approve handler                                             */
/* ================================================================== */

async function handleReviewApprove(id) {
  const item = await getReviewQueueItem(id);
  if (!item) throw new Error("Review item not found.");

  // Persist the confirmed face descriptor so future scans auto-approve
  if (item.descriptor && item.childId) {
    await saveDescriptor(item.childId, item.childName, item.descriptor);
  }

  // Delegate image fetch + EXIF stamp + download to the offscreen document
  const res = await sendToOffscreen({
    type:      "DOWNLOAD_APPROVED",
    storyData: item.storyData,
    description: item.description || "",
    childName:  item.childName,
    savePath:   item.savePath,
  });
  if (!res?.ok) throw new Error(res?.error || "Download failed.");

  await removeFromReviewQueue(id);
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
      runExtraction(childId, childName || childId, msg.type)
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "GET_REVIEW_QUEUE": {
      getReviewQueue()
        .then((queue) => sendResponse({ ok: true, queue }))
        .catch((err)  => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "REVIEW_APPROVE": {
      handleReviewApprove(msg.id)
        .then(()    => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case "REVIEW_REJECT": {
      removeFromReviewQueue(msg.id)
        .then(()    => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
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
