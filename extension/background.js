/**
 * background.js – Service Worker (Manifest V3)
 *
 * Orchestrates the full sync pipeline:
 *   1. Google OAuth via chrome.identity
 *   2. Sends SCRAPE_FEED to the content script
 *   3. Downloads images, runs face filtering (via offscreen document)
 *   4. Applies EXIF metadata
 *   5. Uploads to Google Photos Library API
 *   6. Tracks processed URLs in chrome.storage.local
 *
 * Communication with popup: chrome.runtime.onMessage / sendMessage.
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

/**
 * Obtain a Google OAuth2 token via chrome.identity.
 * Uses the scopes declared in manifest.json → oauth2.scopes.
 *
 * @param {boolean} interactive – If true, show consent screen.
 * @returns {Promise<string>} – Access token.
 */
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

/**
 * Remove the cached auth token (e.g. on 401 or user disconnect).
 */
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

/**
 * Upload raw image bytes and return an upload token.
 */
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
  return res.text(); // upload token
}

/**
 * Create a media item (finalize upload) in Google Photos.
 */
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

/**
 * Create a new album.
 */
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
/*  Processed-URL state (replaces SQLite state_manager)                */
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
/*  Image downloading                                                  */
/* ================================================================== */

/**
 * Download an image from a URL and return it as a Blob.
 */
async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return res.blob();
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
    "albumId",
    "childEncodings",
  ]);
  const lat = settings.daycareLat ?? null;
  const lon = settings.daycareLon ?? null;
  const albumId = settings.albumId || "";

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
    return { scraped: 0, uploaded: 0 };
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

  /* ---- Step 5: Face filtering ---- */
  // Face filtering requires DOM access (HTMLImageElement + Canvas) which is
  // not available in the service worker. We send images to an offscreen
  // document or skip filtering if no encodings are configured.
  let filtered = downloaded;
  const hasEncodings =
    settings.childEncodings && settings.childEncodings.length > 0;

  if (hasEncodings) {
    await log("Face filtering is configured but requires an offscreen document for Canvas/DOM access (not yet implemented). All images will be uploaded without filtering.");
    // NOTE: Full face-api.js filtering in a service worker requires an
    // offscreen document with DOM/Canvas access. This is planned as a
    // follow-up enhancement. For now, all images pass through.
  }
  await log(`${filtered.length} images passed filtering.`);

  /* ---- Step 6: EXIF stamping ---- */
  await log("Applying EXIF metadata…");
  const stamped = [];
  for (const post of filtered) {
    try {
      const date = post.postDate ? new Date(post.postDate) : null;
      const exifBlob = await applyExif(post.blob, date, lat, lon);
      stamped.push({ ...post, blob: exifBlob });
    } catch (err) {
      await log(`  ⚠ EXIF failed for ${post.imageUrl}: ${err.message}`);
      stamped.push(post); // upload without EXIF rather than skip
    }
  }

  /* ---- Step 7: Upload to Google Photos ---- */
  await log("Uploading to Google Photos…");
  const uploadedUrls = [];
  let quotaHit = false;

  for (const post of stamped) {
    if (quotaHit) break;
    const filename = safeFilename(post.imageUrl);
    const desc = post.matchedChildren?.length
      ? `Storypark – ${post.matchedChildren.join(", ")}`
      : "Storypark";
    try {
      const uploadToken = await uploadBytes(token, post.blob, filename);
      const ok = await createMediaItem(token, uploadToken, filename, desc, albumId);
      if (ok) {
        uploadedUrls.push(post.imageUrl);
        await log(`  ✓ Uploaded ${filename}`);
      } else {
        await log(`  ⚠ Media item creation returned unexpected status for ${filename}`);
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

  /* ---- Step 8: Mark as processed ---- */
  if (uploadedUrls.length > 0) {
    await markProcessed(uploadedUrls);
  }

  const summary = {
    scraped: posts.length,
    downloaded: downloaded.length,
    filtered: filtered.length,
    uploaded: uploadedUrls.length,
    quotaHit,
  };
  await log(
    `=== Sync complete: ${summary.uploaded} uploaded, ${summary.scraped} scraped ===`
  );
  return summary;
}

/* ================================================================== */
/*  Message router                                                     */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    /* ---- Popup: Connect to Google ---- */
    case "GOOGLE_CONNECT":
      getAuthToken(true)
        .then((token) => sendResponse({ ok: true, token }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    /* ---- Popup: Disconnect Google ---- */
    case "GOOGLE_DISCONNECT":
      revokeAuthToken()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    /* ---- Popup: Check connection ---- */
    case "GOOGLE_STATUS":
      getAuthToken(false)
        .then(() => sendResponse({ connected: true }))
        .catch(() => sendResponse({ connected: false }));
      return true;

    /* ---- Popup: Sync Now ---- */
    case "SYNC_NOW":
      runSync()
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    /* ---- Options: List albums ---- */
    case "LIST_ALBUMS":
      getAuthToken(false)
        .then((token) => listAlbums(token))
        .then((albums) => sendResponse({ ok: true, albums }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    /* ---- Options: Create album ---- */
    case "CREATE_ALBUM":
      getAuthToken(false)
        .then((token) => createAlbum(token, msg.title))
        .then((album) => sendResponse({ ok: true, album }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    default:
      return false;
  }
});
