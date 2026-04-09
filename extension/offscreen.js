/**
 * offscreen.js – Face recognition worker running inside the extension's
 * offscreen document (offscreen.html).
 *
 * The offscreen document exists because face-api.js requires Canvas and
 * HTMLImageElement APIs that are unavailable in a Manifest V3 service worker.
 *
 * Message protocol (chrome.runtime.onMessage):
 *
 *   IN  { type: "FACE_FILTER", posts, childEncodings, autoThreshold, minThreshold }
 *   OUT { ok: true,  autoApprove: [...], reviewQueue: [...] }
 *   OUT { ok: false, error: "..." }
 *
 *   IN  { type: "BUILD_ENCODING", imageDataUrl }
 *   OUT { ok: true,  descriptor: number[] }   // 128-D Float32Array serialised
 *   OUT { ok: false, error: "..." }
 *
 * Each post object in `posts` must include an `imageDataUrl` field (data: URL).
 * Results keep all original fields and add `matchPct` and `matchedChildren`.
 */

/* global faceapi */

let modelsLoaded = false;

/* ------------------------------------------------------------------ */
/*  Model loading                                                      */
/* ------------------------------------------------------------------ */

async function ensureModels() {
  if (modelsLoaded) return;
  if (typeof faceapi === "undefined") {
    throw new Error(
      "face-api.js not found. Download face-api.min.js and place it in extension/lib/ (see README)."
    );
  }
  const modelPath = chrome.runtime.getURL("models");
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath),
    faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
    faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
  ]);
  modelsLoaded = true;
  console.log("[offscreen] face-api.js models loaded.");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert a face-api.js Euclidean distance to a 0-100 match percentage.
 * dist=0 → 100%, dist=1 → 0%.  Values above 1 clamp to 0.
 */
function distanceToPercent(dist) {
  return Math.max(0, Math.round((1 - dist) * 100));
}

/**
 * Load a data: URL into an HTMLImageElement (resolves when fully loaded).
 */
function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image from data URL."));
    img.src = dataUrl;
  });
}

/* ------------------------------------------------------------------ */
/*  Core face operations                                               */
/* ------------------------------------------------------------------ */

/**
 * Build a 128-D face descriptor for a single image (data URL).
 * Returns null if no face is detected.
 */
async function buildDescriptorFromDataUrl(imageDataUrl) {
  await ensureModels();
  const img = await dataUrlToImage(imageDataUrl);
  const result = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();
  return result ? Array.from(result.descriptor) : null;
}

/**
 * Filter an array of posts using facial recognition thresholds.
 *
 * @param {Array}  posts           - Posts with imageDataUrl field.
 * @param {Array}  childEncodings  - [{ name, descriptor: number[] }]
 * @param {number} autoThreshold   - Percentage ≥ this → auto-approve.
 * @param {number} minThreshold    - Percentage ≥ this → review queue.
 *                                   Below → discard.
 * @returns {{ autoApprove: Array, reviewQueue: Array }}
 */
async function filterPosts(posts, childEncodings, autoThreshold, minThreshold) {
  await ensureModels();

  // Build ref descriptors (filter out entries that were never encoded)
  const refs = childEncodings
    .filter((c) => Array.isArray(c.descriptor) && c.descriptor.length === 128)
    .map((c) => ({
      name: c.name,
      descriptor: new Float32Array(c.descriptor),
    }));

  // No references configured → pass everything through as auto-approve
  if (refs.length === 0) {
    console.warn("[offscreen] No reference encodings – all photos pass through.");
    return {
      autoApprove: posts.map((p) => ({
        ...p,
        matchPct: 100,
        matchedChildren: [],
        imageDataUrl: undefined, // strip heavy field from return payload
      })),
      reviewQueue: [],
    };
  }

  const autoApprove = [];
  const reviewQueue = [];

  for (const post of posts) {
    if (!post.imageDataUrl) continue;

    let img;
    try {
      img = await dataUrlToImage(post.imageDataUrl);
    } catch (err) {
      console.warn("[offscreen] Could not load image:", err.message);
      continue;
    }

    let detections;
    try {
      detections = await faceapi
        .detectAllFaces(img)
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (err) {
      console.warn("[offscreen] Detection error:", err.message);
      continue;
    }

    if (detections.length === 0) continue; // no faces → discard

    // Find best match across all detected faces and all reference children
    let bestPct = 0;
    const matchedSet = new Set();

    for (const det of detections) {
      for (const ref of refs) {
        const dist = faceapi.euclideanDistance(det.descriptor, ref.descriptor);
        const pct = distanceToPercent(dist);
        if (pct >= minThreshold) {
          matchedSet.add(ref.name);
        }
        if (pct > bestPct) {
          bestPct = pct;
        }
      }
    }

    if (bestPct < minThreshold) continue; // below minimum → discard

    const result = {
      ...post,
      matchPct: bestPct,
      matchedChildren: [...matchedSet].sort(),
      imageDataUrl: undefined, // strip heavy field from return payload
    };

    if (bestPct >= autoThreshold) {
      autoApprove.push(result);
    } else {
      reviewQueue.push(result);
    }
  }

  return { autoApprove, reviewQueue };
}

/* ------------------------------------------------------------------ */
/*  Message router                                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "FACE_FILTER") {
    const { posts, childEncodings, autoThreshold, minThreshold } = msg;
    filterPosts(posts, childEncodings, autoThreshold ?? 85, minThreshold ?? 50)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  if (msg.type === "BUILD_ENCODING") {
    buildDescriptorFromDataUrl(msg.imageDataUrl)
      .then((descriptor) => sendResponse({ ok: true, descriptor }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  return false;
});
