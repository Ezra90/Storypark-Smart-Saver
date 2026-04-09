/**
 * face.js – Client-side face detection and recognition using face-api.js.
 *
 * face-api.js runs entirely in the browser via TensorFlow.js, so no server
 * round-trips are needed. Model weights must be placed in extension/models/.
 *
 * Workflow:
 *   1. loadModels()           – one-time model init (called at extension startup).
 *   2. buildEncoding(blob)    – compute a 128-D descriptor from a reference photo.
 *   3. filterPhotos(posts)    – keep only photos that match at least one known child.
 *
 * Required face-api.js models (place weight files in extension/models/):
 *   - ssd_mobilenetv1     (face detector)
 *   - face_landmark_68    (alignment)
 *   - face_recognition    (128-D descriptor)
 *
 * To obtain the models, download them from:
 *   https://github.com/justadudewhohacks/face-api.js/tree/master/weights
 */

/* global faceapi */
/* face-api.js is loaded via <script> in options.html / popup.html, or
   importScripts() in the service worker offscreen document. */

const MATCH_THRESHOLD = 0.6; // Euclidean distance; lower = stricter

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
 * Compute a 128-D face descriptor from a single reference photo Blob.
 *
 * @param {Blob} blob – JPEG/PNG image of the child's face.
 * @returns {Promise<Float32Array|null>} – Descriptor, or null if no face found.
 */
export async function buildEncoding(blob) {
  await loadModels();
  const img = await blobToImage(blob);
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
/*  Photo filtering                                                    */
/* ------------------------------------------------------------------ */

/**
 * Filter an array of scraped post objects, keeping only those whose images
 * contain a face matching at least one known child.
 *
 * @param {Array<Object>} posts – Each must have a `blob` (Blob) property.
 * @returns {Promise<Array<Object>>} – Filtered posts, each gains a
 *          `matchedChildren` (string[]) property.
 */
export async function filterPhotos(posts) {
  await loadModels();

  // Load stored reference encodings: { name: string, descriptor: number[] }[]
  const { childEncodings = [] } = await chrome.storage.local.get(
    "childEncodings"
  );

  if (childEncodings.length === 0) {
    console.warn("[face] No reference encodings stored – skipping filter.");
    // Return all posts unfiltered (no face recognition configured).
    return posts.map((p) => ({ ...p, matchedChildren: [] }));
  }

  const refs = childEncodings.map((c) => ({
    name: c.name,
    descriptor: new Float32Array(c.descriptor),
  }));

  const kept = [];

  for (const post of posts) {
    const img = await blobToImage(post.blob);
    const detections = await faceapi
      .detectAllFaces(img)
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length === 0) continue; // no faces → skip photo

    const matched = new Set();
    for (const det of detections) {
      for (const ref of refs) {
        const dist = faceapi.euclideanDistance(det.descriptor, ref.descriptor);
        if (dist < MATCH_THRESHOLD) {
          matched.add(ref.name);
        }
      }
    }

    if (matched.size > 0) {
      kept.push({
        ...post,
        matchedChildren: [...matched].sort(),
      });
    }
  }

  return kept;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert a Blob to an HTMLImageElement (needed by face-api.js).
 */
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}
