/**
 * offscreen.js – Face recognition worker running inside the extension's
 * offscreen document (offscreen.html).
 *
 * The offscreen document exists because @vladmandic/human requires Canvas and
 * HTMLImageElement APIs that are unavailable in a Manifest V3 service worker.
 *
 * Message protocol (chrome.runtime.onMessage):
 *
 *   IN  { type: "FACE_FILTER", posts, childEncodings, autoThreshold, minThreshold }
 *   OUT { ok: true,  autoApprove: [...], reviewQueue: [...] }
 *   OUT { ok: false, error: "..." }
 *
 *   IN  { type: "BUILD_ENCODING", imageDataUrl }
 *   OUT { ok: true,  descriptor: number[] }   // face embedding serialised
 *   OUT { ok: false, error: "..." }
 *
 * Each post object in `posts` must include an `imageDataUrl` field (data: URL).
 * Results keep all original fields and add `matchPct` and `matchedChildren`.
 */

/* global Human */

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

async function ensureModels() {
  if (modelsLoaded) return;
  if (typeof Human === "undefined") {
    throw new Error(
      "human.js not found. Run `npm run build` to copy it into extension/lib/."
    );
  }
  human = new Human.Human(HUMAN_CONFIG);
  await human.load();
  modelsLoaded = true;
  console.log("[offscreen] Human models loaded.");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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
 * Build a face embedding for a single image (data URL).
 * Returns null if no face is detected.
 */
async function buildDescriptorFromDataUrl(imageDataUrl) {
  await ensureModels();
  const img = await dataUrlToImage(imageDataUrl);
  const result = await human.detect(img);
  const embedding = result.face?.[0]?.embedding;
  return embedding ? Array.from(embedding) : null;
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
    .filter((c) => Array.isArray(c.descriptor) && c.descriptor.length > 0)
    .map((c) => ({
      name: c.name,
      descriptor: c.descriptor,
    }));

  // No references configured → pass everything through as auto-approve
  if (refs.length === 0) {
    console.warn("[offscreen] No reference encodings – all photos pass through.");
    return {
      autoApprove: posts.map(({ imageDataUrl: _dropped, ...rest }) => ({
        ...rest,
        matchPct: 100,
        matchedChildren: [],
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

    let detectionResult;
    try {
      detectionResult = await human.detect(img);
    } catch (err) {
      console.warn("[offscreen] Detection error:", err.message);
      continue;
    }

    const detectedFaces = detectionResult.face ?? [];
    if (detectedFaces.length === 0) continue; // no faces → discard

    // Find best match across all detected faces and all reference children
    let bestPct = 0;
    const matchedSet = new Set();

    for (const face of detectedFaces) {
      const embedding = face.embedding;
      if (!embedding) continue;
      for (const ref of refs) {
        const sim = human.match.similarity(embedding, ref.descriptor);
        const pct = Math.round(sim * 100);
        if (pct >= minThreshold) {
          matchedSet.add(ref.name);
        }
        if (pct > bestPct) {
          bestPct = pct;
        }
      }
    }

    if (bestPct < minThreshold) continue; // below minimum → discard

    const { imageDataUrl: _dropped, ...postWithoutData } = post;
    const result = {
      ...postWithoutData,
      matchPct: bestPct,
      matchedChildren: [...matchedSet].sort(),
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
