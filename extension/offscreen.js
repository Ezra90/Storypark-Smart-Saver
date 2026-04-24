/**
 * offscreen.js – Image processing worker (offscreen document).
 *
 * Loaded as a module inside offscreen.html, which grants access to
 * Canvas, Blob, URL.createObjectURL, and FileReader (for data URL conversion).
 * NOTE: chrome.downloads is NOT available in offscreen documents — all
 * download triggers happen in the service worker (background.js).
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
 *   IN  { type: "DOWNLOAD_VIDEO", videoUrl, savePath }
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

import { applyExif, readExif }                from "./lib/exif.js";
import { addToReviewQueue, appendDescriptor,
         getAllDescriptors }                   from "./lib/db.js";
// computeCentroid and buildCentroids are pure math — imported from matching.js to avoid duplication.
// NOTE: similarityPct, topKVoting, enhancedMatch remain local because they use
//       human.match.similarity() (Human AI model) when available, which is more
//       accurate than pure cosine similarity.  The matching.js versions use cosine only.
import { computeCentroid, buildCentroids } from "./lib/matching.js";
// Story Card Canvas renderer extracted to offscreen-card.js for AI manageability.
// The import is commented out until the local createStoryCard() is removed below.
// TODO: Remove local createStoryCard() + helpers, then uncomment this import:
// import { renderStoryCard } from "./offscreen-card.js";
// Handler will then call: renderStoryCard(msg, applyExif, blobToDataUrl)

/* global Human */

/* ================================================================== */
/*  @vladmandic/human setup                                            */
/* ================================================================== */

const HUMAN_CONFIG = {
  modelBasePath: chrome.runtime.getURL("models/"),
  // Force WebGL backend to avoid WebGPU initialisation errors in extension
  // offscreen documents (WebGPU may not be fully available in that context).
  backend: "webgl",
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
const MAX_DESCRIPTORS_PER_CHILD = 1000;

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
/*  Face matching — Enhanced pipeline                                  */
/*                                                                     */
/*  Techniques used for improved accuracy with similar-looking young   */
/*  children (babies/toddlers in daycare):                             */
/*                                                                     */
/*  1. Centroid matching — average descriptors per time period to       */
/*     reduce noise from blurry/angled photos                          */
/*  2. Top-K voting — consensus from top 5 closest descriptors         */
/*  3. Margin-based negative scoring — contrastive learning that       */
/*     penalises matches close to "not my child" profiles              */
/*  4. Adaptive threshold support — per-child threshold based on       */
/*     their typical match distribution                                */
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
 * Compute similarity percentage between two descriptors.
 * @returns {number} 0–100
 */
function similarityPct(a, b) {
  const arrA = Array.isArray(a) ? a : Array.from(a);
  const arrB = Array.isArray(b) ? b : Array.from(b);
  const sim = (human && human.match)
    ? human.match.similarity(arrA, arrB)
    : cosineSimilarity(arrA, arrB);
  return Math.max(0, Math.round(sim * 100));
}

/**
 * Return the best match percentage (0–100) between an embedding and a
 * set of stored descriptors.
 *
 * @param {number[]|Float32Array} embedding
 * @param {number[][]}            descriptors
 * @returns {number}
 */
function bestMatchPercent(embedding, descriptors) {
  if (!descriptors || descriptors.length === 0) return 0;
  let best = 0;
  for (const desc of descriptors) {
    const pct = similarityPct(embedding, desc);
    if (pct > best) best = pct;
  }
  return best;
}

/**
 * Top-K voting: check the K closest descriptors and return the fraction
 * that belong to the target child.  A high fraction means strong consensus.
 *
 * @param {number[]|Float32Array} embedding
 * @param {number[][]} descriptors  — target child's descriptors
 * @param {number[][]} negativeDescriptors — "not my child" descriptors
 * @param {number} k — number of nearest neighbours to consider
 * @returns {{ consensus: number, topKPositive: number, topKNegative: number }}
 *   consensus: 0.0–1.0 (fraction of top-K that are positive matches)
 */
function topKVoting(embedding, descriptors, negativeDescriptors, k = 5) {
  const scored = [];
  for (const desc of descriptors) {
    scored.push({ pct: similarityPct(embedding, desc), type: "pos" });
  }
  for (const desc of negativeDescriptors) {
    scored.push({ pct: similarityPct(embedding, desc), type: "neg" });
  }
  // Sort descending by match percentage
  scored.sort((a, b) => b.pct - a.pct);
  const topK = scored.slice(0, k);
  if (topK.length === 0) return { consensus: 0, topKPositive: 0, topKNegative: 0 };
  const posCount = topK.filter((s) => s.type === "pos").length;
  const negCount = topK.filter((s) => s.type === "neg").length;
  return {
    consensus: posCount / topK.length,
    topKPositive: posCount,
    topKNegative: negCount,
  };
}

/**
 * Enhanced face matching: combines centroid matching, individual descriptor
 * matching, top-K voting, and margin-based negative scoring.
 *
 * Returns an effective score (0–100) that accounts for all factors.
 *
 * @param {number[]} embedding — face embedding to evaluate
 * @param {number[][]} positiveDescriptors — target child's descriptors
 * @param {number[][]} negativeDescriptors — "not my child" descriptors
 * @param {number[][]} centroids — pre-computed centroid vectors
 * @returns {{ effectiveScore: number, rawPositive: number, rawNegative: number,
 *             centroidScore: number, consensus: number, margin: number }}
 */
function enhancedMatch(embedding, positiveDescriptors, negativeDescriptors, centroids) {
  // 1. Raw positive match (best individual descriptor)
  const rawPositive = bestMatchPercent(embedding, positiveDescriptors);

  // 2. Centroid match (more stable, less noisy)
  const centroidScore = centroids.length > 0
    ? bestMatchPercent(embedding, centroids)
    : rawPositive; // fallback to raw if no centroids

  // 3. Raw negative match
  const rawNegative = bestMatchPercent(embedding, negativeDescriptors);

  // 4. Top-K voting (consensus among nearest neighbours)
  const { consensus } = (positiveDescriptors.length + negativeDescriptors.length >= 5)
    ? topKVoting(embedding, positiveDescriptors, negativeDescriptors, 5)
    : { consensus: 1.0 }; // not enough data for voting, assume positive

  // 5. Margin-based negative penalty
  // The closer the negative match is to the positive match, the higher the penalty.
  // Formula: penalty = negativePct * weight, where weight scales with proximity.
  //   - If negative is far below positive (e.g. 40% vs 88%): minimal penalty
  //   - If negative is close to positive (e.g. 85% vs 88%): heavy penalty
  const NEGATIVE_WEIGHT = 0.6; // base weight for negative contrastive scoring
  const negativePenalty = rawNegative > 0
    ? rawNegative * NEGATIVE_WEIGHT
    : 0;

  // 6. Consensus penalty: if top-K voting shows weak consensus, reduce score
  // consensus = 1.0 means all top-5 are positive, 0.0 means all negative
  const consensusFactor = 0.5 + (consensus * 0.5); // ranges 0.5 (no consensus) to 1.0 (full)

  // 7. Combine: use the better of raw and centroid, apply penalties
  const baseScore = Math.max(rawPositive, centroidScore);
  const margin = baseScore - negativePenalty;
  const effectiveScore = Math.max(0, Math.round(margin * consensusFactor));

  return {
    effectiveScore,
    rawPositive,
    rawNegative,
    centroidScore,
    consensus,
    margin,
  };
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
/*  Full photo thumbnail helper                                        */
/* ================================================================== */

/**
 * Generate a resized thumbnail of the full photo for display in the
 * review queue.  Max width 400px, JPEG at 75% quality (~30-60KB).
 *
 * @param {HTMLImageElement} img
 * @returns {string} data URL
 */
function makeFullThumbnail(img) {
  const MAX_W = 400;
  const scale = img.naturalWidth > MAX_W ? MAX_W / img.naturalWidth : 1;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.75);
}

/* ================================================================== */
/*  Blob → data URL helper                                             */
/* ================================================================== */

/**
 * Convert a Blob to a base64 data URL string.
 * The data URL is returned to the service worker which then calls
 * chrome.downloads.download() — offscreen documents do NOT have access
 * to the chrome.downloads API in Manifest V3.
 *
 * @param {Blob} blob
 * @returns {Promise<string>} data URL (e.g. "data:image/jpeg;base64,...")
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to convert blob to data URL"));
    reader.readAsDataURL(blob);
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
    negativeDescriptors = [],
    autoThreshold  = 85,
    minThreshold   = 50,
    gpsCoords      = null,
  } = msg;

  // ---- 1. Fetch image ----
  const res = await fetch(imageUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${imageUrl}`);
  const buffer = await res.arrayBuffer();

  // Determine the actual content type so we don't write EXIF into non-JPEG blobs.
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const isJpeg = contentType.includes("jpeg") || contentType.includes("jpg");

  // Helper: build a stamped blob, skipping EXIF for non-JPEG media.
  const makeStampedBlob = async (date) => {
    const srcBlob = new Blob([buffer], { type: contentType });
    return isJpeg ? applyExif(srcBlob, date, description, gpsCoords, {
      exifTitle:    msg.exifTitle    || "",
      exifSubject:  msg.exifSubject  || "",
      exifComments: msg.exifComments || "",
      exifArtist:   msg.exifArtist   || "",
      iptcCaption:  msg.iptcCaption  || "",
      iptcKeywords: msg.iptcKeywords || [],
      iptcByline:   msg.iptcByline   || "",
    }) : srcBlob;
  };

  // ---- 2. No training encodings: bootstrap mode ----
  // When no face descriptors are stored for this child yet, attempt face
  // detection (if models are available).  Photos with no detected face are
  // downloaded immediately.  Photos that do contain a face are queued for
  // the parent to review — each approval both downloads the photo AND adds
  // the face embedding as the first training data for this child, letting
  // the parent build the facial profile organically through the review queue
  // instead of requiring a manual photo-upload step first.
  if (childEncodings.length === 0) {
    await ensureModels();

    // If face recognition models are unavailable, preserve the existing
    // "download everything" fallback behaviour.
    if (!modelsLoaded || !human) {
      const date        = storyData.createdAt ? new Date(storyData.createdAt) : null;
      const stampedBlob = await makeStampedBlob(date);
      const dataUrl     = await blobToDataUrl(stampedBlob);
      return { ok: true, result: "approve", dataUrl, savePath, detectedFaces: [] };
    }

    // Run face detection on a temporary image element.
    const { img: bImg, blobUrl: bBlobUrl } = await arrayBufferToImage(buffer);
    let bootstrapFaces = [];
    try {
      const detected = await human.detect(bImg);
      bootstrapFaces = detected?.face ?? [];
    } finally {
      URL.revokeObjectURL(bBlobUrl);
    }

    // No face in this photo — queue for review (activity photo) so the parent
    // can decide. During Phase 1&2 we want NO auto-approvals at all; every
    // photo should go through human review to build the face profile.
    if (bootstrapFaces.length === 0) {
      const fullThumbBoot = makeFullThumbnail(bImg);
      await addToReviewQueue({
        childId,
        childName,
        fullPhotoDataUrl: fullThumbBoot,
        storyData,
        description,
        savePath,
        matchPct:       0,
        noFace:         true,
        noTrainingData: true,
        descriptor:     null,
      });
      return { ok: true, result: "review", matchPct: 0, noFace: true, detectedFaces: [] };
    }

    // One or more faces detected → queue for parent confirmation.
    // The parent's first approval also writes the descriptor to IndexedDB,
    // bootstrapping the facial profile for future scans.
    const bestBFace       = bootstrapFaces[0];
    const bestBDescriptor = bestBFace.embedding ? Array.from(bestBFace.embedding) : null;
    const croppedBUrl     = bestBFace.box
      ? cropFaceToDataUrl(bImg, bestBFace.box)
      : null;

    const allBFaces = bootstrapFaces
      .filter((f) => f.embedding)
      .map((f) => ({
        descriptor:     Array.from(f.embedding),
        croppedDataUrl: f.box ? cropFaceToDataUrl(bImg, f.box) : null,
        matchPct:       null,
      }));

    const fullThumbB = makeFullThumbnail(bImg);

    await addToReviewQueue({
      croppedFaceDataUrl: croppedBUrl,
      fullPhotoDataUrl:   fullThumbB,
      descriptor:         bestBDescriptor,
      allFaces:           allBFaces.length > 1 ? allBFaces : undefined,
      storyData,
      description,
      childId,
      childName,
      savePath,
      matchPct:        0,
      matchedChildren: [childName],
      noTrainingData:  true,
    });

    return { ok: true, result: "review", matchPct: 0, noTrainingData: true,
      detectedFaces: bootstrapFaces.filter(f => f.embedding).map(f => ({ descriptor: Array.from(f.embedding) })) };
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
    const date        = storyData.createdAt ? new Date(storyData.createdAt) : null;
    const stampedBlob = await makeStampedBlob(date);
    const dataUrl     = await blobToDataUrl(stampedBlob);
    return { ok: true, result: "approve", dataUrl, savePath, detectedFaces: [] };
  }

  const faces = detectionResult?.face ?? [];

  // Collect face descriptors for fingerprint caching (avoids re-downloading on re-scans)
  const detectedFaces = faces
    .filter(f => f.embedding)
    .map(f => ({ descriptor: Array.from(f.embedding) }));

  if (faces.length === 0) {
    // No face detected — this may be an activity photo (artwork, group scene,
    // etc.) rather than a portrait.  Queue it for manual review so the user
    // can decide whether to keep it.  The "noFace" flag tells the review UI
    // to show a "Keep / Skip" button pair instead of the face-training flow.
    const fullThumbNF = makeFullThumbnail(img);

    await addToReviewQueue({
      childId,
      childName,
      fullPhotoDataUrl: fullThumbNF,
      storyData,
      description,
      exifTitle:    msg.exifTitle    || "",
      exifSubject:  msg.exifSubject  || "",
      exifComments: msg.exifComments || "",
      savePath,
      matchPct:       0,
      noFace:         true,
      noTrainingData: false,
      descriptor:     null,
    });
    return { ok: true, result: "review", matchPct: 0, noFace: true, detectedFaces: [] };
  }

  // ---- 4. Match faces against all known child descriptors ----
  // Uses enhanced matching pipeline: centroid matching, top-K voting,
  // margin-based negative scoring for improved accuracy with similar-
  // looking young children.
  let bestPct        = 0;
  let bestFace       = null;
  let bestDescriptor = null;
  let bestChildId    = null;
  let bestChildName  = null;
  let bestEffective  = 0; // enhanced effective score
  let bestMatchData  = null; // full enhanced match result
  const matchedNames = new Set();

  const effectiveEncodings = mergeWithLocalProfiles(childEncodings);

  // Pre-compute centroids from year-bucketed descriptors for each child
  const childCentroids = new Map();
  for (const enc of effectiveEncodings) {
    const centroids = buildCentroids(enc.descriptorsByYear || {});
    // If no year buckets, compute a single centroid from all descriptors
    if (centroids.length === 0 && enc.descriptors.length >= 3) {
      const singleCentroid = computeCentroid(enc.descriptors);
      if (singleCentroid) centroids.push(singleCentroid);
    }
    childCentroids.set(enc.childId, centroids);
  }

  for (const face of faces) {
    const embedding = face.embedding;
    if (!embedding) continue;

    for (const enc of effectiveEncodings) {
      const centroids = childCentroids.get(enc.childId) || [];
      const matchData = enhancedMatch(
        embedding,
        enc.descriptors,
        negativeDescriptors,
        centroids,
      );

      if (matchData.rawPositive >= minThreshold) matchedNames.add(enc.childName);
      if (matchData.effectiveScore > bestEffective) {
        bestEffective  = matchData.effectiveScore;
        bestPct        = matchData.rawPositive;
        bestFace       = face;
        bestDescriptor = Array.from(embedding);
        bestChildId    = enc.childId;
        bestChildName  = enc.childName;
        bestMatchData  = matchData;
      }
    }
  }

  // ---- 5. Decision (enhanced contrastive matching) ----
  const negativePct = bestMatchData?.rawNegative ?? 0;

  // Reject if raw positive is below minimum threshold
  if (bestPct < minThreshold) {
    return { ok: true, result: "reject", detectedFaces };
  }

  // Enhanced negative override: use effective score (margin-based + consensus)
  // to catch similar-looking kids. If effective score drops below minThreshold
  // due to high negative match, demote to review.
  if (bestMatchData && bestEffective < minThreshold && bestPct >= minThreshold) {
    const box              = bestFace?.box ?? null;
    const croppedFaceDataUrl = box ? cropFaceToDataUrl(img, box) : null;
    const allFacesDescriptors = effectiveEncodings.flatMap((e) => e.descriptors);
    const allFacesData = faces
      .filter((f) => f.embedding)
      .map((f) => ({
        descriptor:     Array.from(f.embedding),
        croppedDataUrl: f.box ? cropFaceToDataUrl(img, f.box) : null,
        matchPct:       bestMatchPercent(f.embedding, allFacesDescriptors),
      }));

    const fullThumbNeg = makeFullThumbnail(img);

    await addToReviewQueue({
      croppedFaceDataUrl,
      fullPhotoDataUrl: fullThumbNeg,
      descriptor:      bestDescriptor,
      allFaces:        allFacesData.length > 1 ? allFacesData : undefined,
      storyData,
      description,
      exifTitle:       msg.exifTitle    || "",
      exifSubject:     msg.exifSubject  || "",
      exifComments:    msg.exifComments || "",
      childId:         bestChildId || childId,
      childName:       bestChildName || childName,
      savePath,
      matchPct:        bestPct,
      effectiveScore:  bestEffective,
      negativePct,
      consensus:       bestMatchData.consensus,
      matchedChildren: [...matchedNames].sort(),
      negativeOverride: true,
    });

    return { ok: true, result: "review", matchPct: bestPct, effectiveScore: bestEffective, negativePct, negativeOverride: true, detectedFaces };
  }

  // Use effective score for auto-approve decision (not raw positive)
  // This ensures high negative matches prevent auto-approval even when
  // raw positive looks good (common with similar-looking babies).
  if (bestEffective >= autoThreshold) {
    // Auto-approve: stamp EXIF and return data URL for background to download
    const date        = storyData.createdAt ? new Date(storyData.createdAt) : null;
    const stampedBlob = await makeStampedBlob(date);
    const dataUrl     = await blobToDataUrl(stampedBlob);

    // Continuous learning: persist the confirmed descriptor so future scans
    // are more accurate.  Also update the in-memory cache so subsequent
    // images in this batch benefit immediately.
    if (bestDescriptor && bestChildId) {
      const learnName = bestChildName ?? childName;
      const learnDate = storyData.createdAt ? new Date(storyData.createdAt) : null;
      const year = learnDate ? learnDate.getFullYear().toString() : "unknown";
      await appendDescriptor(bestChildId, learnName, bestDescriptor, year)
        .catch((err) => console.warn("[offscreen] appendDescriptor failed:", err));
      const cached = _localProfiles.get(bestChildId);
      const descs  = cached ? [...cached.descriptors, bestDescriptor] : [bestDescriptor];
      if (descs.length > MAX_DESCRIPTORS_PER_CHILD) {
        descs.splice(0, descs.length - MAX_DESCRIPTORS_PER_CHILD);
      }
      _localProfiles.set(bestChildId, { childId: bestChildId, childName: learnName, descriptors: descs });
    }

    return { ok: true, result: "approve", dataUrl, savePath, detectedFaces };
  }

  // Review queue: create a SEPARATE review item for EACH detected face.
  // This lets the user verify/reject each person individually, which is
  // critical during early phases when building the face profile.
  const allFacesDescriptors = effectiveEncodings.flatMap((e) => e.descriptors);
  const facesWithEmbed = faces.filter((f) => f.embedding);
  const fullThumb = makeFullThumbnail(img);

  if (facesWithEmbed.length > 1) {
    // Multi-face photo: one review item per face
    for (let fi = 0; fi < facesWithEmbed.length; fi++) {
      const face = facesWithEmbed[fi];
      const faceDesc = Array.from(face.embedding);
      const faceCrop = face.box ? cropFaceToDataUrl(img, face.box) : null;
      const facePct  = bestMatchPercent(face.embedding, allFacesDescriptors);

      await addToReviewQueue({
        croppedFaceDataUrl: faceCrop,
        fullPhotoDataUrl:   fullThumb,
        descriptor:         faceDesc,
        storyData,
        description,
        exifTitle:       msg.exifTitle    || "",
        exifSubject:     msg.exifSubject  || "",
        exifComments:    msg.exifComments || "",
        childId:         bestChildId || childId,
        childName:       bestChildName || childName,
        savePath,
        matchPct:        facePct,
        matchedChildren: [...matchedNames].sort(),
        faceIndex:       fi,
        totalFaces:      facesWithEmbed.length,
      });
    }
  } else {
    // Single face: one review item (original behaviour)
    const box = bestFace.box ?? null;
    const croppedFaceDataUrl = box ? cropFaceToDataUrl(img, box) : null;

    await addToReviewQueue({
      croppedFaceDataUrl,
      fullPhotoDataUrl: fullThumb,
      descriptor:      bestDescriptor,
      storyData,
      description,
      exifTitle:       msg.exifTitle    || "",
      exifSubject:     msg.exifSubject  || "",
      exifComments:    msg.exifComments || "",
      childId:         bestChildId || childId,
      childName:       bestChildName || childName,
      savePath,
      matchPct:        bestPct,
      matchedChildren: [...matchedNames].sort(),
    });
  }

  return { ok: true, result: "review", matchPct: bestPct, detectedFaces };
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

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const isJpeg      = contentType.includes("jpeg") || contentType.includes("jpg");
  const srcBlob     = new Blob([buffer], { type: contentType });
  const date        = storyData.createdAt ? new Date(storyData.createdAt) : null;
  const stampedBlob = isJpeg
    ? await applyExif(srcBlob, date, description, gpsCoords, {
        exifTitle:    msg.exifTitle    || "",
        exifSubject:  msg.exifSubject  || "",
        exifComments: msg.exifComments || "",
        exifArtist:   msg.exifArtist   || "",
        iptcCaption:  msg.iptcCaption  || "",
        iptcKeywords: msg.iptcKeywords || [],
        iptcByline:   msg.iptcByline   || "",
      })
    : srcBlob;
  const dataUrl = await blobToDataUrl(stampedBlob);
  return { dataUrl, savePath };
}

/* ================================================================== */
/*  Download video directly (no face detection, no EXIF)              */
/* ================================================================== */

/**
 * Create a blob URL from binary data (base64 decoded).
 * The blob URL will be used for chrome.downloads.download() in the service worker,
 * and revoked by the service worker once the download completes.
 *
 * Message protocol:
 *   IN  { type: "CREATE_BLOB_URL", dataUrl }
 *   OUT { ok: true, blobUrl: string, blobId: string } | { ok: false, error: string }
 *
 * The blobId is used to track and revoke the blob URL later.
 */
const _managedBlobUrls = new Map(); // blobId → blobUrl

function createBlobUrl(dataUrl) {
  try {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx < 0) throw new Error("Invalid data URL");
    const header   = dataUrl.substring(0, commaIdx);
    const mimeMatch = /data:([^;]+)/.exec(header);
    const mime     = mimeMatch ? mimeMatch[1] : "application/octet-stream";
    const isBase64 = header.includes(";base64");
    const payload  = dataUrl.substring(commaIdx + 1);
    let bytes;
    if (isBase64) {
      const bin  = atob(payload);
      const len  = bin.length;
      bytes  = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    const blob = new Blob([bytes], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    const blobId = Math.random().toString(36).slice(2);
    _managedBlobUrls.set(blobId, blobUrl);
    return { ok: true, blobUrl, blobId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function revokeBlobUrl(blobId) {
  const blobUrl = _managedBlobUrls.get(blobId);
  if (blobUrl) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
    _managedBlobUrls.delete(blobId);
  }
}

/**
 * Fetch a video URL and return a managed blob URL that the service worker
 * can hand directly to chrome.downloads.download().
 *
 * Memory-safe path (OOM fix, v2.2.x):
 *   - res.blob() streams the response body into a single Blob — no
 *     intermediate ArrayBuffer copy.
 *   - We NEVER convert to a base64 data URL. For a 120 MB video that would
 *     inflate RAM by ~1.3× (base64 overhead) AND hit the ~64 MB
 *     chrome.runtime messaging limit, silently corrupting large videos.
 *   - We return a blob URL + blobId; the service worker enqueues the
 *     download, and the centralised chrome.downloads.onChanged listener
 *     revokes the blob URL as soon as the write completes (or fails).
 *   - Network errors propagate; the caller is expected to retry.
 *
 * Message protocol:
 *   IN  { type: "DOWNLOAD_VIDEO", videoUrl, savePath }
 *   OUT { ok: true, blobUrl, blobId, savePath, size, contentType }
 *       | { ok: false, error: string }
 *
 * @param {{ videoUrl: string, savePath: string }} msg
 */
/**
 * v2.4 (7D): Per-video download with streaming progress + single retry on
 * network error.  Broadcasts VIDEO_DOWNLOAD_PROGRESS messages every ~2 s so
 * the dashboard / activity log can show "⬇ 45% of 120 MB".
 *
 * Progress broadcast shape:
 *   { type: "VIDEO_DOWNLOAD_PROGRESS", videoUrl, savePath,
 *     receivedBytes, totalBytes, percent, mb }
 */
async function downloadVideo(msg) {
  const { videoUrl, savePath } = msg;

  // Attempt with a single retry on network error. The retry uses a fresh fetch
  // so mid-stream failures don't corrupt the blob.  Cloudflare/Storypark 403/404
  // responses propagate (caller logs + skips) — we only retry on TypeError /
  // ECONNRESET style failures that indicate a flaky network.
  // Add Range header: video CDNs require it to serve streams correctly.
  // Without it, some CDNs return 403 even with valid session cookies.
  // Accept 200 (full) and 206 (partial content — range response) as success.
  const _tryFetch = async () => fetch(videoUrl, {
    credentials: "include",
    headers: { "Range": "bytes=0-" },
  });

  let res;
  try {
    res = await _tryFetch();
  } catch (netErr) {
    // Retry once after a short delay
    await new Promise(r => setTimeout(r, 1500));
    res = await _tryFetch();
  }

  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`Video fetch ${res.status}: ${videoUrl}`);
  }

  const contentType = res.headers.get("content-type") || "video/mp4";
  const totalBytes  = parseInt(res.headers.get("content-length") || "0", 10) || 0;

  // Prefer streaming reader for progress reporting.  Fall back to res.blob()
  // when the response body is not a readable stream (some older browsers /
  // test harnesses).  Both paths produce the same final Blob.
  let blob;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    let lastBroadcastAt = 0;

    // Broadcast shape: { type, videoUrl, savePath, receivedBytes, totalBytes, percent, mb }
    const _broadcast = (force = false) => {
      const now = Date.now();
      if (!force && now - lastBroadcastAt < 2000) return; // throttle to ~2 s
      lastBroadcastAt = now;
      const mb = (received / 1048576).toFixed(1);
      const percent = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : null;
      try {
        chrome.runtime.sendMessage({
          type: "VIDEO_DOWNLOAD_PROGRESS",
          videoUrl, savePath,
          receivedBytes: received, totalBytes,
          percent, mb: Number(mb),
        }).catch(() => {});
      } catch { /* fire-and-forget; never block the download */ }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      _broadcast();
    }
    _broadcast(true); // final 100%

    blob = new Blob(chunks, { type: contentType });
  } else {
    // Fallback path — no per-chunk progress available
    blob = await res.blob();
  }

  const typedBlob = blob.type === contentType ? blob : new Blob([blob], { type: contentType });
  const blobUrl = URL.createObjectURL(typedBlob);
  const blobId  = Math.random().toString(36).slice(2);
  _managedBlobUrls.set(blobId, blobUrl);

  return {
    blobUrl,
    blobId,
    savePath,
    size: typedBlob.size,
    contentType,
  };
}


/* ================================================================== */
/*  Story Card helpers — all in offscreen-card.js                     */
/* ================================================================== */
// All Canvas helpers (stripHtmlForCard, wrapTextToLines, drawWrappedText,
// measureWrappedTextHeight, formatCardDate) and createStoryCard() have been
// extracted to offscreen-card.js.  The imported createStoryCard() is called
// with applyExif + blobToDataUrl as callbacks so it has no circular deps.
//
// GENERATE_STORY_CARD handler calls:
//   createStoryCard(msg, applyExif, blobToDataUrl)

// All Canvas helpers and createStoryCard() are in offscreen-card.js (imported above).
// Handler calls: createStoryCard(msg, applyExif, blobToDataUrl)

// Canvas helpers below are used by the local createStoryCard() above.
// TODO next session: remove these + createStoryCard() and uncomment the
// offscreen-card.js import at top of file.

/** Strip HTML tags for Canvas rendering. */
function stripHtmlForCard(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Word-wrap text to lines that fit maxWidth pixels. */
function wrapTextToLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) { lines.push(""); continue; }
    const words = para.split(" ");
    let cur = "";
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

/**
 * Draw wrapped text starting at baseline y; returns y after the last line.
 */
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
  for (const line of wrapTextToLines(ctx, text, maxWidth)) {
    if (line) ctx.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

/**
 * Measure pixel height of a wrapped text block without drawing.
 */
function measureWrappedTextHeight(ctx, text, maxWidth, lineHeight) {
  return wrapTextToLines(ctx, text, maxWidth).length * lineHeight;
}

/**
 * Format a YYYY-MM-DD date string to "D Month YYYY".
 */
function formatCardDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length < 3) return dateStr;
  const MONTHS = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  const d = parseInt(parts[2], 10);
  const m = parseInt(parts[1], 10) - 1;
  return `${d} ${MONTHS[m] || ""} ${parts[0]}`;
}

/* ================================================================== */
/*  Story Card renderer – canvas → JPEG with EXIF                     */
/* ================================================================== */

/**
 * Render a Story Card image (1200 × variable px) and return a JPEG data URL
 * with EXIF + IPTC metadata applied.
 *
 * Layout (top → bottom):
 *   HEADER (130px) — teal bar: date + child name left, centre + room right
 *   TITLE           — bold wrapped text
 *   ─── divider ───
 *   BODY            — full educator text, no truncation
 *   ROUTINE         — "🌟 Daily Routine" header + content (if present)
 *   ─── divider ───
 *   FOOTER (90px)   — educator name, photo count, branding
 */
async function createStoryCard(msg) {
  const {
    title        = "",
    date         = "",
    body         = "",
    centreName   = "",
    roomName     = "",
    educatorName = "",
    childName    = "",
    childAge     = "",
    routineText  = "",
    photoCount   = 0,
    gpsCoords    = null,
    exifArtist   = "",
    iptcCaption  = "",
    iptcKeywords = [],
    iptcByline   = "",
  } = msg;

  const CARD_W  = 1200;
  const PAD     = 110;  // generous padding — prevents text touching edges on all sides
  const TEXT_W  = CARD_W - PAD * 2;
  const HDR_H   = 150;  // taller header for breathing room
  const FTR_H   = 200;  // extra footer space — full attribution without cramping
  const GAP     = 40;   // larger gap between sections for readability


  const TITLE_SIZE   = 46;
  const TITLE_LINE_H = TITLE_SIZE * 1.3;
  const BODY_SIZE    = 22;
  const BODY_LINE_H  = BODY_SIZE * 1.65;
  const ROU_SIZE     = 20;
  const ROU_LINE_H   = ROU_SIZE * 1.6;

  const plainTitle   = stripHtmlForCard(title);
  const plainBody    = stripHtmlForCard(body);
  const plainRoutine = stripHtmlForCard(routineText);
  const fmtDate      = formatCardDate(date);

  // Measure section heights using a throw-away canvas
  const tmp   = document.createElement("canvas");
  tmp.width   = CARD_W;
  tmp.height  = 100;
  const mctx  = tmp.getContext("2d");

  mctx.font = `bold ${TITLE_SIZE}px "Segoe UI", Arial, sans-serif`;
  const titleH = measureWrappedTextHeight(mctx, plainTitle, TEXT_W, TITLE_LINE_H);

  mctx.font = `${BODY_SIZE}px "Segoe UI", Arial, sans-serif`;
  const bodyH = plainBody ? measureWrappedTextHeight(mctx, plainBody, TEXT_W, BODY_LINE_H) : 0;

  mctx.font = `${ROU_SIZE}px "Segoe UI", Arial, sans-serif`;
  const rouBodyH = plainRoutine ? measureWrappedTextHeight(mctx, plainRoutine, TEXT_W, ROU_LINE_H) : 0;
  // Routine section overhead (when present):
  //   top-divider(2) + gap(14) + header-block(50) + pre-text-offset(20)
  //   + gap-before-bottom(14) + bottom-divider(2) + GAP-after(32) = 134px
  const routineH = plainRoutine ? (rouBodyH + 134) : 0;

  const totalH = HDR_H
    + PAD + titleH
    + GAP + 2 + GAP                        // body divider
    + (bodyH ? bodyH + GAP : 0)
    + routineH                             // routine section (trailing GAP included)
    + 2 + 16                               // footer divider + gap
    + FTR_H;

  // Create the drawing canvas
  const canvas  = document.createElement("canvas");
  canvas.width  = CARD_W;
  canvas.height = Math.max(totalH, 500);
  const ctx     = canvas.getContext("2d");

  // Background — matches HTML story page (#f5f7fa)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CARD_W, canvas.height);

  // ── Header bar — navy #0f3460 matching HTML page header colour ──
  ctx.fillStyle = "#0f3460";
  ctx.fillRect(0, 0, CARD_W, HDR_H);

  ctx.textBaseline = "middle";

  // Left: date + child name/age
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold 28px "Segoe UI", Arial, sans-serif`;
  ctx.fillText(fmtDate, PAD, HDR_H / 2 - 16);

  ctx.font = `20px "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const childLine = childAge ? `${childName}  ·  ${childAge}` : childName;
  ctx.fillText(childLine, PAD, HDR_H / 2 + 18);

  // Right: centre + room
  ctx.textAlign = "right";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold 20px "Segoe UI", Arial, sans-serif`;
  ctx.fillText(centreName, CARD_W - PAD, HDR_H / 2 - 16);
  ctx.font = `17px "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(roomName, CARD_W - PAD, HDR_H / 2 + 18);

  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  let y = HDR_H + PAD;

  // ── Title — navy matching HTML .header h1 { color: #0f3460 } ──
  ctx.fillStyle = "#0f3460";
  ctx.font = `bold ${TITLE_SIZE}px "Segoe UI", Arial, sans-serif`;
  y = drawWrappedText(ctx, plainTitle, PAD, y + TITLE_SIZE, TEXT_W, TITLE_LINE_H);

  // ── Divider — light navy tint matching HTML border colour ──
  y += GAP;
  ctx.fillStyle = "#c5d3e8";
  ctx.fillRect(PAD, y, TEXT_W, 2);
  y += 2 + GAP;

  // ── Body text ──
  if (plainBody) {
    ctx.fillStyle = "#2C2C2C";
    ctx.font = `${BODY_SIZE}px "Segoe UI", Arial, sans-serif`;
    y = drawWrappedText(ctx, plainBody, PAD, y + BODY_SIZE, TEXT_W, BODY_LINE_H);
    y += GAP;
  }

  // ── Routine section — divider lines matching user's preferred format ──
  if (plainRoutine) {
    // Top divider line
    ctx.fillStyle = "#c5d3e8";
    ctx.fillRect(PAD, y, TEXT_W, 2);
    y += 2 + 14;

    // Routine header: "Child's Routine"
    const childFirstCard = (childName || "").split(/\s+/)[0];
    const routineHeader  = childFirstCard ? `${childFirstCard}'s Routine` : "Daily Routine";
    ctx.fillStyle = "#0f3460";
    ctx.font = `bold 20px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(routineHeader, PAD, y + 20);
    y += 50; // header block height

    // Routine text
    ctx.fillStyle = "#333";
    ctx.font = `${ROU_SIZE}px "Segoe UI", Arial, sans-serif`;
    y = drawWrappedText(ctx, plainRoutine, PAD, y + ROU_SIZE, TEXT_W, ROU_LINE_H);
    y += 14;

    // Bottom divider line
    ctx.fillStyle = "#c5d3e8";
    ctx.fillRect(PAD, y, TEXT_W, 2);
    y += 2 + GAP; // GAP = 32px trailing gap (matches routineH overhead)
  }

  // ── Footer divider ──
  ctx.fillStyle = "#c5d3e8";
  ctx.fillRect(PAD, y, TEXT_W, 2);
  y += 2 + 16;

  // ── Footer — left column: educator + photo count + full attribution ──
  const FOOTER_SIZE = 14;
  const FOOTER_LINE = 22;

  ctx.textBaseline = "alphabetic";
  ctx.textAlign    = "left";
  let fy = y;

  ctx.fillStyle = "#555555";
  ctx.font = `${FOOTER_SIZE}px "Segoe UI", Arial, sans-serif`;
  if (educatorName) { ctx.fillText(`Educator: ${educatorName}`, PAD, fy); fy += FOOTER_LINE; }
  if (photoCount > 0) { ctx.fillText(`📷 ${photoCount} photo${photoCount !== 1 ? "s" : ""}`, PAD, fy); fy += FOOTER_LINE; }

  const childAtAge = (childName && childAge) ? `${childName} @ ${childAge}` : (childName || "");
  if (childAtAge) { ctx.fillStyle = "#666666"; ctx.fillText(childAtAge, PAD, fy); fy += FOOTER_LINE; }
  if (roomName)   { ctx.fillStyle = "#777777"; ctx.fillText(roomName, PAD, fy);   fy += FOOTER_LINE; }
  if (centreName) { ctx.fillStyle = "#777777"; ctx.fillText(centreName, PAD, fy); fy += FOOTER_LINE; }

  ctx.fillStyle = "#999999";
  ctx.font = `12px "Segoe UI", Arial, sans-serif`;
  ctx.fillText("Storypark / Storypark Smart Saver", PAD, fy);

  // ── Footer — right column: branding (top-anchored) ──
  ctx.textAlign = "right";
  ctx.fillStyle = "#AAAAAA";
  ctx.font = `13px "Segoe UI", Arial, sans-serif`;
  ctx.fillText("Storypark Smart Saver", CARD_W - PAD, y);
  ctx.fillStyle = "#C0C0C0";
  ctx.font = `12px "Segoe UI", Arial, sans-serif`;
  ctx.fillText("storypark.com", CARD_W - PAD, y + FOOTER_LINE);
  ctx.textAlign = "left";

  // Convert canvas → JPEG Blob
  const rawDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const base64b    = rawDataUrl.split(",")[1];
  const binaryb    = atob(base64b);
  const bytesb     = new Uint8Array(binaryb.length);
  for (let i = 0; i < binaryb.length; i++) bytesb[i] = binaryb.charCodeAt(i);
  const blob = new Blob([bytesb], { type: "image/jpeg" });

  // Stamp EXIF + IPTC
  const dateObj    = date ? new Date(`${date}T12:00:00`) : new Date();
  const cardArtist = exifArtist || `Storypark Smart Saver — ${centreName}`;
  const cardCaption = iptcCaption
    || [plainTitle, childName, roomName, centreName].filter(Boolean).join(" · ");
  const cardKeywords = (iptcKeywords && iptcKeywords.length > 0)
    ? iptcKeywords
    : [childName, centreName, "Storypark Story Card"].filter(Boolean);

  const stampedBlob = await applyExif(blob, dateObj, `${plainTitle} — ${childName}`, gpsCoords, {
    exifTitle:    plainTitle,
    exifSubject:  childName,
    exifComments: `Story by ${educatorName || "Educator"} on ${fmtDate}`,
    exifArtist:   cardArtist,
    iptcCaption:  cardCaption,
    iptcKeywords: cardKeywords,
    iptcByline:   iptcByline || educatorName || "",
  });

  return blobToDataUrl(stampedBlob);
}

/* ================================================================== */
/*  Message router                                                     */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === "PROCESS_IMAGE") {
    processImage(msg)
      .then((result) => sendResponse(result))
      // Return ok:false so sendToOffscreen() in background.js rejects the
      // promise and the error is logged as a WARNING rather than silently
      // counted as a face-rejection.
      .catch((err)   => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "DOWNLOAD_APPROVED") {
    downloadApproved(msg)
      .then(({ dataUrl, savePath }) => sendResponse({ ok: true, dataUrl, savePath }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "DOWNLOAD_VIDEO") {
    // New shape (v2.2.x): returns a managed blob URL + blobId so the
    // service worker can hand it directly to chrome.downloads.download()
    // without round-tripping through a base64 data URL (which would hit
    // the chrome.runtime 64 MB messaging limit on large videos).
    downloadVideo(msg)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err)   => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "BUILD_ENCODING") {
    buildDescriptorFromDataUrl(msg.imageDataUrl, msg.faceIndex ?? 0)
      .then((descriptor) => sendResponse({ ok: true, descriptor }))
      .catch((err)       => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "DOWNLOAD_TEXT") {
    // Save arbitrary text content (e.g. story HTML) as a downloaded file.
    // Returns dataUrl so the service worker can call chrome.downloads.download().
    (async () => {
      try {
        const blob    = new Blob([msg.text], { type: msg.mimeType || "text/plain" });
        const dataUrl = await blobToDataUrl(blob);
        sendResponse({ ok: true, dataUrl, savePath: msg.savePath });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "RE_EVALUATE_BATCH") {
    // Re-evaluate a batch of review queue items using current face profiles.
    // Runs entirely in-memory (no image fetching) — just math on stored descriptors.
    // Returns { results: [{ id, decision: "approve"|"reject"|"keep", effectiveScore }] }
    (async () => {
      try {
        const {
          items = [],
          positiveDescriptors = [],
          descriptorsByYear = {},
          negativeDescriptors = [],
          autoThreshold = 85,
          minThreshold = 50,
          disableAutoReject = false, // Phase 1&2 safety: never auto-reject when model is immature
        } = msg;

        // Build centroids from year-bucketed descriptors
        let centroids = buildCentroids(descriptorsByYear);
        if (centroids.length === 0 && positiveDescriptors.length >= 3) {
          const c = computeCentroid(positiveDescriptors);
          if (c) centroids = [c];
        }

        const results = [];
        for (const item of items) {
          const descriptor = item.descriptor;
          if (!descriptor) {
            results.push({ id: item.id, decision: "keep", effectiveScore: 0 });
            continue;
          }

          const matchData = enhancedMatch(
            descriptor,
            positiveDescriptors,
            negativeDescriptors,
            centroids,
          );

          let decision = "keep";
          if (matchData.effectiveScore >= autoThreshold) {
            decision = "approve";
          } else if (!disableAutoReject && matchData.effectiveScore < minThreshold && matchData.rawNegative > matchData.rawPositive * 0.8) {
            // Strong negative signal: negative match is close to or exceeds positive
            // Only auto-reject in Phase 3+ when model is mature (disableAutoReject=false)
            decision = "reject";
          }

          results.push({
            id: item.id,
            decision,
            effectiveScore: matchData.effectiveScore,
            rawPositive: matchData.rawPositive,
            rawNegative: matchData.rawNegative,
          });
        }

        sendResponse({ ok: true, results });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "GENERATE_STORY_CARD") {
    // Render a story card (1200 × variable-height JPEG) using Canvas API.
    // Accepts story metadata fields; returns a JPEG data URL with EXIF + IPTC applied.
    (async () => {
      try {
        const dataUrl = await createStoryCard(msg);
        sendResponse({ ok: true, dataUrl, savePath: msg.savePath });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "REWRITE_EXIF_ONLY") {
    // Re-stamp EXIF + IPTC on an already-downloaded JPEG.
    // Receives the original image as a data URL and returns a modified data URL.
    // Used by the "Rewrite Metadata" button in the dashboard Linked Folder card.
    (async () => {
      try {
        const { imageDataUrl, date, description, exifTitle, exifSubject,
                exifComments, exifArtist, iptcCaption, iptcKeywords, iptcByline,
                gpsCoords } = msg;

        // Decode the data URL to a Blob
        const base64  = imageDataUrl.split(",")[1];
        const binary  = atob(base64);
        const bytes   = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/jpeg" });

        // Parse the date (storyDate is YYYY-MM-DD)
        const dateObj = date ? new Date(date + "T00:00:00") : null;

        const stampedBlob = await applyExif(blob, dateObj, description || "", gpsCoords || null, {
          exifTitle:    exifTitle    || "",
          exifSubject:  exifSubject  || "",
          exifComments: exifComments || "",
          exifArtist:   exifArtist   || "",
          iptcCaption:  iptcCaption  || "",
          iptcKeywords: iptcKeywords || [],
          iptcByline:   iptcByline   || "",
        });

        const dataUrl = await blobToDataUrl(stampedBlob);
        // Read back key EXIF fields for verification (best-effort, non-fatal).
        // Allows dashboard.js to confirm Artist, Date and GPS were embedded
        // correctly without re-reading from disk.
        const readBack = readExif(dataUrl);
        sendResponse({ ok: true, dataUrl, readBack });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "CREATE_BLOB_URL") {
    const result = createBlobUrl(msg.dataUrl);
    sendResponse(result);
    return true;
  }

  if (msg.type === "REVOKE_BLOB_URL") {
    revokeBlobUrl(msg.blobId);
    sendResponse({ ok: true });
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

  if (msg.type === "CLEAR_PROFILE_CACHE") {
    // Called by memory-manager.js at CRITICAL heap pressure.
    // Clears the in-memory descriptor cache so GC can reclaim the memory.
    // The next PROCESS_IMAGE or REFRESH_PROFILES will reload from IDB as needed.
    _localProfiles.clear();
    sendResponse({ ok: true });
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
