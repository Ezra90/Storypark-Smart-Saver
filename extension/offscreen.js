/**
 * offscreen.js – Image processing worker (offscreen document).
 *
 * Loaded as a module inside offscreen.html, which grants access to
 * Canvas, Blob, URL.createObjectURL, and chrome.downloads.
 *
 * Message protocol (chrome.runtime.onMessage):
 *
 *   IN  { type: "PROCESS_IMAGE", imageUrl, storyData, description,
 *         childId, childName, savePath, childEncodings,
 *         autoThreshold, minThreshold }
 *   OUT { result: "approve" | "review" | "reject",
 *         matchPct?: number, error?: string }
 *
 *   IN  { type: "DOWNLOAD_APPROVED", storyData, description,
 *         childName, savePath }
 *   OUT { ok: true } | { ok: false, error: string }
 *
 *   IN  { type: "BUILD_ENCODING", imageDataUrl }
 *   OUT { ok: true, descriptor: number[] }
 *   OUT { ok: false, error: string }
 *
 *   IN  { type: "REFRESH_PROFILES" }
 *   OUT { ok: true }
 *   OUT { ok: false, error: string }
 */

import { applyExif }                          from "./lib/exif.js";
import { addToReviewQueue, appendDescriptor,
         getAllDescriptors }                   from "./lib/db.js";

/* global Human */

/* ================================================================== */
/*  @vladmandic/human setup                                            */
/* ================================================================== */

const HUMAN_CONFIG = {
  modelBasePath: chrome.runtime.getURL("models/"),
  face: {
    enabled:     true,
    detector:    { enabled: true, modelPath: "blazeface.json", rotation: false },
    mesh:        { enabled: false },
    iris:        { enabled: false },
    description: { enabled: true,  modelPath: "faceres.json" },
    emotion:     { enabled: false },
    antispoof:   { enabled: false },
    liveness:    { enabled: false },
  },
  body:        { enabled: false },
  hand:        { enabled: false },
  object:      { enabled: false },
  gesture:     { enabled: false },
  segmentation:{ enabled: false },
};

let human        = null;
let modelsLoaded = false;

async function ensureModels() {
  if (modelsLoaded) return;

  // Graceful fallback: if human.js was not bundled (optional dependency),
  // log a warning and continue in "approve every image" mode — exactly as
  // described in the README: "Without these files, all photos pass through
  // without face filtering (every image is downloaded automatically)."
  if (typeof Human === "undefined") {
    console.warn(
      "[offscreen] human.js not found — face recognition disabled. " +
      "Run `npm run setup` to enable it. All photos will be downloaded automatically."
    );
    modelsLoaded = false; // remains false so callers can detect the fallback
    return;               // do NOT throw — continue without detection
  }

  try {
    human        = new Human.Human(HUMAN_CONFIG);
    await human.load();
    modelsLoaded = true;
    console.debug("[offscreen] Human models loaded.");
  } catch (err) {
    // Model loading failed (e.g. missing .bin/.json files in extension/models/).
    // Fall back to "approve every image" mode rather than crashing the pipeline.
    console.warn(
      "[offscreen] Failed to load face recognition models — falling back to " +
      "'approve all' mode. All photos will be downloaded automatically.", err
    );
    human        = null;
    modelsLoaded = false; // remains false; callers use this to skip detection
  }
}

/* ================================================================== */
/*  In-session profile cache                                           */
/* ================================================================== */

/** Maximum descriptors per child – must match db.js. */
const MAX_DESCRIPTORS_PER_CHILD = 30;

/**
 * In-memory map of childId → {childId, childName, descriptors: number[][]}.
 * Populated on REFRESH_PROFILES and updated whenever a new descriptor is
 * appended during the current session so subsequent images in the same batch
 * benefit immediately without a round-trip to IndexedDB.
 */
const _localProfiles = new Map();

/**
 * Merge the descriptor list passed from background.js with any in-session
 * updates accumulated in _localProfiles.  For any childId present in
 * _localProfiles, its entry overrides the one from childEncodings (as it
 * contains the most up-to-date descriptors).  Children only present in
 * _localProfiles are appended at the end.
 *
 * @param {Array<{childId, childName, descriptors}>} childEncodings
 * @returns {Array<{childId, childName, descriptors}>}
 */
function mergeWithLocalProfiles(childEncodings) {
  if (_localProfiles.size === 0) return childEncodings;
  const merged = childEncodings.map((enc) => {
    const local = _localProfiles.get(enc.childId);
    return local ? { ...enc, descriptors: local.descriptors } : enc;
  });
  for (const [childId, profile] of _localProfiles) {
    if (!merged.some((e) => e.childId === childId)) {
      merged.push(profile);
    }
  }
  return merged;
}

/* ================================================================== */
/*  Image loading helpers                                              */
/* ================================================================== */

/**
 * Wrap an ArrayBuffer in a Blob, create an object URL, and load into
 * an <img> element. Returns both the element and the URL so the caller
 * can revoke the URL when done.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{img: HTMLImageElement, blobUrl: string}>}
 */
function arrayBufferToImage(buffer) {
  return new Promise((resolve, reject) => {
    const blob    = new Blob([buffer], { type: "image/jpeg" });
    const blobUrl = URL.createObjectURL(blob);
    const img     = new Image();
    img.onload  = () => resolve({ img, blobUrl });
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error("Failed to load image from buffer"));
    };
    img.src = blobUrl;
  });
}

/**
 * Load a data: URL into an HTMLImageElement.
 */
function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img   = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image from data URL."));
    img.src     = dataUrl;
  });
}

/* ================================================================== */
/*  Face matching                                                      */
/* ================================================================== */

/**
 * Compute cosine similarity between two numeric vectors.
 */
function cosineSimilarity(a, b) {
  let dotProduct = 0, normVectorA = 0, normVectorB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct  += a[i] * b[i];
    normVectorA += a[i] * a[i];
    normVectorB += b[i] * b[i];
  }
  const denom = Math.sqrt(normVectorA) * Math.sqrt(normVectorB);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * Return the best match percentage (0–100) between an embedding and a
 * set of stored descriptors.
 *
 * Prefers `human.match.similarity()` (same metric used by face.js) for
 * consistency; falls back to the local `cosineSimilarity()` when the
 * Human instance is not yet available.
 *
 * @param {number[]|Float32Array} embedding
 * @param {number[][]}            descriptors
 * @returns {number}
 */
function bestMatchPercent(embedding, descriptors) {
  if (!descriptors || descriptors.length === 0) return 0;
  const embArr = Array.from(embedding);
  let best = 0;
  for (const desc of descriptors) {
    const descArr = Array.isArray(desc) ? desc : Array.from(desc);
    const sim = (human && human.match)
      ? human.match.similarity(embArr, descArr)
      : cosineSimilarity(embArr, descArr);
    const pct = Math.max(0, Math.round(sim * 100));
    if (pct > best) best = pct;
  }
  return best;
}

/* ================================================================== */
/*  Face crop helper                                                   */
/* ================================================================== */

/**
 * Crop a detected face bounding box from an image element and return a
 * data URL (JPEG) of the cropped region.
 *
 * @param {HTMLImageElement} img
 * @param {number[]} box   [x, y, width, height] in pixels
 * @returns {string} data URL
 */
function cropFaceToDataUrl(img, box) {
  const pad = 10;
  const sx  = Math.max(0, box[0] - pad);
  const sy  = Math.max(0, box[1] - pad);
  const sw  = Math.min(img.naturalWidth  - sx, box[2] + pad * 2);
  const sh  = Math.min(img.naturalHeight - sy, box[3] + pad * 2);

  const canvas = document.createElement("canvas");
  canvas.width  = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/jpeg", 0.8);
}

/* ================================================================== */
/*  Download helper                                                    */
/* ================================================================== */

/**
 * Create an object URL from a Blob, trigger a download via
 * chrome.downloads.download(), then immediately revoke the URL.
 *
 * @param {Blob}   blob
 * @param {string} savePath   e.g. "Storypark_Smart_Saver/Alice/photo.jpg"
 */
function downloadBlob(blob, savePath) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename: savePath, conflictAction: "uniquify" },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          URL.revokeObjectURL(url);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          // Delay revocation so the browser has time to read the blob data
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          resolve(downloadId);
        }
      }
    );
  });
}

/* ================================================================== */
/*  Core pipeline: fetch → detect → decide                            */
/* ================================================================== */

/**
 * Full single-image pipeline:
 *   1. Fetch image (credentialed, uses Storypark session cookies)
 *   2. Run face detection
 *   3. Approve / queue for review / reject
 *
 * @returns {{ result: "approve"|"review"|"reject", matchPct?: number }}
 */
async function processImage(msg) {
  const {
    imageUrl,
    storyData,
    description,
    childId,
    childName,
    savePath,
    childEncodings = [],
    autoThreshold  = 85,
    minThreshold   = 50,
    gpsCoords      = null,
  } = msg;

  // ---- 1. Fetch image ----
  const res = await fetch(imageUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${imageUrl}`);
  const buffer = await res.arrayBuffer();

  // ---- 2. If no encodings configured, auto-approve everything ----
  if (childEncodings.length === 0) {
    const srcBlob    = new Blob([buffer], { type: "image/jpeg" });
    const date       = storyData.createdAt ? new Date(storyData.createdAt) : null;
    const stampedBlob = await applyExif(srcBlob, date, description, gpsCoords);
    await downloadBlob(stampedBlob, savePath);
    return { ok: true, result: "approve" };
  }

  // ---- 3. Load image for face detection ----
  const { img, blobUrl } = await arrayBufferToImage(buffer);

  let detectionResult = null;
  let useFallback = false;
  try {
    await ensureModels();

    // If models are unavailable (human.js missing or failed to load), fall back
    // to "approve every image" mode — same behaviour as when no encodings are
    // configured.  This matches the README promise: "Without these files, all
    // photos pass through without face filtering."
    if (!modelsLoaded || !human) {
      useFallback = true;
    } else {
      detectionResult = await human.detect(img);
    }
  } finally {
    // Revoke the object URL; we still hold `img` and `buffer` refs for now
    URL.revokeObjectURL(blobUrl);
  }

  if (useFallback) {
    const srcBlob     = new Blob([buffer], { type: "image/jpeg" });
    const date        = storyData.createdAt ? new Date(storyData.createdAt) : null;
    const stampedBlob = await applyExif(srcBlob, date, description, gpsCoords);
    await downloadBlob(stampedBlob, savePath);
    return { ok: true, result: "approve" };
  }

  const faces = detectionResult?.face ?? [];

  if (faces.length === 0) {
    return { ok: true, result: "reject" };
  }

  // ---- 4. Match faces against all known child descriptors ----
  let bestPct        = 0;
  let bestFace       = null;
  let bestDescriptor = null;
  let bestChildId    = null;
  let bestChildName  = null;
  const matchedNames = new Set();

  const effectiveEncodings = mergeWithLocalProfiles(childEncodings);

  for (const face of faces) {
    const embedding = face.embedding;
    if (!embedding) continue;

    for (const enc of effectiveEncodings) {
      const pct = bestMatchPercent(embedding, enc.descriptors);
      if (pct >= minThreshold) matchedNames.add(enc.childName);
      if (pct > bestPct) {
        bestPct        = pct;
        bestFace       = face;
        bestDescriptor = Array.from(embedding);
        bestChildId    = enc.childId;
        bestChildName  = enc.childName;
      }
    }
  }

  // ---- 5. Decision ----
  if (bestPct < minThreshold) {
    return { ok: true, result: "reject" };
  }

  if (bestPct >= autoThreshold) {
    // Auto-approve: stamp EXIF and download
    const srcBlob    = new Blob([buffer], { type: "image/jpeg" });
    const date       = storyData.createdAt ? new Date(storyData.createdAt) : null;
    const stampedBlob = await applyExif(srcBlob, date, description, gpsCoords);
    await downloadBlob(stampedBlob, savePath);

    // Continuous learning: persist the confirmed descriptor so future scans
    // are more accurate.  Also update the in-memory cache so subsequent
    // images in this batch benefit immediately.
    // bestChildName is always set when bestChildId is set (both are updated
    // together in the matching loop), but fall back to the message childName
    // for safety.
    if (bestDescriptor && bestChildId) {
      const learnName = bestChildName ?? childName;
      await appendDescriptor(bestChildId, learnName, bestDescriptor)
        .catch((err) => console.warn("[offscreen] appendDescriptor failed:", err));
      const cached = _localProfiles.get(bestChildId);
      const descs  = cached ? [...cached.descriptors, bestDescriptor] : [bestDescriptor];
      if (descs.length > MAX_DESCRIPTORS_PER_CHILD) {
        descs.splice(0, descs.length - MAX_DESCRIPTORS_PER_CHILD);
      }
      _localProfiles.set(bestChildId, { childId: bestChildId, childName: learnName, descriptors: descs });
    }

    return { ok: true, result: "approve" };
  }

  // Review queue: crop the best face, store in IndexedDB
  const box              = bestFace.box ?? null; // [x, y, width, height]
  const croppedFaceDataUrl = box ? cropFaceToDataUrl(img, box) : null;

  // Build allFaces array for the multi-face selector in the popup UI.
  // Include every detected face that has an embedding so the user can
  // pick the correct face when more than one person appears in the photo.
  const allFacesDescriptors = effectiveEncodings.flatMap((e) => e.descriptors);
  const allFacesData = faces
    .filter((f) => f.embedding)
    .map((f) => ({
      descriptor:     Array.from(f.embedding),
      croppedDataUrl: f.box ? cropFaceToDataUrl(img, f.box) : null,
      matchPct:       bestMatchPercent(f.embedding, allFacesDescriptors),
    }));

  await addToReviewQueue({
    croppedFaceDataUrl,
    descriptor:      bestDescriptor,
    allFaces:        allFacesData.length > 1 ? allFacesData : undefined,
    storyData,
    description,
    childId:         bestChildId || childId,
    childName:       bestChildName || childName,
    savePath,
    matchPct:        bestPct,
    matchedChildren: [...matchedNames].sort(),
  });

  return { ok: true, result: "review", matchPct: bestPct };
}

/* ================================================================== */
/*  Download approved review item                                      */
/* ================================================================== */

/**
 * Re-fetch the original image, stamp EXIF, and download locally.
 * Called by the background's REVIEW_APPROVE handler.
 */
async function downloadApproved(msg) {
  const { storyData, description, savePath, gpsCoords = null } = msg;

  const res = await fetch(storyData.originalUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${storyData.originalUrl}`);
  const buffer = await res.arrayBuffer();

  const srcBlob    = new Blob([buffer], { type: "image/jpeg" });
  const date       = storyData.createdAt ? new Date(storyData.createdAt) : null;
  const stampedBlob = await applyExif(srcBlob, date, description, gpsCoords);
  await downloadBlob(stampedBlob, savePath);
}

/* ================================================================== */
/*  Message router                                                     */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === "PROCESS_IMAGE") {
    processImage(msg)
      .then((result) => sendResponse(result))
      .catch((err)   => sendResponse({ result: "reject", error: err.message }));
    return true;
  }

  if (msg.type === "DOWNLOAD_APPROVED") {
    downloadApproved(msg)
      .then(()    => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "BUILD_ENCODING") {
    buildDescriptorFromDataUrl(msg.imageDataUrl, msg.faceIndex ?? 0)
      .then((descriptor) => sendResponse({ ok: true, descriptor }))
      .catch((err)       => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "REFRESH_PROFILES") {
    getAllDescriptors()
      .then((records) => {
        _localProfiles.clear();
        for (const r of records) {
          _localProfiles.set(r.childId, r);
        }
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

/* ================================================================== */
/*  BUILD_ENCODING – used by options.html training preview            */
/* ================================================================== */

async function buildDescriptorFromDataUrl(imageDataUrl, faceIndex = 0) {
  await ensureModels();
  if (!modelsLoaded || !human) {
    throw new Error(
      "human.js or face models are not available. Run `npm run setup` first."
    );
  }
  const img    = await dataUrlToImage(imageDataUrl);
  const result = await human.detect(img);
  const embed  = result.face?.[faceIndex]?.embedding;
  return embed ? Array.from(embed) : null;
}
