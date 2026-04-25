/**
 * offscreen.js – Image processing worker (offscreen document).
 *
 * Loaded as a module inside offscreen.html, which grants access to
 * Canvas, Blob, URL.createObjectURL, and FileReader (for data URL conversion).
 * NOTE: chrome.downloads is NOT available in offscreen documents — all
 * download triggers happen in the service worker (background.js).
 */

import { applyExif, readExif }                from "./lib/exif.js";
import { addToReviewQueue, appendDescriptor,
         getAllDescriptors }                   from "./lib/db.js";
import { computeCentroid, buildCentroids } from "./lib/matching.js";
// Final wiring: Modular renderer activated
import { createStoryCard } from "./offscreen-card.js";

/* global Human */

/* ================================================================== */
/* @vladmandic/human setup                                            */
/* ================================================================== */

const HUMAN_CONFIG = {
  modelBasePath: chrome.runtime.getURL("models/"),
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

  if (typeof Human === "undefined") {
    console.warn("[offscreen] human.js not found — face recognition disabled.");
    modelsLoaded = false;
    return;
  }

  try {
    human        = new Human.Human(HUMAN_CONFIG);
    await human.load();
    modelsLoaded = true;
    console.debug("[offscreen] Human models loaded.");
  } catch (err) {
    console.warn("[offscreen] Failed to load face recognition models.", err);
    human        = null;
    modelsLoaded = false;
  }
}

/* ================================================================== */
/* In-session profile cache                                           */
/* ================================================================== */

const MAX_DESCRIPTORS_PER_CHILD = 1000;
const _localProfiles = new Map();

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
/* Image loading helpers                                              */
/* ================================================================== */

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

function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img   = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image from data URL."));
    img.src     = dataUrl;
  });
}

/* ================================================================== */
/* Face matching — Enhanced pipeline                                  */
/* ================================================================== */

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

function similarityPct(a, b) {
  const arrA = Array.isArray(a) ? a : Array.from(a);
  const arrB = Array.isArray(b) ? b : Array.from(b);
  const sim = (human && human.match)
    ? human.match.similarity(arrA, arrB)
    : cosineSimilarity(arrA, arrB);
  return Math.max(0, Math.round(sim * 100));
}

function bestMatchPercent(embedding, descriptors) {
  if (!descriptors || descriptors.length === 0) return 0;
  let best = 0;
  for (const desc of descriptors) {
    const pct = similarityPct(embedding, desc);
    if (pct > best) best = pct;
  }
  return best;
}

function topKVoting(embedding, descriptors, negativeDescriptors, k = 5) {
  const scored = [];
  for (const desc of descriptors) {
    scored.push({ pct: similarityPct(embedding, desc), type: "pos" });
  }
  for (const desc of negativeDescriptors) {
    scored.push({ pct: similarityPct(embedding, desc), type: "neg" });
  }
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

function enhancedMatch(embedding, positiveDescriptors, negativeDescriptors, centroids) {
  const rawPositive = bestMatchPercent(embedding, positiveDescriptors);
  const centroidScore = centroids.length > 0
    ? bestMatchPercent(embedding, centroids)
    : rawPositive;
  const rawNegative = bestMatchPercent(embedding, negativeDescriptors);
  const { consensus } = (positiveDescriptors.length + negativeDescriptors.length >= 5)
    ? topKVoting(embedding, positiveDescriptors, negativeDescriptors, 5)
    : { consensus: 1.0 };
  const NEGATIVE_WEIGHT = 0.6;
  const negativePenalty = rawNegative > 0 ? rawNegative * NEGATIVE_WEIGHT : 0;
  const consensusFactor = 0.5 + (consensus * 0.5);
  const baseScore = Math.max(rawPositive, centroidScore);
  const margin = baseScore - negativePenalty;
  const effectiveScore = Math.max(0, Math.round(margin * consensusFactor));

  return { effectiveScore, rawPositive, rawNegative, centroidScore, consensus, margin };
}

/* ================================================================== */
/* Helper functions                                                   */
/* ================================================================== */

function cropFaceToDataUrl(img, box) {
  const pad = 10;
  const sx  = Math.max(0, box[0] - pad);
  const sy  = Math.max(0, box[1] - pad);
  const sw  = Math.min(img.naturalWidth  - sx, box[2] + pad * 2);
  const sh  = Math.min(img.naturalHeight - sy, box[3] + pad * 2);
  const canvas = document.createElement("canvas");
  canvas.width  = sw; canvas.height = sh;
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/jpeg", 0.8);
}

function makeFullThumbnail(img) {
  const MAX_W = 400;
  const scale = img.naturalWidth > MAX_W ? MAX_W / img.naturalWidth : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.75);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to convert blob to data URL"));
    reader.readAsDataURL(blob);
  });
}

/* ================================================================== */
/* Core pipeline: fetch → detect → decide                            */
/* ================================================================== */

async function processImage(msg) {
  const {
    imageUrl, storyData, description, childId, childName, savePath,
    childEncodings = [], negativeDescriptors = [], autoThreshold = 85,
    minThreshold = 50, gpsCoords = null,
  } = msg;

  const res = await fetch(imageUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${imageUrl}`);
  const buffer = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const isJpeg = contentType.includes("jpeg") || contentType.includes("jpg");

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

  // Bootstrap mode (no training data)
  if (childEncodings.length === 0) {
    await ensureModels();
    if (!modelsLoaded || !human) {
      const date = storyData.createdAt ? new Date(storyData.createdAt) : null;
      const stampedBlob = await makeStampedBlob(date);
      return { ok: true, result: "approve", dataUrl: await blobToDataUrl(stampedBlob), savePath, detectedFaces: [] };
    }
    const { img: bImg, blobUrl: bBlobUrl } = await arrayBufferToImage(buffer);
    let bootstrapFaces = [];
    try {
      const detected = await human.detect(bImg);
      bootstrapFaces = detected?.face ?? [];
    } finally { URL.revokeObjectURL(bBlobUrl); }

    if (bootstrapFaces.length === 0) {
      await addToReviewQueue({ childId, childName, fullPhotoDataUrl: makeFullThumbnail(bImg), storyData, description, savePath, matchPct: 0, noFace: true, noTrainingData: true, descriptor: null });
      return { ok: true, result: "review", matchPct: 0, noFace: true, detectedFaces: [] };
    }
    const bestBFace = bootstrapFaces[0];
    const allBFaces = bootstrapFaces.filter(f => f.embedding).map(f => ({ descriptor: Array.from(f.embedding), croppedDataUrl: f.box ? cropFaceToDataUrl(bImg, f.box) : null, matchPct: null }));
    await addToReviewQueue({ croppedFaceDataUrl: bestBFace.box ? cropFaceToDataUrl(bImg, bestBFace.box) : null, fullPhotoDataUrl: makeFullThumbnail(bImg), descriptor: bestBFace.embedding ? Array.from(bestBFace.embedding) : null, allFaces: allBFaces.length > 1 ? allBFaces : undefined, storyData, description, childId, childName, savePath, matchPct: 0, matchedChildren: [childName], noTrainingData: true });
    return { ok: true, result: "review", matchPct: 0, noTrainingData: true, detectedFaces: bootstrapFaces.filter(f => f.embedding).map(f => ({ descriptor: Array.from(f.embedding) })) };
  }

  // Normal mode (with training data)
  const { img, blobUrl } = await arrayBufferToImage(buffer);
  let detectionResult = null;
  let useFallback = false;
  try {
    await ensureModels();
    if (!modelsLoaded || !human) useFallback = true;
    else detectionResult = await human.detect(img);
  } finally { URL.revokeObjectURL(blobUrl); }

  if (useFallback) {
    const stampedBlob = await makeStampedBlob(storyData.createdAt ? new Date(storyData.createdAt) : null);
    return { ok: true, result: "approve", dataUrl: await blobToDataUrl(stampedBlob), savePath, detectedFaces: [] };
  }

  const faces = detectionResult?.face ?? [];
  const detectedFaces = faces.filter(f => f.embedding).map(f => ({ descriptor: Array.from(f.embedding) }));

  if (faces.length === 0) {
    await addToReviewQueue({ childId, childName, fullPhotoDataUrl: makeFullThumbnail(img), storyData, description, savePath, matchPct: 0, noFace: true, noTrainingData: false, descriptor: null });
    return { ok: true, result: "review", matchPct: 0, noFace: true, detectedFaces: [] };
  }

  let bestPct = 0, bestFace = null, bestDescriptor = null, bestChildId = null, bestChildName = null, bestEffective = 0, bestMatchData = null;
  const matchedNames = new Set();
  const effectiveEncodings = mergeWithLocalProfiles(childEncodings);
  const childCentroids = new Map();
  for (const enc of effectiveEncodings) {
    const centroids = buildCentroids(enc.descriptorsByYear || {});
    if (centroids.length === 0 && enc.descriptors.length >= 3) {
      const singleCentroid = computeCentroid(enc.descriptors);
      if (singleCentroid) centroids.push(singleCentroid);
    }
    childCentroids.set(enc.childId, centroids);
  }

  for (const face of faces) {
    if (!face.embedding) continue;
    for (const enc of effectiveEncodings) {
      const matchData = enhancedMatch(face.embedding, enc.descriptors, negativeDescriptors, childCentroids.get(enc.childId) || []);
      if (matchData.rawPositive >= minThreshold) matchedNames.add(enc.childName);
      if (matchData.effectiveScore > bestEffective) {
        bestEffective = matchData.effectiveScore; bestPct = matchData.rawPositive;
        bestFace = face; bestDescriptor = Array.from(face.embedding);
        bestChildId = enc.childId; bestChildName = enc.childName; bestMatchData = matchData;
      }
    }
  }

  if (bestPct < minThreshold) return { ok: true, result: "reject", detectedFaces };

  if (bestMatchData && bestEffective < minThreshold && bestPct >= minThreshold) {
    const allFacesDescriptors = effectiveEncodings.flatMap(e => e.descriptors);
    const allFacesData = faces.filter(f => f.embedding).map(f => ({ descriptor: Array.from(f.embedding), croppedDataUrl: f.box ? cropFaceToDataUrl(img, f.box) : null, matchPct: bestMatchPercent(f.embedding, allFacesDescriptors) }));
    await addToReviewQueue({ croppedFaceDataUrl: bestFace?.box ? cropFaceToDataUrl(img, bestFace.box) : null, fullPhotoDataUrl: makeFullThumbnail(img), descriptor: bestDescriptor, allFaces: allFacesData.length > 1 ? allFacesData : undefined, storyData, description, childId: bestChildId || childId, childName: bestChildName || childName, savePath, matchPct: bestPct, effectiveScore: bestEffective, negativePct: bestMatchData.rawNegative, consensus: bestMatchData.consensus, matchedChildren: [...matchedNames].sort(), negativeOverride: true });
    return { ok: true, result: "review", matchPct: bestPct, effectiveScore: bestEffective, negativePct: bestMatchData.rawNegative, negativeOverride: true, detectedFaces };
  }

  if (bestEffective >= autoThreshold) {
    const stampedBlob = await makeStampedBlob(storyData.createdAt ? new Date(storyData.createdAt) : null);
    if (bestDescriptor && bestChildId) {
      const learnDate = storyData.createdAt ? new Date(storyData.createdAt) : null;
      await appendDescriptor(bestChildId, bestChildName ?? childName, bestDescriptor, learnDate ? learnDate.getFullYear().toString() : "unknown").catch(() => {});
      const cached = _localProfiles.get(bestChildId);
      const descs = cached ? [...cached.descriptors, bestDescriptor] : [bestDescriptor];
      if (descs.length > MAX_DESCRIPTORS_PER_CHILD) descs.splice(0, descs.length - MAX_DESCRIPTORS_PER_CHILD);
      _localProfiles.set(bestChildId, { childId: bestChildId, childName: bestChildName ?? childName, descriptors: descs });
    }
    return { ok: true, result: "approve", dataUrl: await blobToDataUrl(stampedBlob), savePath, detectedFaces };
  }

  const allFacesDescriptors = effectiveEncodings.flatMap(e => e.descriptors);
  const facesWithEmbed = faces.filter(f => f.embedding);
  if (facesWithEmbed.length > 1) {
    for (let fi = 0; fi < facesWithEmbed.length; fi++) {
      const face = facesWithEmbed[fi];
      await addToReviewQueue({ croppedFaceDataUrl: face.box ? cropFaceToDataUrl(img, face.box) : null, fullPhotoDataUrl: makeFullThumbnail(img), descriptor: Array.from(face.embedding), storyData, description, childId: bestChildId || childId, childName: bestChildName || childName, savePath, matchPct: bestMatchPercent(face.embedding, allFacesDescriptors), matchedChildren: [...matchedNames].sort(), faceIndex: fi, totalFaces: facesWithEmbed.length });
    }
  } else {
    await addToReviewQueue({ croppedFaceDataUrl: bestFace.box ? cropFaceToDataUrl(img, bestFace.box) : null, fullPhotoDataUrl: makeFullThumbnail(img), descriptor: bestDescriptor, storyData, description, childId: bestChildId || childId, childName: bestChildName || childName, savePath, matchPct: bestPct, matchedChildren: [...matchedNames].sort() });
  }
  return { ok: true, result: "review", matchPct: bestPct, detectedFaces };
}

/* ================================================================== */
/* Handlers                                                           */
/* ================================================================== */

async function downloadApproved(msg) {
  const { storyData, description, savePath, gpsCoords = null } = msg;
  const res = await fetch(storyData.originalUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`Image fetch ${res.status}: ${storyData.originalUrl}`);
  const buffer = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const srcBlob = new Blob([buffer], { type: contentType });
  const stampedBlob = (contentType.includes("jpeg") || contentType.includes("jpg"))
    ? await applyExif(srcBlob, storyData.createdAt ? new Date(storyData.createdAt) : null, description, gpsCoords, {
        exifTitle: msg.exifTitle || "", exifSubject: msg.exifSubject || "", exifComments: msg.exifComments || "",
        exifArtist: msg.exifArtist || "", iptcCaption: msg.iptcCaption || "", iptcKeywords: msg.iptcKeywords || [],
        iptcByline: msg.iptcByline || "",
      })
    : srcBlob;
  return { dataUrl: await blobToDataUrl(stampedBlob), savePath };
}

const _managedBlobUrls = new Map();

function createBlobUrl(dataUrl) {
  try {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx < 0) throw new Error("Invalid data URL");
    const isBase64 = dataUrl.substring(0, commaIdx).includes(";base64");
    const payload = dataUrl.substring(commaIdx + 1);
    let bytes;
    if (isBase64) {
      const bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else bytes = new TextEncoder().encode(decodeURIComponent(payload));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: /data:([^;]+)/.exec(dataUrl.substring(0, commaIdx))?.[1] || "application/octet-stream" }));
    const blobId = Math.random().toString(36).slice(2);
    _managedBlobUrls.set(blobId, blobUrl);
    return { ok: true, blobUrl, blobId };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function downloadVideo(msg) {
  const { videoUrl, savePath } = msg;
  const _fetch = () => fetch(videoUrl, { credentials: "include", headers: { "Range": "bytes=0-" } });
  let res; try { res = await _fetch(); } catch { await new Promise(r => setTimeout(r, 1500)); res = await _fetch(); }
  if (res.status !== 200 && res.status !== 206) throw new Error(`Video fetch ${res.status}: ${videoUrl}`);

  const contentType = res.headers.get("content-type") || "video/mp4";
  const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
  let blob;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader(); const chunks = []; let received = 0, lastAt = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      chunks.push(value); received += value.byteLength;
      if (Date.now() - lastAt > 2000) {
        lastAt = Date.now();
        chrome.runtime.sendMessage({ type: "VIDEO_DOWNLOAD_PROGRESS", videoUrl, savePath, receivedBytes: received, totalBytes, percent: totalBytes > 0 ? Math.round((received / totalBytes) * 100) : null, mb: Number((received / 1048576).toFixed(1)) }).catch(() => {});
      }
    }
    blob = new Blob(chunks, { type: contentType });
  } else blob = await res.blob();

  const blobUrl = URL.createObjectURL(blob.type === contentType ? blob : new Blob([blob], { type: contentType }));
  const blobId = Math.random().toString(36).slice(2);
  _managedBlobUrls.set(blobId, blobUrl);
  return { blobUrl, blobId, savePath, size: blob.size, contentType };
}

/* ================================================================== */
/* Message router                                                     */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PROCESS_IMAGE") {
    processImage(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "DOWNLOAD_APPROVED") {
    downloadApproved(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "DOWNLOAD_VIDEO") {
    downloadVideo(msg).then(res => sendResponse({ ok: true, ...res })).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "BUILD_ENCODING") {
    ensureModels().then(async () => {
      const img = await dataUrlToImage(msg.imageDataUrl);
      const result = await human.detect(img);
      sendResponse({ ok: true, descriptor: result.face?.[msg.faceIndex ?? 0]?.embedding ? Array.from(result.face[msg.faceIndex ?? 0].embedding) : null });
    }).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "DOWNLOAD_TEXT") {
    blobToDataUrl(new Blob([msg.text], { type: msg.mimeType || "text/plain" }))
      .then(dataUrl => sendResponse({ ok: true, dataUrl, savePath: msg.savePath }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "RE_EVALUATE_BATCH") {
    (async () => {
      try {
        let centroids = buildCentroids(msg.descriptorsByYear || {});
        if (centroids.length === 0 && msg.positiveDescriptors.length >= 3) {
          const c = computeCentroid(msg.positiveDescriptors); if (c) centroids = [c];
        }
        const results = msg.items.map(item => {
          if (!item.descriptor) return { id: item.id, decision: "keep", effectiveScore: 0 };
          const md = enhancedMatch(item.descriptor, msg.positiveDescriptors, msg.negativeDescriptors, centroids);
          let decision = "keep";
          if (md.effectiveScore >= msg.autoThreshold) decision = "approve";
          else if (!msg.disableAutoReject && md.effectiveScore < msg.minThreshold && md.rawNegative > md.rawPositive * 0.8) decision = "reject";
          return { id: item.id, decision, effectiveScore: md.effectiveScore, rawPositive: md.rawPositive, rawNegative: md.rawNegative };
        });
        sendResponse({ ok: true, results });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }
  if (msg.type === "GENERATE_STORY_CARD") {
    createStoryCard(msg, applyExif, blobToDataUrl)
      .then(dataUrl => sendResponse({ ok: true, dataUrl, savePath: msg.savePath }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "REWRITE_EXIF_ONLY") {
    (async () => {
      try {
        const base64 = msg.imageDataUrl.split(",")[1]; const binary = atob(base64);
        const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const stamped = await applyExif(new Blob([bytes], { type: "image/jpeg" }), msg.date ? new Date(msg.date + "T00:00:00") : null, msg.description || "", msg.gpsCoords || null, { exifTitle: msg.exifTitle || "", exifSubject: msg.exifSubject || "", exifComments: msg.exifComments || "", exifArtist: msg.exifArtist || "", iptcCaption: msg.iptcCaption || "", iptcKeywords: msg.iptcKeywords || [], iptcByline: msg.iptcByline || "" });
        const dataUrl = await blobToDataUrl(stamped);
        sendResponse({ ok: true, dataUrl, readBack: readExif(dataUrl) });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }
  if (msg.type === "CREATE_BLOB_URL") { sendResponse(createBlobUrl(msg.dataUrl)); return true; }
  if (msg.type === "REVOKE_BLOB_URL") { const url = _managedBlobUrls.get(msg.blobId); if (url) { URL.revokeObjectURL(url); _managedBlobUrls.delete(msg.blobId); } sendResponse({ ok: true }); return true; }
  if (msg.type === "REFRESH_PROFILES") { getAllDescriptors().then(recs => { _localProfiles.clear(); recs.forEach(r => _localProfiles.set(r.childId, r)); sendResponse({ ok: true }); }).catch(err => sendResponse({ ok: false, error: err.message })); return true; }
  if (msg.type === "CLEAR_PROFILE_CACHE") { _localProfiles.clear(); sendResponse({ ok: true }); return true; }
  return false;
});
