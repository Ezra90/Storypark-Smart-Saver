/**
 * face.js – Client-side face detection and recognition using @vladmandic/human.
 *
 * Human runs entirely in the browser via TensorFlow.js, so no server
 * round-trips are needed. Model weights must be placed in extension/models/
 * (populated automatically by running `npm run build`).
 *
 * Workflow:
 *   1. loadModels()              – one-time model init.
 *   2. buildEncoding(img)        – compute a face embedding from an HTMLImageElement.
 *   3. computeMatchPercent(img)  – compare image against stored encodings for a child.
 *
 * NOTE: The full sync-time face filtering is performed in offscreen.js (which
 * also has DOM/Canvas access). This module is used by the Options page for
 * live training-photo quality feedback.
 *
 * Required models (copied to extension/models/ by `npm run build`):
 *   - blazeface  (face detector)
 *   - faceres    (face embedding / descriptor)
 */

/* global Human */
/* human.js is loaded via <script> in options.html / offscreen.html.
   The service worker (background.js) delegates face operations to
   offscreen.js via the offscreen document API. */

/* ------------------------------------------------------------------ */
/*  Human instance configuration                                       */
/* ------------------------------------------------------------------ */

const HUMAN_CONFIG = {
  modelBasePath: chrome.runtime.getURL("models/"),
  face: {
    enabled: true,
    detector: { enabled: true, modelPath: "blazeface.json", rotation: false },
    mesh: { enabled: false },
    iris: { enabled: false },
    description: { enabled: true, modelPath: "faceres.json" },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
};

let human = null;
let modelsLoaded = false;

/* ------------------------------------------------------------------ */
/*  Model loading                                                      */
/* ------------------------------------------------------------------ */

/**
 * Load Human neural-network models from the extension's models/ dir.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export async function loadModels() {
  if (modelsLoaded) return;
  if (typeof Human === "undefined") {
    throw new Error(
      "human.js not found. Run `npm run build` to copy it into extension/lib/."
    );
  }
  human = new Human.Human(HUMAN_CONFIG);
  await human.load();
  modelsLoaded = true;
  console.debug("[face] Human models loaded.");
}

/* ------------------------------------------------------------------ */
/*  Reference encoding                                                 */
/* ------------------------------------------------------------------ */

/**
 * Compute a face embedding from an HTMLImageElement.
 *
 * @param {HTMLImageElement} img – Reference face image.
 * @returns {Promise<number[]|null>} – Embedding array, or null if no face found.
 */
export async function buildEncoding(img) {
  await loadModels();
  const result = await human.detect(img);
  if (!result.face || result.face.length === 0 || !result.face[0].embedding) {
    console.warn("[face] No face detected in reference photo.");
    return null;
  }
  return result.face[0].embedding;
}

/**
 * Detect all faces in an image and return their embeddings and scores.
 *
 * @param {HTMLImageElement} img
 * @returns {Promise<Array<{embedding: number[]|null, score: number|null}>>}
 */
export async function detectFaces(img) {
  await loadModels();
  const result = await human.detect(img);
  return (result.face || []).map((f) => ({
    embedding: f.embedding ? Array.from(f.embedding) : null,
    score: f.score ?? null,
  }));
}

/**
 * Return the best match percentage between an embedding and a list of stored
 * descriptors, or null when there is nothing to compare against.
 *
 * @param {number[]}        embedding         – The embedding to test.
 * @param {Array<number[]>} storedDescriptors – Previously saved embeddings.
 * @returns {Promise<number|null>}
 */
export async function matchEmbedding(embedding, storedDescriptors) {
  await loadModels();
  if (!embedding || !storedDescriptors || storedDescriptors.length === 0) {
    return null;
  }
  let bestPct = 0;
  for (const stored of storedDescriptors) {
    const sim = human.match.similarity(embedding, stored);
    const pct = Math.round(sim * 100);
    if (pct > bestPct) bestPct = pct;
  }
  return bestPct;
}

/* ------------------------------------------------------------------ */
/*  Live match preview (used in Options page training section)         */
/* ------------------------------------------------------------------ */

/**
 * Compare an image against a list of stored descriptors and return the
 * best match percentage. Used for live quality feedback during training.
 *
 * @param {HTMLImageElement} img              – Image to test.
 * @param {Array<number[]>}  storedDescriptors – Previously stored embeddings
 *                                              for the same child.
 * @returns {Promise<{ faceFound: boolean, matchPct: number|null }>}
 */
export async function computeMatchPercent(img, storedDescriptors) {
  await loadModels();

  const result = await human.detect(img);
  const embedding = result.face?.[0]?.embedding;

  if (!embedding) return { faceFound: false, matchPct: null };

  if (!storedDescriptors || storedDescriptors.length === 0) {
    // No existing encodings to compare against → just confirm face found
    return { faceFound: true, matchPct: null };
  }

  // Compare against all stored descriptors; return best match
  let bestPct = 0;
  for (const stored of storedDescriptors) {
    const sim = human.match.similarity(embedding, stored);
    const pct = Math.round(sim * 100);
    if (pct > bestPct) bestPct = pct;
  }

  return { faceFound: true, matchPct: bestPct };
}
