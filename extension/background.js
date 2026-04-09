/**
 * background.js – Service Worker (Manifest V3)
 *
 * Orchestrates the full sync pipeline:
 *   1. Google OAuth via chrome.identity
 *   2. Sends SCRAPE_FEED to the content script
 *   3. Downloads images, converts to base64 for offscreen face filtering
 *   4. Offscreen document classifies photos: auto-approve / review queue / discard
 *   5. Applies EXIF metadata (date + GPS) to approved images
 *   6. Uploads to Google Photos Library API
 *   7. Persists review queue items in chrome.storage.local for HITL review
 *   8. Tracks processed URLs to avoid re-uploading
 *
 * Message handlers exposed to popup / options:
 *   GOOGLE_CONNECT   GOOGLE_DISCONNECT   GOOGLE_STATUS
 *   SYNC_NOW
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

  if (res.status === 429 || res.status === 500) {
    throw new Error("QUOTA_EXCEEDED");
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
  if (res.status === 429 || res.status === 500) {
    throw new Error("QUOTA_EXCEEDED");
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
/*  Processed-URL state                                                */
/* ================================================================== */

async function getProcessedUrls() {
  const { processedUrls = [] } = await chrome.storage.local.get("processedUrls");
  return new Set(processedUrls);
}

async function markProcessed(urls) {
  const { processedUrls = [] } = await chrome.storage.local.get("processedUrls");
  const merged = [...new Set([...processedUrls, ...urls])];
  await chrome.storage.local.set({ processedUrls: merged });
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
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.slice(i, i + CHUNK));
  }
  return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(binary);
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
      "Run face-api.js facial recognition – requires Canvas and HTMLImageElement APIs.",
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
  const albumId = settings.albumId || "";
  const autoThreshold = settings.autoThreshold ?? 85;
  const minThreshold = settings.minThreshold ?? 50;
  const childEncodings = settings.childEncodings || [];

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
  await log(`Scraper returned ${posts.length} new images.`);

  if (posts.length === 0) {
    await log("Nothing new to process. Sync complete.");
    return { scraped: 0, uploaded: 0, reviewQueued: 0 };
  }

  /* ---- Step 4: Download images ---- */
  await log("Downloading images…");
  const downloaded = [];
  for (const post of posts) {
    try {
      const blob = await downloadImage(post.imageUrl);
      downloaded.push({ ...post, blob });
    } catch (err) {
      await log(`  ⚠ Failed to download: ${err.message}`);
    }
  }
  await log(`Downloaded ${downloaded.length} / ${posts.length} images.`);

  /* ---- Step 5: Face filtering via offscreen document ---- */
  let autoApprove = downloaded;
  let reviewQueueItems = [];
  const hasEncodings = childEncodings.some(
    (c) => Array.isArray(c.descriptor) && c.descriptor.length === 128
  );

  if (hasEncodings) {
    await log("Running face recognition via offscreen document…");
    try {
      await ensureOffscreenDocument();

      // Process in batches of 5 to keep message sizes manageable
      const BATCH = 5;
      autoApprove = [];

      for (let i = 0; i < downloaded.length; i += BATCH) {
        const batch = downloaded.slice(i, i + BATCH);

        // Convert blobs to base64 data URLs for the offscreen document
        const postsWithData = await Promise.all(
          batch.map(async (post) => ({
            ...post,
            imageDataUrl: await blobToBase64(post.blob),
            blob: undefined,
          }))
        );

        const result = await faceFilterBatch(
          postsWithData,
          childEncodings,
          autoThreshold,
          minThreshold
        );

        if (result) {
          // Re-attach original blobs to auto-approve items
          for (const p of result.autoApprove) {
            const orig = batch.find((b) => b.imageUrl === p.imageUrl);
            autoApprove.push({ ...p, blob: orig?.blob });
          }
          // Review queue items don't need blobs (we re-download on approve)
          reviewQueueItems.push(...result.reviewQueue);
        } else {
          // Offscreen failed (e.g., face-api.js not installed) → pass through
          await log("  ⚠ Face filter unavailable – passing batch through.");
          autoApprove.push(...batch);
        }
      }

      await log(
        `Face filter: ${autoApprove.length} auto-approve, ` +
          `${reviewQueueItems.length} queued for review, ` +
          `${downloaded.length - autoApprove.length - reviewQueueItems.length} discarded.`
      );
    } catch (err) {
      await log(`  ⚠ Face filter error (${err.message}) – uploading all.`);
      autoApprove = downloaded;
    }
  } else {
    await log(
      "No face encodings configured – all images will be uploaded without filtering."
    );
  }

  /* ---- Step 6: EXIF stamping ---- */
  await log("Applying EXIF metadata…");
  const stamped = [];
  for (const post of autoApprove) {
    try {
      const date = post.postDate ? new Date(post.postDate) : null;
      const exifBlob = await applyExif(post.blob, date, lat, lon);
      stamped.push({ ...post, blob: exifBlob });
    } catch (err) {
      await log(`  ⚠ EXIF failed for ${post.imageUrl}: ${err.message}`);
      stamped.push(post); // upload without EXIF rather than skip
    }
  }

  /* ---- Step 7: Upload auto-approved photos to Google Photos ---- */
  await log("Uploading to Google Photos…");
  const uploadedUrls = [];
  let quotaHit = false;

  for (const post of stamped) {
    if (quotaHit) break;
    const filename = safeFilename(post.imageUrl);
    const childLabel = post.matchedChildren?.length
      ? post.matchedChildren.join(", ")
      : null;
    const desc = childLabel
      ? `${daycareName} – ${childLabel}`
      : daycareName;

    try {
      const uploadToken = await uploadBytes(token, post.blob, filename);
      const ok = await createMediaItem(token, uploadToken, filename, desc, albumId);
      if (ok) {
        uploadedUrls.push(post.imageUrl);
        await log(`  ✓ Uploaded ${filename}`);
      } else {
        await log(`  ⚠ Unexpected status for ${filename}`);
      }
    } catch (err) {
      if (err.message === "QUOTA_EXCEEDED") {
        await log("⚠ Google Photos daily quota reached. Try again tomorrow.");
        quotaHit = true;
      } else {
        await log(`  ✗ Upload failed: ${err.message}`);
      }
    }
  }

  /* ---- Step 8: Save review queue items ---- */
  if (reviewQueueItems.length > 0) {
    const queueEntries = reviewQueueItems.map((p) => ({
      id: p.imageUrl, // imageUrl is the stable key
      imageUrl: p.imageUrl,
      postDate: p.postDate || null,
      postUrl: p.postUrl || null,
      matchPct: p.matchPct ?? 0,
      matchedChildren: p.matchedChildren || [],
    }));
    await addToReviewQueue(queueEntries);
    await log(`${reviewQueueItems.length} photo(s) added to the review queue.`);
    // Notify popup to refresh its queue display
    try {
      chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" });
    } catch {
      /* popup may not be open */
    }
  }

  /* ---- Step 9: Mark as processed ---- */
  const allProcessedUrls = [
    ...uploadedUrls,
    // Also mark review-queued items so we don't re-process them on next sync
    ...reviewQueueItems.map((p) => p.imageUrl),
    // Mark discarded items (those not in autoApprove or reviewQueue) as processed
    ...downloaded
      .filter(
        (p) =>
          !autoApprove.some((a) => a.imageUrl === p.imageUrl) &&
          !reviewQueueItems.some((r) => r.imageUrl === p.imageUrl)
      )
      .map((p) => p.imageUrl),
  ];
  if (allProcessedUrls.length > 0) {
    await markProcessed(allProcessedUrls);
  }

  const summary = {
    scraped: posts.length,
    downloaded: downloaded.length,
    uploaded: uploadedUrls.length,
    reviewQueued: reviewQueueItems.length,
    quotaHit,
  };
  await log(
    `=== Sync complete: ${summary.uploaded} uploaded, ` +
      `${summary.reviewQueued} queued for review ===`
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
  ]);
  const lat = settings.daycareLat ?? null;
  const lon = settings.daycareLon ?? null;
  const daycareName = settings.daycareName || "Storypark";
  const albumId = settings.albumId || "";

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
  const ok = await createMediaItem(token, uploadToken, filename, desc, albumId);
  if (!ok) throw new Error("Google Photos upload returned unexpected status.");

  await markProcessed([item.imageUrl]);

  // Remove from queue
  const updated = queue.filter((q) => q.id !== id);
  await saveReviewQueue(updated);
  await log(`  ✓ Approved and uploaded: ${filename}`);
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

  // Store as child encoding (replace existing for this child)
  const { childEncodings = [] } = await chrome.storage.local.get("childEncodings");
  const filtered = childEncodings.filter((c) => c.name !== childName);
  filtered.push({ name: childName, descriptor: descriptors[0], allDescriptors: descriptors });
  await chrome.storage.local.set({ childEncodings: filtered });

  return { count: descriptors.length };
}

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
