/**
 * background.js – Service Worker (Manifest V3)
 *
 * Orchestrates the full sync pipeline:
 *   1. Google OAuth via chrome.identity
 *   2. Sends SCRAPE_FEED to the content script
 *   3. For each post: download → face-filter → EXIF → upload → mark processed
 *   4. Persists review queue items in chrome.storage.local for HITL review
 *   5. Tracks processed URLs in IndexedDB (lib/db.js) ONLY after confirmed upload
 *
 * Message handlers exposed to popup / options:
 *   GOOGLE_CONNECT   GOOGLE_DISCONNECT   GOOGLE_STATUS
 *   SYNC_NOW         SET_AUTO_SYNC
 *   LIST_ALBUMS      CREATE_ALBUM
 *   GET_REVIEW_QUEUE REVIEW_APPROVE      REVIEW_REJECT
 *   IMPORT_TRAINING_ALBUM
 */

import { applyExif } from "./lib/exif.js";
import {
  GOOGLE_PHOTOS_API,
  safeFilename,
  log,
} from "./lib/utils.js";
import { getAllProcessedUrls, markProcessedInDB } from "./lib/db.js";

/* ================================================================== */
/*  Google OAuth                                                       */
/* ================================================================== */

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function revokeAuthToken() {
  const token = await getAuthToken(false).catch(() => null);
  if (token) {
    return new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, resolve);
    });
  }
}

/* ================================================================== */
/*  Google Photos API helpers                                          */
/* ================================================================== */

async function listAlbums(token) {
  const albums = [];
  let nextPageToken = "";
  do {
    const url = new URL(`${GOOGLE_PHOTOS_API}/albums`);
    url.searchParams.set("pageSize", "50");
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Albums list failed: ${res.status}`);
    const data = await res.json();
    if (data.albums) albums.push(...data.albums);
    nextPageToken = data.nextPageToken || "";
  } while (nextPageToken);
  return albums;
}

async function listAlbumMediaItems(token, albumId) {
  const items = [];
  let nextPageToken = "";
  do {
    const res = await fetch(`${GOOGLE_PHOTOS_API}/mediaItems:search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        albumId,
        pageSize: 50,
        pageToken: nextPageToken || undefined,
      }),
    });
    if (!res.ok) throw new Error(`Media items list failed: ${res.status}`);
    const data = await res.json();
    if (data.mediaItems) items.push(...data.mediaItems);
    nextPageToken = data.nextPageToken || "";
  } while (nextPageToken);
  return items;
}

async function uploadBytes(token, blob, filename) {
  const res = await fetch(`${GOOGLE_PHOTOS_API}/uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-Goog-Upload-Content-Type": blob.type || "image/jpeg",
      "X-Goog-Upload-Protocol": "raw",
      "X-Goog-Upload-File-Name": filename,
    },
    body: blob,
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }
  if (res.status === 429) {
    throw new Error("QUOTA_EXCEEDED");
  }
  if (res.status === 500) {
    throw new Error("SERVER_ERROR");
  }
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.text();
}

async function createMediaItem(token, uploadToken, filename, description, albumId) {
  const body = {
    newMediaItems: [
      {
        description: description || "",
        simpleMediaItem: { uploadToken, fileName: filename },
      },
    ],
  };
  if (albumId) body.albumId = albumId;

  const res = await fetch(`${GOOGLE_PHOTOS_API}/mediaItems:batchCreate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    throw new Error("QUOTA_EXCEEDED");
  }
  if (res.status === 500) {
    throw new Error("SERVER_ERROR");
  }
  if (!res.ok) throw new Error(`Create media item failed: ${res.status}`);
  const data = await res.json();
  const status = data.newMediaItemResults?.[0]?.status;
  return status?.message === "Success" || status?.message === "OK";
}

async function createAlbum(token, title) {
  const res = await fetch(`${GOOGLE_PHOTOS_API}/albums`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ album: { title } }),
  });
  if (!res.ok) throw new Error(`Create album failed: ${res.status}`);
  return res.json();
}

/* ================================================================== */
/*  Processed-URL ledger (IndexedDB)                                  */
/* ================================================================== */

/**
 * Return the set of all previously-processed image URLs.
 * Delegates to IndexedDB (via lib/db.js) to avoid the 5 MB
 * chrome.storage.local limit for users with years of history.
 *
 * @returns {Promise<Set<string>>}
 */
async function getProcessedUrls() {
  return getAllProcessedUrls();
}

/**
 * Persist newly-processed image URLs into IndexedDB.
 *
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
async function markProcessed(urls) {
  await markProcessedInDB(urls);
}

/* ================================================================== */
/*  Review queue state                                                 */
/* ================================================================== */

async function getReviewQueue() {
  const { reviewQueue = [] } = await chrome.storage.local.get("reviewQueue");
  return reviewQueue;
}

async function saveReviewQueue(queue) {
  await chrome.storage.local.set({ reviewQueue: queue });
}

async function addToReviewQueue(items) {
  const queue = await getReviewQueue();
  // Deduplicate by imageUrl
  const existingUrls = new Set(queue.map((q) => q.imageUrl));
  const newItems = items.filter((i) => !existingUrls.has(i.imageUrl));
  await saveReviewQueue([...queue, ...newItems]);
}

/* ================================================================== */
/*  Image downloading                                                  */
/* ================================================================== */

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return res.blob();
}

/**
 * Convert a Blob to a base64 data URL (works in service workers, no FileReader).
 */
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.slice(i, i + CHUNK)));
  }
  return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(chunks.join(""));
}

/* ================================================================== */
/*  Offscreen document (face recognition)                             */
/* ================================================================== */

const OFFSCREEN_URL = "offscreen.html";

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_SCRAPING"],
    justification:
      "Run @vladmandic/human facial recognition – requires Canvas and HTMLImageElement APIs.",
  });
}

/**
 * Send a batch of posts to the offscreen document for face recognition.
 * Posts must already have `imageDataUrl` populated.
 *
 * @returns {{ autoApprove: Array, reviewQueue: Array } | null}  null on error
 */
async function faceFilterBatch(posts, childEncodings, autoThreshold, minThreshold) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "FACE_FILTER",
        posts,
        childEncodings,
        autoThreshold,
        minThreshold,
      },
      (res) => {
        if (chrome.runtime.lastError) {
          console.error("[bg] offscreen error:", chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(res?.ok ? res : null);
        }
      }
    );
  });
}

/* ================================================================== */
/*  Sync pipeline                                                      */
/* ================================================================== */

async function runSync() {
  await log("=== Sync started ===");

  /* ---- Step 0: Load settings ---- */
  const settings = await chrome.storage.local.get([
    "daycareLat",
    "daycareLon",
    "daycareName",
    "albumId",
    "childEncodings",
    "autoThreshold",
    "minThreshold",
  ]);
  const lat = settings.daycareLat ?? null;
  const lon = settings.daycareLon ?? null;
  const daycareName = settings.daycareName || "Storypark";
  const globalAlbumId = settings.albumId || "";
  const autoThreshold = settings.autoThreshold ?? 85;
  const minThreshold = settings.minThreshold ?? 50;
  const childEncodings = settings.childEncodings || [];

  const hasEncodings = childEncodings.some(
    (c) => Array.isArray(c.descriptor) && c.descriptor.length === 128
  );

  /* ---- Step 1: Get auth token ---- */
  await log("Authenticating with Google…");
  let token;
  try {
    token = await getAuthToken(false);
  } catch {
    throw new Error("Not connected to Google. Please connect first via the popup.");
  }

  /* ---- Step 2: Find the Storypark tab ---- */
  await log("Looking for Storypark tab…");
  const tabs = await chrome.tabs.query({ url: "https://app.storypark.com/*" });
  if (tabs.length === 0) {
    throw new Error("No Storypark tab found. Please open app.storypark.com first.");
  }
  const tabId = tabs[0].id;

  /* ---- Step 3: Scrape the feed ---- */
  await log("Scraping Storypark feed…");
  const processed = await getProcessedUrls();
  const scrapeResult = await chrome.tabs.sendMessage(tabId, {
    type: "SCRAPE_FEED",
    knownUrls: [...processed],
  });

  if (!scrapeResult?.ok) {
    throw new Error(scrapeResult?.error || "Scraping failed.");
  }
  const posts = scrapeResult.posts;
  await log(`Found ${posts.length} new photo(s) to check.`);

  if (posts.length === 0) {
    await log("All caught up! No new photos since the last sync.");
    return { scraped: 0, downloaded: 0, uploaded: 0, reviewQueued: 0 };
  }

  if (hasEncodings) {
    await ensureOffscreenDocument();
  } else {
    await log("No face recognition set up – uploading all photos.");
  }

  /* ---- Steps 4–8: Stream each post through the full pipeline ---- */
  const uploadedUrls = [];
  const reviewQueueItems = [];
  let quotaHit = false;
  let downloadedCount = 0;

  for (const post of posts) {
    if (quotaHit) break;

    /* 4a: Download ONE image */
    let blob;
    try {
      blob = await downloadImage(post.imageUrl);
      downloadedCount++;
    } catch (err) {
      await log(`  ⚠ Couldn't download a photo, skipping for now: ${err.message}`);
      // Give the Service Worker a breath before moving on
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }

    /* 4b: Send ONE image to offscreen for face filtering */
    let approvedPost = { ...post, blob };
    let isReviewItem = false;
    let isDiscarded = false;

    if (hasEncodings) {
      try {
        const imageDataUrl = await blobToBase64(blob);
        const result = await faceFilterBatch(
          [{ ...post, imageDataUrl }],
          childEncodings,
          autoThreshold,
          minThreshold
        );

        if (result) {
          if (result.autoApprove.length > 0) {
            // Re-attach blob to the approved post data
            approvedPost = { ...result.autoApprove[0], blob };
          } else if (result.reviewQueue.length > 0) {
            isReviewItem = true;
            reviewQueueItems.push(result.reviewQueue[0]);
          } else {
            isDiscarded = true;
          }
        } else {
          // Offscreen unavailable – pass through
          await log("  Had trouble checking faces on one photo, uploading it anyway.");
        }
      } catch (err) {
        await log("  Had trouble checking faces on one photo, skipping for now.");
        // Give the Service Worker a breath before moving on
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
    }

    if (isDiscarded) {
      // Give the Service Worker a breath before moving on
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }

    if (isReviewItem) {
      // Mark as processed so it isn't re-scraped; will upload when approved
      await markProcessed([post.imageUrl]);
      // Give the Service Worker a breath before moving on
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }

    /* 4c: Apply EXIF */
    try {
      const date = approvedPost.postDate ? new Date(approvedPost.postDate) : null;
      approvedPost.blob = await applyExif(approvedPost.blob, date, lat, lon);
    } catch (err) {
      // Upload without EXIF rather than skip
    }

    /* 4d: Upload to Google Photos */
    const filename = safeFilename(approvedPost.imageUrl);
    const childLabel = approvedPost.matchedChildren?.length
      ? approvedPost.matchedChildren.join(", ")
      : null;
    const desc = childLabel
      ? `${daycareName} – ${childLabel}`
      : daycareName;

    // Smart album routing: use the first matched child's albumId, fall back to global
    let targetAlbumId = globalAlbumId;
    if (approvedPost.matchedChildren?.length > 0) {
      for (const childName of approvedPost.matchedChildren) {
        const enc = childEncodings.find((c) => c.name === childName);
        if (enc?.albumId) {
          targetAlbumId = enc.albumId;
          break;
        }
      }
    }

    try {
      let uploadToken;
      try {
        uploadToken = await uploadBytes(token, approvedPost.blob, filename);
      } catch (err) {
        if (err.message === "UNAUTHORIZED") {
          // Token expired mid-sync – silently refresh and retry once
          try {
            token = await getAuthToken(false);
          } catch {
            await log("  Had trouble reconnecting to Google – please try syncing again.");
            throw err;
          }
          uploadToken = await uploadBytes(token, approvedPost.blob, filename);
        } else {
          throw err;
        }
      }

      const ok = await createMediaItem(token, uploadToken, filename, desc, targetAlbumId);
      if (ok) {
        /* 4e: Mark as processed immediately after confirmed upload */
        uploadedUrls.push(approvedPost.imageUrl);
        await markProcessed([approvedPost.imageUrl]);
        await log(`  ✓ Saved ${filename}${targetAlbumId ? ` → album ${targetAlbumId}` : ""}`);
      } else {
        await log(`  ⚠ Something unexpected happened saving ${filename} – will try again next sync.`);
      }
    } catch (err) {
      if (err.message === "QUOTA_EXCEEDED") {
        quotaHit = true;
        await log(
          "Sync paused to take a breather! We've saved your progress and will pick up exactly where we left off next time."
        );
      } else if (err.message === "SERVER_ERROR") {
        await log(`  Something went wrong on Google's end for one photo – we'll try again next sync.`);
      } else {
        await log(`  Couldn't save one photo (${err.message}) – moving on.`);
      }
    }

    /* 4f: Give the Service Worker breathing room */
    await new Promise((r) => setTimeout(r, 50));
  }

  /* ---- Step 9: Save review queue items ---- */
  if (reviewQueueItems.length > 0) {
    const queueEntries = reviewQueueItems.map((p) => ({
      id: p.imageUrl,
      imageUrl: p.imageUrl,
      postDate: p.postDate || null,
      postUrl: p.postUrl || null,
      matchPct: p.matchPct ?? 0,
      matchedChildren: p.matchedChildren || [],
    }));
    await addToReviewQueue(queueEntries);
    await log(`${reviewQueueItems.length} photo(s) added to the review queue for your approval.`);
    // Notify popup to refresh its queue display
    try {
      chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" });
    } catch (err) {
      // Expected when the popup is not open; safe to ignore.
      console.debug("[bg] REVIEW_QUEUE_UPDATED not delivered:", err.message);
    }
  }

  const summary = {
    scraped: posts.length,
    downloaded: downloadedCount,
    uploaded: uploadedUrls.length,
    reviewQueued: reviewQueueItems.length,
    quotaHit,
  };
  await log(
    `=== All done! ${summary.uploaded} photo(s) saved to Google Photos` +
      (summary.reviewQueued ? `, ${summary.reviewQueued} waiting for your review` : "") +
      " ==="
  );
  return summary;
}

/* ================================================================== */
/*  Review queue approval / rejection                                  */
/* ================================================================== */

async function approveReviewItem(id) {
  const queue = await getReviewQueue();
  const item = queue.find((q) => q.id === id);
  if (!item) throw new Error(`Review item not found: ${id}`);

  const settings = await chrome.storage.local.get([
    "daycareLat",
    "daycareLon",
    "daycareName",
    "albumId",
    "childEncodings",
  ]);
  const lat = settings.daycareLat ?? null;
  const lon = settings.daycareLon ?? null;
  const daycareName = settings.daycareName || "Storypark";
  const globalAlbumId = settings.albumId || "";
  const childEncodings = settings.childEncodings || [];

  // Smart album routing: use the first matched child's albumId, fall back to global
  let targetAlbumId = globalAlbumId;
  if (item.matchedChildren?.length > 0) {
    for (const childName of item.matchedChildren) {
      const enc = childEncodings.find((c) => c.name === childName);
      if (enc?.albumId) {
        targetAlbumId = enc.albumId;
        break;
      }
    }
  }

  const token = await getAuthToken(false);

  await log(`Approving review item: ${item.imageUrl}`);

  // Re-download the image
  const blob = await downloadImage(item.imageUrl);

  // Apply EXIF
  const date = item.postDate ? new Date(item.postDate) : null;
  const exifBlob = await applyExif(blob, date, lat, lon);

  const filename = safeFilename(item.imageUrl);
  const childLabel = item.matchedChildren?.length
    ? item.matchedChildren.join(", ")
    : null;
  const desc = childLabel ? `${daycareName} – ${childLabel}` : daycareName;

  const uploadToken = await uploadBytes(token, exifBlob, filename);
  const ok = await createMediaItem(token, uploadToken, filename, desc, targetAlbumId);
  if (!ok) throw new Error("Google Photos upload returned unexpected status.");

  // Only mark as processed AFTER confirmed successful upload
  await markProcessed([item.imageUrl]);

  // Remove from queue
  const updated = queue.filter((q) => q.id !== id);
  await saveReviewQueue(updated);
  await log(`  ✓ Approved and uploaded: ${filename}${targetAlbumId ? ` → album ${targetAlbumId}` : ""}`);
  return updated;
}

async function rejectReviewItem(id) {
  const queue = await getReviewQueue();
  const item = queue.find((q) => q.id === id);
  if (item) {
    await markProcessed([item.imageUrl]);
  }
  const updated = queue.filter((q) => q.id !== id);
  await saveReviewQueue(updated);
  return updated;
}

/* ================================================================== */
/*  Training: import from Google Photos album                         */
/* ================================================================== */

async function importTrainingFromAlbum(albumId, childName) {
  const token = await getAuthToken(false);
  const items = await listAlbumMediaItems(token, albumId);

  // Take up to 10 photos
  const candidates = items.filter((m) => m.mimeType?.startsWith("image/")).slice(0, 10);
  if (candidates.length === 0) {
    throw new Error("No photos found in this album.");
  }

  await ensureOffscreenDocument();

  const descriptors = [];
  for (const item of candidates) {
    // Google Photos: append =d to get the download URL
    const downloadUrl = item.baseUrl + "=d";
    let blob;
    try {
      blob = await downloadImage(downloadUrl);
    } catch {
      continue;
    }
    const base64 = await blobToBase64(blob);

    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "BUILD_ENCODING", imageDataUrl: base64 },
        (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        }
      );
    });

    if (result?.ok && result.descriptor) {
      descriptors.push(result.descriptor);
    }
  }

  if (descriptors.length === 0) {
    throw new Error("No faces detected in the selected album photos.");
  }

  // Store as child encoding (replace existing for this child, preserving albumId)
  const { childEncodings = [] } = await chrome.storage.local.get("childEncodings");
  const existing = childEncodings.find((c) => c.name === childName);
  const filtered = childEncodings.filter((c) => c.name !== childName);
  filtered.push({
    name: childName,
    albumId: existing?.albumId || "",
    descriptor: descriptors[0],
    allDescriptors: descriptors,
  });
  await chrome.storage.local.set({ childEncodings: filtered });

  return { count: descriptors.length };
}

/* ================================================================== */
/*  Auto-Sync Alarm                                                   */
/* ================================================================== */

/**
 * Compute the timestamp (ms) for the next occurrence of a given weekday at
 * the specified hour (local time).  weekday: 0=Sun … 6=Sat.
 * If today is the target weekday and the target hour hasn't passed yet,
 * the alarm is scheduled for later today; otherwise it's scheduled for the
 * next occurrence (at least 1 day away).
 */
function nextWeekdayAt(weekday, hourLocal = 9) {
  const now = new Date();
  const result = new Date(now);
  result.setHours(hourLocal, 0, 0, 0);

  // If today is the right weekday and the time hasn't passed yet, use today
  if (now.getDay() === weekday && now < result) {
    return result.getTime();
  }

  // Otherwise advance to the next occurrence (1–7 days away)
  const daysUntil = (weekday - now.getDay() + 7) % 7 || 7;
  result.setDate(result.getDate() + daysUntil);
  return result.getTime();
}

/**
 * Create (or recreate) the auto-sync alarm based on current settings.
 * Clears any existing alarm first.
 */
async function setupAutoSyncAlarm() {
  await chrome.alarms.clear("autoSync");

  const { autoSyncEnabled, autoSyncFrequency } =
    await chrome.storage.local.get(["autoSyncEnabled", "autoSyncFrequency"]);

  if (!autoSyncEnabled) return;

  if (autoSyncFrequency === "weekly-friday") {
    // Fire every Friday at 09:00 local time
    chrome.alarms.create("autoSync", {
      when: nextWeekdayAt(5, 9), // 5 = Friday
      periodInMinutes: 7 * 24 * 60, // repeat weekly
    });
    await log("Auto-sync alarm set: weekly on Fridays at 09:00.");
  } else {
    // Default: daily, firing 24 h from now (and every 24 h thereafter)
    chrome.alarms.create("autoSync", {
      delayInMinutes: 24 * 60,
      periodInMinutes: 24 * 60,
    });
    await log("Auto-sync alarm set: daily.");
  }
}

// Set up the alarm on first install and on every browser start
chrome.runtime.onInstalled.addListener(() => {
  setupAutoSyncAlarm().catch((err) =>
    console.error("[bg] alarm setup failed on install:", err)
  );
});
chrome.runtime.onStartup.addListener(() => {
  setupAutoSyncAlarm().catch((err) =>
    console.error("[bg] alarm setup failed on startup:", err)
  );
});

// Fire the sync pipeline whenever the alarm triggers
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "autoSync") return;
  await log("Auto-sync alarm fired – starting background sync…");
  try {
    const summary = await runSync();
    await log(
      `Auto-sync complete: ${summary.uploaded} uploaded, ` +
        `${summary.reviewQueued} queued for review.`
    );
  } catch (err) {
    await log(`Auto-sync error: ${err.message}`);
  }
});

/* ================================================================== */
/*  Message router                                                     */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "GOOGLE_CONNECT":
      getAuthToken(true)
        .then((token) => sendResponse({ ok: true, token }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "GOOGLE_DISCONNECT":
      revokeAuthToken()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "GOOGLE_STATUS":
      getAuthToken(false)
        .then(() => sendResponse({ connected: true }))
        .catch(() => sendResponse({ connected: false }));
      return true;

    case "SYNC_NOW":
      runSync()
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "SET_AUTO_SYNC":
      chrome.storage.local
        .set({
          autoSyncEnabled: msg.enabled,
          autoSyncFrequency: msg.frequency,
        })
        .then(() => setupAutoSyncAlarm())
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "LIST_ALBUMS":
      getAuthToken(false)
        .then((token) => listAlbums(token))
        .then((albums) => sendResponse({ ok: true, albums }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "CREATE_ALBUM":
      getAuthToken(false)
        .then((token) => createAlbum(token, msg.title))
        .then((album) => sendResponse({ ok: true, album }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "GET_REVIEW_QUEUE":
      getReviewQueue()
        .then((queue) => sendResponse({ ok: true, queue }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "REVIEW_APPROVE":
      approveReviewItem(msg.id)
        .then((queue) => sendResponse({ ok: true, queue }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "REVIEW_REJECT":
      rejectReviewItem(msg.id)
        .then((queue) => sendResponse({ ok: true, queue }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "IMPORT_TRAINING_ALBUM":
      importTrainingFromAlbum(msg.albumId, msg.childName)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    default:
      return false;
  }
});
