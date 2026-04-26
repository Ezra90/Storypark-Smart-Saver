/**
 * download-pipe.js — OOM-safe download pipeline + Smart Template Engine
 *
 * Implements the 3-slot download semaphore that prevents service worker OOM
 * during large scans.  All chrome.downloads calls must route through this
 * module — never call chrome.downloads.download() directly.
 *
 * Key design points:
 *   • MAX_CONCURRENT_DOWNLOADS = 3 (semaphore cap)
 *   • Blob URLs are created in the offscreen document (not the SW) so they
 *     stay in the DOM heap, not the SW heap.
 *   • Blob URLs are revoked via REVOKE_BLOB_URL message to offscreen ONLY
 *     inside handleDownloadChanged(), never inline in the download functions.
 *   • The download slot is released inside handleDownloadChanged(), not when
 *     chrome.downloads.download() returns.
 *
 * Smart Template Engine (AI_RULES.md Rule 14):
 *   • sanitizeFilename(name) — strict Windows filesystem sanitization
 *   • buildDynamicName(template, data, index) — parse [Token] templates
 *
 * Setup (call once in background.js, before any downloads):
 *   import { initDownloadPipe, handleDownloadChanged } from './lib/download-pipe.js';
 *   initDownloadPipe({ sendToOffscreen });
 *   chrome.downloads.onChanged.addListener(handleDownloadChanged);
 *
 * Exports:
 *   MAX_CONCURRENT_DOWNLOADS  — 3
 *   initDownloadPipe(opts)    — inject sendToOffscreen callback
 *   handleDownloadChanged(delta) — call from chrome.downloads.onChanged listener
 *   downloadBlob(blob, path)  — download a Blob object to disk
 *   downloadDataUrl(url, path)— download a data: URL string to disk
 *   downloadHtmlFile(url, path) — alias of downloadDataUrl (same pipeline)
 *   downloadVideoFromOffscreen(video) — download a video using pre-made blob URL
 *   sanitizeFilename(name)    — strict Windows filename sanitization
 *   buildDynamicName(template, data, index) — Smart Template Engine
 */

import { sanitizeSavePath } from "./metadata-helpers.js";

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

/**
 * Maximum number of concurrent chrome.downloads.download() calls.
 * Chrome keeps source bytes in memory until each download writes to disk,
 * so capping concurrency prevents SW heap from ballooning on full-history
 * scans (hundreds of photos × multi-MB each).
 */
export const MAX_CONCURRENT_DOWNLOADS = 3;

/* ================================================================== */
/*  Module-level state                                                 */
/* ================================================================== */

let _sendToOffscreenFn = async () => {
  throw new Error("[download-pipe] Not initialized — call initDownloadPipe() first");
};

let   _activeDownloads = 0;
const _downloadQueue   = [];

/**
 * Map of downloadId → { resolve, reject, blobId }.
 * Populated when chrome.downloads.download() fires the callback.
 * Cleaned up by handleDownloadChanged() when the download completes.
 * @type {Map<number, {resolve: Function, reject: Function, blobId?: string}>}
 */
const _pendingDownloadIds = new Map();

/* ================================================================== */
/*  Init                                                               */
/* ================================================================== */

/**
 * Inject the sendToOffscreen function from background.js.
 * Must be called before any download functions are used.
 *
 * @param {object} opts
 * @param {Function} opts.sendToOffscreen  async (message) => response
 */
export function initDownloadPipe({ sendToOffscreen }) {
  _sendToOffscreenFn = sendToOffscreen;
}

/* ================================================================== */
/*  Smart Template Engine (AI_RULES.md Rule 14)                       */
/* ================================================================== */

/**
 * Strict Windows filename sanitization.
 * 
 * Rule 14 requirements:
 *   1. Replace illegal Windows characters (< > : " / \ | ? *) with dash
 *   2. Strip all emojis and non-standard unicode that break Windows indexing
 *   3. Truncate to maximum 100 characters
 *   4. Trim leading/trailing spaces and dots
 *
 * @param {string} name  Raw filename or folder name
 * @returns {string}  Sanitized, Windows-safe filename
 */
export function sanitizeFilename(name) {
  if (!name) return "untitled";
  
  // 1. Replace illegal Windows characters (< > : " / \ | ? *) and control chars
  let sanitized = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
  
  // 2. Strip emojis and problematic unicode
  //    Emoji ranges: \u{1F300}-\u{1FAFF} (main emoji blocks)
  //                  \u{2600}-\u{27BF}   (miscellaneous symbols)
  //                  \u{FE00}-\u{FE0F}   (variation selectors)
  //                  \u{200D}            (zero-width joiner)
  //                  \u{20E3}            (combining enclosing keycap)
  //                  \u{E0020}-\u{E007F} (tag characters)
  sanitized = sanitized.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
    ""
  );
  
  // 3. Collapse multiple spaces/dashes into single dash
  sanitized = sanitized.replace(/\s+/g, " ");
  sanitized = sanitized.replace(/-{2,}/g, "-");
  
  // 4. Trim leading/trailing spaces and dots (Windows doesn't allow trailing dots)
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, "");
  
  // 5. Truncate to 100 characters max
  if (sanitized.length > 100) {
    sanitized = sanitized.substring(0, 100);
  }
  
  // 6. Final trim in case truncation left trailing space/dot
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, "");
  
  // 7. Fallback if we stripped everything
  if (!sanitized || sanitized === "") {
    sanitized = "untitled";
  }
  
  return sanitized;
}

/**
 * Smart Template Engine — parse [Token] templates and replace with API data.
 *
 * Rule 14.2 — Smart Token Filtering:
 *   If a token's data is missing (e.g., [Class] when story has no classroom),
 *   the engine MUST cleanly filter it out and prevent dangling dashes.
 *
 * Example:
 *   Template: "[Date] - [Child] - [Class] - [Title]"
 *   Data: { date: "2025-09-04", childName: "Hugo", roomName: null, title: "Art Day" }
 *   Output: "2025-09-04 - Hugo - Art Day"  (no dangling dashes for missing [Class])
 *
 * @param {string} templateString  e.g., "[Date] - [Child] - [Class] - [Title]"
 * @param {object} apiStoryData    Story data from Storypark API
 * @param {number} [index]         Optional media index (appended as suffix)
 * @returns {string}  Sanitized, fully-resolved filename
 */
export function buildDynamicName(templateString, apiStoryData, index) {
  if (!templateString || typeof templateString !== "string") {
    templateString = "[Date] - [Child] - [Title]"; // sensible default
  }
  
  const data = apiStoryData || {};
  
  // Token map — maps [Token] to actual data field
  const storyDate = data.storyDate || data.date || "";
  const storyTitle = data.storyTitle || data.title || "";
  const centre = data.centreName || data.centre || "";
  const child = data.childName || "";
  const room = data.roomName || data.room || "";
  const educator = data.educatorName || data.educator || "";

  const tokenMap = {
    "[Date]": storyDate,
    "[StoryDate]": storyDate,
    "[Child]": child,
    "[ChildName]": child,
    "[Class]": room,
    "[Room]": room,
    "[Title]": storyTitle,
    "[StoryTitle]": storyTitle,
    "[Daycare]": centre,
    "[Centre]": centre,
    "[CentreName]": centre,
    "[Educator]": educator,
    "[EducatorName]": educator,
    "[OriginalName]": data.originalFilename || "",
  };
  
  // Replace all tokens with their values
  let resolved = templateString;
  for (const [token, value] of Object.entries(tokenMap)) {
    // Preserve rich display data (emojis, unicode) at this stage
    // Sanitization happens at the end
    resolved = resolved.replace(new RegExp(escapeRegex(token), "g"), value || "");
  }
  
  // Smart Token Filtering (Rule 14.2):
  // Split by common delimiters, filter out empty segments, rejoin
  // This prevents "Hugo - - 2025-09-04" from missing [Class]
  const parts = resolved
    .split(/\s*[-_/]\s*/)  // split on dash, underscore, slash
    .map(p => p.trim())
    .filter(p => p.length > 0);  // remove empty segments
  
  resolved = parts.join(" - ");
  
  // Append [Index] if provided (for multi-media stories)
  if (typeof index === "number" && index >= 0) {
    resolved = `${resolved}_${String(index).padStart(2, "0")}`;
  }
  
  // Final sanitization (Rule 14.4) — strip emojis, illegal chars, truncate
  return sanitizeFilename(resolved);
}

/**
 * Escape special regex characters in a string.
 * Used by buildDynamicName to safely match [Token] literals.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ================================================================== */
/*  Semaphore management                                               */
/* ================================================================== */

function _releaseDownloadSlot() {
  _activeDownloads = Math.max(0, _activeDownloads - 1);
  const next = _downloadQueue.shift();
  if (next) next();
}

/**
 * Centralised onChanged handler — MUST be registered in background.js:
 *   chrome.downloads.onChanged.addListener(handleDownloadChanged);
 *
 * Releases the semaphore slot when a download completes or fails.
 * Revokes the blob URL via the offscreen document to free backing memory.
 *
 * @param {chrome.downloads.DownloadDelta} delta
 */
export function handleDownloadChanged(delta) {
  if (!delta?.state?.current) return;
  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;
  const rec = _pendingDownloadIds.get(delta.id);
  if (!rec) return;
  _pendingDownloadIds.delete(delta.id);
  // Tell offscreen to revoke the blob URL (fire-and-forget)
  if (rec.blobId) {
    _sendToOffscreenFn({ type: "REVOKE_BLOB_URL", blobId: rec.blobId }).catch(() => {});
  }
  if (state === "complete") rec.resolve(delta.id);
  else rec.reject(new Error(`Download interrupted: ${delta.error?.current || "unknown"}`));
  _releaseDownloadSlot();
}

/* ================================================================== */
/*  Internal helpers                                                   */
/* ================================================================== */

/**
 * Convert a base64 data URL to a Blob synchronously.
 * Used to decode the dataUrl returned by the offscreen document into a Blob
 * so we can stream it to chrome.downloads via a blob URL.
 *
 * @param {string} dataUrl
 * @returns {Blob}
 */
function _dataUrlToBlob(dataUrl) {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) throw new Error("Invalid data URL");
  const header    = dataUrl.substring(0, commaIdx);
  const mimeMatch = /data:([^;]+)/.exec(header);
  const mime      = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const isBase64  = header.includes(";base64");
  const payload   = dataUrl.substring(commaIdx + 1);
  if (isBase64) {
    const bin = atob(payload);
    const len = bin.length;
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

/**
 * Enqueue a download task through the 3-slot semaphore.
 * Returns a Promise that resolves to the downloadId when the file is written.
 *
 * @param {Function} task  async (resolve, reject) => void
 * @returns {Promise<number>} download ID
 */
function _enqueueDownload(task) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _activeDownloads++;
      try {
        await task(resolve, reject);
      } catch (err) {
        _activeDownloads = Math.max(0, _activeDownloads - 1);
        const next = _downloadQueue.shift();
        if (next) next();
        reject(err);
      }
    };
    if (_activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
      run();
    } else {
      _downloadQueue.push(run);
    }
  });
}

/* ================================================================== */
/*  Public download functions                                          */
/* ================================================================== */

/**
 * Download a Blob to disk via chrome.downloads.download() using a
 * blob URL created in the offscreen document.
 *
 * The blob URL is revoked as soon as the download completes (or fails)
 * via the centralised handleDownloadChanged listener.
 *
 * @param {Blob}   blob
 * @param {string} savePath  e.g. "Storypark Smart Saver/Alice/photo.jpg"
 * @returns {Promise<number>} download ID (resolved when file is written to disk)
 */
export function downloadBlob(blob, savePath) {
  return _enqueueDownload(async (resolve, reject) => {
    try {
      // Convert blob to data URL so we can send it to offscreen for blob URL creation
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const dataUrl = reader.result;
          // Ask offscreen to create the blob URL (offscreen has DOM access)
          const blobUrlResult = await _sendToOffscreenFn({ type: "CREATE_BLOB_URL", dataUrl });
          if (!blobUrlResult.ok) {
            throw new Error(blobUrlResult.error || "Failed to create blob URL");
          }
          const { blobUrl, blobId } = blobUrlResult;
          chrome.downloads.download(
            { url: blobUrl, filename: sanitizeSavePath(savePath), conflictAction: "overwrite", saveAs: false },
            (downloadId) => {
              if (chrome.runtime.lastError || downloadId == null) {
                _sendToOffscreenFn({ type: "REVOKE_BLOB_URL", blobId }).catch(() => {});
                _activeDownloads = Math.max(0, _activeDownloads - 1);
                const next = _downloadQueue.shift();
                if (next) next();
                reject(new Error(chrome.runtime.lastError?.message || "Download failed to start"));
                return;
              }
              // Register so handleDownloadChanged can release slot + revoke blob URL.
              _pendingDownloadIds.set(downloadId, { resolve, reject, blobId });
            }
          );
        } catch (err) {
          _activeDownloads = Math.max(0, _activeDownloads - 1);
          const next = _downloadQueue.shift();
          if (next) next();
          reject(err);
        }
      };
      reader.onerror = () => {
        _activeDownloads = Math.max(0, _activeDownloads - 1);
        const next = _downloadQueue.shift();
        if (next) next();
        reject(new Error("Failed to convert blob to data URL"));
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      _activeDownloads = Math.max(0, _activeDownloads - 1);
      const next = _downloadQueue.shift();
      if (next) next();
      reject(err);
    }
  });
}

/**
 * Back-compat wrapper: accepts the same (dataUrl, savePath) signature used
 * throughout the codebase but internally converts to a Blob first.
 * This flows through the same memory-safe pipeline as downloadBlob().
 *
 * @param {string} dataUrl   e.g. "data:image/jpeg;base64,..."
 * @param {string} savePath  e.g. "Storypark Smart Saver/Alice/photo.jpg"
 * @returns {Promise<number>} download ID
 */
export function downloadDataUrl(dataUrl, savePath) {
  let blob;
  try {
    blob = _dataUrlToBlob(dataUrl);
  } catch (err) {
    return Promise.reject(err);
  }
  return downloadBlob(blob, savePath);
}

/**
 * Download an HTML/text file.
 * Small payloads, but still routes through the semaphore so HTML writes
 * don't jump the queue ahead of JPEG writes and cause spikes.
 *
 * @param {string} dataUrl
 * @param {string} savePath
 * @returns {Promise<number>} download ID
 */
export function downloadHtmlFile(dataUrl, savePath) {
  return downloadDataUrl(dataUrl, savePath);
}

/**
 * Return current download pipeline stats (active slots + queued items).
 * Used by logMemorySnapshot() in background.js for accurate memory reporting.
 *
 * @returns {{ active: number, queued: number }}
 */
export function getDownloadStats() {
  return { active: _activeDownloads, queued: _downloadQueue.length };
}

/**
 * Download a video using a blob URL that was already created in the
 * offscreen document (via DOWNLOAD_VIDEO message).
 *
 * The video bytes stay entirely in the offscreen heap — the service worker
 * only handles the blob URL string.  This avoids the ~64 MB chrome.runtime
 * message size limit that silently corrupted large videos on the legacy path.
 *
 * @param {{ blobUrl: string, blobId: string, savePath: string, size?: number }} video
 * @returns {Promise<number>} download ID
 */
export function downloadVideoFromOffscreen(video) {
  const { blobUrl, blobId, savePath } = video;
  if (!blobUrl || !savePath) {
    return Promise.reject(new Error("downloadVideoFromOffscreen: missing blobUrl or savePath"));
  }
  return _enqueueDownload((resolve, reject) => {
    try {
      chrome.downloads.download(
        { url: blobUrl, filename: sanitizeSavePath(savePath), conflictAction: "overwrite", saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId == null) {
            if (blobId) _sendToOffscreenFn({ type: "REVOKE_BLOB_URL", blobId }).catch(() => {});
            _activeDownloads = Math.max(0, _activeDownloads - 1);
            const next = _downloadQueue.shift();
            if (next) next();
            reject(new Error(chrome.runtime.lastError?.message || "Video download failed to start"));
            return;
          }
          // handleDownloadChanged will release the semaphore + revoke the blob URL
          _pendingDownloadIds.set(downloadId, { resolve, reject, blobId });
        }
      );
    } catch (err) {
      if (blobId) _sendToOffscreenFn({ type: "REVOKE_BLOB_URL", blobId }).catch(() => {});
      _activeDownloads = Math.max(0, _activeDownloads - 1);
      const next = _downloadQueue.shift();
      if (next) next();
      reject(err);
    }
  });
}
