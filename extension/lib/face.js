/**
 * face.js – Client-side face detection and recognition using face-api.js.
 *
 * face-api.js runs entirely in the browser via TensorFlow.js, so no server
 * round-trips are needed. Model weights must be placed in extension/models/.
 *
 * Workflow:
 *   1. loadModels()              – one-time model init.
 *   2. buildEncoding(img)        – compute a 128-D descriptor from an HTMLImageElement.
 *   3. computeMatchPercent(img)  – compare image against stored encodings for a child.
 *
 * NOTE: The full sync-time face filtering is performed in offscreen.js (which
 * also has DOM/Canvas access). This module is used by the Options page for
 * live training-photo quality feedback.
 *
 * Required face-api.js models (place weight files in extension/models/):
 *   - ssd_mobilenetv1     (face detector)
 *   - face_landmark_68    (alignment)
 *   - face_recognition    (128-D descriptor)
 *
 * Download from:
 *   https://github.com/justadudewhohacks/face-api.js/tree/master/weights
 */

/* global faceapi */
/* face-api.js is loaded via <script> in options.html / offscreen.html.
   The service worker (background.js) delegates face operations to
   offscreen.js via the offscreen document API. */

/* ------------------------------------------------------------------ */
/*  Distance ↔ percentage conversion                                  */
/* ------------------------------------------------------------------ */

/**
 * Convert a face-api.js Euclidean distance to a 0–100 match percentage.
 * dist = 0   → 100 % (identical descriptor)
 * dist = 0.5 → 50 %
 * dist ≥ 1   → 0 %
 *
 * @param {number} dist – L2 distance from faceapi.euclideanDistance().
 * @returns {number} – Integer percentage in [0, 100].
 */
export function distanceToPercent(dist) {
  return Math.max(0, Math.round((1 - dist) * 100));
}

let modelsLoaded = false;

/* ------------------------------------------------------------------ */
/*  Model loading                                                      */
/* ------------------------------------------------------------------ */

/**
 * Load face-api.js neural-network models from the extension's models/ dir.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export async function loadModels() {
  if (modelsLoaded) return;
  if (typeof faceapi === "undefined") {
    throw new Error(
      "face-api.js not found. Place face-api.min.js in extension/lib/."
    );
  }
  const modelPath = chrome.runtime.getURL("models");
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath),
    faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
    faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
  ]);
  modelsLoaded = true;
  console.log("[face] Models loaded.");
}

/* ------------------------------------------------------------------ */
/*  Reference encoding                                                 */
/* ------------------------------------------------------------------ */

/**
 * Compute a 128-D face descriptor from an HTMLImageElement.
 *
 * @param {HTMLImageElement} img – Reference face image.
 * @returns {Promise<Float32Array|null>} – Descriptor, or null if no face found.
 */
export async function buildEncoding(img) {
  await loadModels();
  const detection = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) {
    console.warn("[face] No face detected in reference photo.");
    return null;
  }
  return detection.descriptor; // Float32Array(128)
}

/* ------------------------------------------------------------------ */
/*  Live match preview (used in Options page training section)         */
/* ------------------------------------------------------------------ */

/**
 * Compare an image against a list of stored descriptors and return the
 * best match percentage. Used for live quality feedback during training.
 *
 * @param {HTMLImageElement} img              – Image to test.
 * @param {Array<number[]>}  storedDescriptors – Previously stored descriptors
 *                                              for the same child.
 * @returns {Promise<{ faceFound: boolean, matchPct: number|null }>}
 */
export async function computeMatchPercent(img, storedDescriptors) {
  await loadModels();

  const result = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!result) return { faceFound: false, matchPct: null };

  if (!storedDescriptors || storedDescriptors.length === 0) {
    // No existing encodings to compare against → just confirm face found
    return { faceFound: true, matchPct: null };
  }

  // Compare against all stored descriptors; return best match
  let bestPct = 0;
  for (const stored of storedDescriptors) {
    const ref = new Float32Array(stored);
    const dist = faceapi.euclideanDistance(result.descriptor, ref);
    const pct = distanceToPercent(dist);
    if (pct > bestPct) bestPct = pct;
  }

  return { faceFound: true, matchPct: bestPct };
}
