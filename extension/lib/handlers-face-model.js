/**
 * handlers-face-model.js — Advanced face model lifecycle handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  Self-improve, initial bootstrap, model health, holdout sets,      │
 * │  decision-audit summaries, and retention maintenance.              │
 * └────────────────────────────────────────────────────────────────────┘
 */

import {
  getDownloadedStories,
  getDescriptors,
  getNegativeDescriptors,
  getChildPhase,
  getChildFingerprints,
  appendDescriptor,
  addPendingDownload,
  addToReviewQueue,
  removeRejection,
  markFilenameApprovedInManifest,
  appendDecisionLogEntries,
  getDecisionLogEntries,
  saveModelHealth,
  getModelHealth,
  saveHoldoutSet,
  getHoldoutSet,
  rotateDecisionLog,
  pruneAgedFaceData,
  acquireJobLock,
  releaseJobLock,
} from "./db.js";
import { enhancedMatch, buildCentroids } from "./matching.js";
import { sanitizeName } from "./metadata-helpers.js";

function _decisionId(prefix = "decision") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function _sha256Hex(input) {
  const buf = new TextEncoder().encode(String(input || ""));
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function _scoreReasonCode(score = 0, threshold = 0, negative = 0, minThreshold = 0) {
  if (score >= threshold && negative < minThreshold) return "strong_positive";
  if (score < minThreshold && negative >= minThreshold) return "strong_negative";
  return "borderline_review";
}

async function _logFaceDecision(payload) {
  const safe = {
    decisionId: payload.decisionId || _decisionId("face"),
    timestamp: payload.timestamp || new Date().toISOString(),
    source: payload.source || "unknown",
    decision: payload.decision || "none",
    childId: payload.childId || "",
    childName: payload.childName || "",
    storyId: payload.storyId || "",
    imageUrlHash: payload.imageUrlHash || "",
    phase: payload.phase ?? null,
    thresholds: payload.thresholds || {},
    scores: payload.scores || {},
    reasonCode: payload.reasonCode || "unknown",
    modelVersion: payload.modelVersion || "matching-v2",
  };
  await appendDecisionLogEntries([safe]).catch(() => {});
}

export async function handleGetFaceModelHealth(msg, ctx) {
  const childId = msg?.childId ? String(msg.childId) : null;
  const health = await getModelHealth(childId).catch(() => (childId ? null : {}));
  const holdout = await getHoldoutSet(childId).catch(() => (childId ? null : {}));
  return { ok: true, health, holdout };
}

export async function handleSetFaceHoldoutSet(msg, ctx) {
  const childId = String(msg?.childId || "");
  const keys = Array.isArray(msg?.keys) ? msg.keys.filter((k) => typeof k === "string") : [];
  if (!childId) return { ok: false, error: "No child selected." };
  const saved = await saveHoldoutSet(childId, { keys, sampleSize: keys.length, source: msg?.source || "manual" });
  return { ok: true, holdout: saved };
}

export async function handleGetDecisionAuditSummary(msg, ctx) {
  const childId = msg?.childId ? String(msg.childId) : null;
  const entries = await getDecisionLogEntries(1000).catch(() => []);
  const filtered = childId ? entries.filter((e) => String(e?.childId || "") === childId) : entries;
  const byDecision = filtered.reduce((acc, e) => {
    const k = String(e?.decision || "unknown");
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  return { ok: true, total: filtered.length, byDecision, latest: filtered.slice(Math.max(0, filtered.length - 10)) };
}

export async function handleRunRetentionMaintenance(msg, ctx) {
  const maxDecisionEntries = Math.max(1000, Number(msg?.maxDecisionEntries) || 25000);
  const negativeMaxAgeDays = Math.max(30, Number(msg?.negativeMaxAgeDays) || 365);
  const fingerprintMaxAgeDays = Math.max(30, Number(msg?.fingerprintMaxAgeDays) || 365);
  const decision = await rotateDecisionLog(maxDecisionEntries).catch(() => ({ total: 0, removed: 0 }));
  const face = await pruneAgedFaceData({ negativeMaxAgeDays, fingerprintMaxAgeDays }).catch(() => ({ negativePruned: 0, fingerprintsPruned: 0 }));
  await ctx.logger("INFO", `Retention maintenance complete: decision removed ${decision.removed || 0}, negative pruned ${face.negativePruned || 0}, fingerprints pruned ${face.fingerprintsPruned || 0}.`);
  return { ok: true, decision, face };
}

export async function handleSelfImproveFaceModel(msg, ctx) {
  const childId = String(msg.childId || "");
  if (!childId) return { ok: false, error: "No child selected." };
  const lock = await acquireJobLock(`face_self_improve_${childId}`, 20 * 60 * 1000);
  if (!lock?.ok) return { ok: false, error: "Self-improve is already running for this child." };

  try {
    const manifests = await getDownloadedStories(childId).catch(() => []);
    const byStoryUrl = new Map();
    for (const m of manifests) {
      const storyId = String(m?.storyId || "");
      if (!storyId) continue;
      const approved = new Set(Array.isArray(m?.approvedFilenames) ? m.approvedFilenames : []);
      const rejected = new Set(Array.isArray(m?.rejectedFilenames) ? m.rejectedFilenames : []);
      for (const mu of (m.mediaUrls || [])) {
        if (!mu?.filename || !mu?.originalUrl) continue;
        byStoryUrl.set(`${storyId}_${mu.originalUrl}`, {
          storyId,
          filename: mu.filename,
          childName: m.childName || "",
          folderName: m.folderName || "",
          storyDate: m.storyDate || "",
          title: m.title || "",
          description: m.excerpt || m.storyBody || "",
          isApproved: approved.has(mu.filename),
          isRejected: rejected.has(mu.filename),
        });
      }
    }

    const descData = await getDescriptors(childId).catch(() => null);
    const positive = Array.isArray(descData?.descriptors) ? descData.descriptors : [];
    if (positive.length === 0) {
      await releaseJobLock(`face_self_improve_${childId}`, { status: "failed", failedAt: new Date().toISOString(), error: "No face training data available for selected child." });
      return { ok: false, error: "No face training data available for selected child." };
    }
    const centroids = buildCentroids(descData?.descriptorsByYear || {});
    const negatives = await getNegativeDescriptors(childId).catch(() => []);
    const phase = await getChildPhase(childId).catch(() => ({ phase: 1 }));
    const { autoThreshold: userAuto = 85, minThreshold: userMin = 50 } = await chrome.storage.local.get(["autoThreshold", "minThreshold"]);
    let autoThreshold = userAuto;
    if (phase?.phase === 1) autoThreshold = 100;
    else if (phase?.phase === 2) autoThreshold = 95;

    const fps = await getChildFingerprints(childId).catch(() => []);
    const filteredFps = fps.filter((f) => Array.isArray(f?.faces) && f.faces.length > 0);

    let checked = 0;
    let recoveredRejected = 0;
    let reinforcedApproved = 0;
    let reviewedCandidates = 0;
    let holdoutChecked = 0;
    let holdoutPass = 0;
    const reinforceCap = 20;
    const holdout = await getHoldoutSet(childId).catch(() => null);
    const holdoutKeys = new Set(Array.isArray(holdout?.keys) ? holdout.keys : []);

    for (const fp of filteredFps) {
      checked++;
      const ref = byStoryUrl.get(`${String(fp.storyId || "")}_${String(fp.imageUrl || "")}`);
      if (!ref) continue;

      let best = null;
      for (const face of fp.faces) {
        if (!Array.isArray(face?.descriptor) || face.descriptor.length === 0) continue;
        const md = enhancedMatch(face.descriptor, positive, negatives, centroids);
        if (!best || md.effectiveScore > best.effectiveScore) {
          best = { ...md, descriptor: face.descriptor };
        }
      }
      if (!best) continue;

      if (ref.isRejected && best.effectiveScore >= Math.max(92, autoThreshold + 5) && best.rawNegative < userMin) {
        await removeRejection(ref.storyId, fp.imageUrl).catch(() => {});
        await markFilenameApprovedInManifest(childId, ref.storyId, ref.filename).catch(() => {});
        const childSafe = sanitizeName(ref.childName || msg.childName || "Child");
        const savePath = `Storypark Smart Saver/${childSafe}/Stories/${ref.folderName}/${ref.filename}`;
        await addPendingDownload({
          childId,
          childName: ref.childName || msg.childName || "Child",
          storyData: { storyId: ref.storyId, originalUrl: fp.imageUrl, createdAt: ref.storyDate, title: ref.title },
          savePath,
          description: ref.description || "",
        }).catch(() => {});
        recoveredRejected++;
        await _logFaceDecision({
          source: "self_improve",
          decision: "recover_rejected",
          childId,
          childName: ref.childName || msg.childName || "Child",
          storyId: ref.storyId,
          imageUrlHash: await _sha256Hex(fp.imageUrl),
          phase: phase?.phase || null,
          thresholds: { autoThreshold, minThreshold: userMin },
          scores: { effectiveScore: best.effectiveScore, rawNegative: best.rawNegative, consensus: best.consensus },
          reasonCode: "recovered_after_model_improve",
        });
        continue;
      }

      if (ref.isApproved && reinforcedApproved < reinforceCap && best.effectiveScore >= Math.max(97, autoThreshold + 10) && best.rawNegative < userMin) {
        const ry = ref.storyDate ? String(ref.storyDate).slice(0, 4) : "unknown";
        await appendDescriptor(childId, ref.childName || msg.childName || "Child", best.descriptor, ry || "unknown").catch(() => {});
        reinforcedApproved++;
        await _logFaceDecision({
          source: "self_improve",
          decision: "reinforce_approved",
          childId,
          childName: ref.childName || msg.childName || "Child",
          storyId: ref.storyId,
          imageUrlHash: await _sha256Hex(fp.imageUrl),
          phase: phase?.phase || null,
          thresholds: { autoThreshold, minThreshold: userMin },
          scores: { effectiveScore: best.effectiveScore, rawNegative: best.rawNegative, consensus: best.consensus },
          reasonCode: "high_confidence_reinforcement",
        });
        continue;
      }

      if (ref.isApproved && best.effectiveScore < Math.max(35, userMin - 5) && best.rawNegative >= userMin) {
        await addToReviewQueue({
          childId,
          childName: ref.childName || msg.childName || "Child",
          descriptor: best.descriptor,
          noFace: false,
          matchPct: best.effectiveScore,
          storyData: {
            storyId: ref.storyId,
            originalUrl: fp.imageUrl,
            createdAt: ref.storyDate,
            title: ref.title,
          },
          savePath: `Storypark Smart Saver/${sanitizeName(ref.childName || msg.childName || "Child")}/Stories/${ref.folderName}/${ref.filename}`,
          description: ref.description || "",
        }).catch(() => {});
        reviewedCandidates++;
        await _logFaceDecision({
          source: "self_improve",
          decision: "requeue_review",
          childId,
          childName: ref.childName || msg.childName || "Child",
          storyId: ref.storyId,
          imageUrlHash: await _sha256Hex(fp.imageUrl),
          phase: phase?.phase || null,
          thresholds: { autoThreshold, minThreshold: userMin },
          scores: { effectiveScore: best.effectiveScore, rawNegative: best.rawNegative, consensus: best.consensus },
          reasonCode: "confidence_drop_requires_review",
        });
      }

      const holdoutKey = `${String(fp.storyId || "")}_${String(fp.imageUrl || "")}`;
      if (holdoutKeys.has(holdoutKey)) {
        holdoutChecked++;
        if (best.effectiveScore >= autoThreshold && best.rawNegative < userMin) holdoutPass++;
      }
    }

    if (reinforcedApproved > 0) {
      await ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
    }
    if (reviewedCandidates > 0) {
      chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    }

    await ctx.logger(
      "INFO",
      `Face self-improve completed for ${msg.childName || "child"}: checked ${checked}, recovered ${recoveredRejected} rejected, reinforced ${reinforcedApproved} approved, queued ${reviewedCandidates} review candidates.`
    );

    const validationPrecision = checked > 0 ? Number(((reinforcedApproved + recoveredRejected) / checked).toFixed(4)) : 0;
    const holdoutPrecision = holdoutChecked > 0 ? Number((holdoutPass / holdoutChecked).toFixed(4)) : null;
    await saveModelHealth(childId, {
      childName: msg.childName || "",
      lastSelfImproveAt: new Date().toISOString(),
      phase: phase?.phase || null,
      descriptorCount: positive.length,
      negativeDescriptorCount: negatives.length,
      checked,
      recoveredRejected,
      reinforcedApproved,
      reviewedCandidates,
      confidenceTrend: validationPrecision,
      holdoutChecked,
      holdoutPass,
      holdoutPrecision,
      thresholds: { autoThreshold, minThreshold: userMin },
    }).catch(() => {});

    await releaseJobLock(`face_self_improve_${childId}`, {
      status: "completed",
      completedAt: new Date().toISOString(),
      stats: { checked, recoveredRejected, reinforcedApproved, reviewedCandidates, validationPrecision, holdoutPrecision },
    }).catch(() => {});

    return {
      ok: true,
      checked,
      recoveredRejected,
      reinforcedApproved,
      reviewedCandidates,
      validationPrecision,
      holdoutChecked,
      holdoutPass,
      holdoutPrecision,
    };
  } catch (err) {
    await releaseJobLock(`face_self_improve_${childId}`, {
      status: "failed",
      failedAt: new Date().toISOString(),
      error: err.message,
    }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

export async function handleRunInitialFaceBootstrap(msg, ctx) {
  const childId = String(msg?.childId || "");
  const childName = String(msg?.childName || "");
  if (!childId) return { ok: false, error: "No child selected." };
  const lock = await acquireJobLock(`face_bootstrap_${childId}`, 20 * 60 * 1000);
  if (!lock?.ok) return { ok: false, error: "Bootstrap already running." };
  try {
    const fps = await getChildFingerprints(childId).catch(() => []);
    const filteredFps = fps.filter((f) => Array.isArray(f?.faces) && f.faces.length > 0);
    const manifests = await getDownloadedStories(childId).catch(() => []);
    const map = new Map();
    for (const m of manifests) {
      for (const mu of (m.mediaUrls || [])) {
        if (mu?.originalUrl && mu?.filename) {
          map.set(`${m.storyId}_${mu.originalUrl}`, { manifest: m, filename: mu.filename });
        }
      }
    }
    const holdoutTarget = Math.min(200, Math.max(20, Math.floor(filteredFps.length * 0.1)));
    const holdoutKeys = [];
    let seededPositive = 0;
    let queuedReview = 0;
    for (const fp of filteredFps) {
      const key = `${String(fp.storyId || "")}_${String(fp.imageUrl || "")}`;
      const ref = map.get(key);
      if (!ref) continue;
      if (holdoutKeys.length < holdoutTarget) holdoutKeys.push(key);
      const descriptor = fp.faces?.[0]?.descriptor;
      if (!Array.isArray(descriptor) || descriptor.length === 0) continue;
      const isRejected = (ref.manifest?.rejectedFilenames || []).includes(ref.filename);
      if (isRejected) continue;
      if ((ref.manifest?.approvedFilenames || []).includes(ref.filename)) {
        const year = ref.manifest?.storyDate ? String(ref.manifest.storyDate).slice(0, 4) : "unknown";
        await appendDescriptor(childId, childName || ref.manifest.childName || "Child", descriptor, year).catch(() => {});
        seededPositive++;
        if (seededPositive > 1000) break;
      } else {
        await addToReviewQueue({
          childId,
          childName: childName || ref.manifest.childName || "Child",
          descriptor,
          noFace: false,
          matchPct: 0,
          storyData: { storyId: ref.manifest.storyId, originalUrl: fp.imageUrl, createdAt: ref.manifest.storyDate, title: ref.manifest.title },
          savePath: `Storypark Smart Saver/${sanitizeName(ref.manifest.childName || childName || "Child")}/Stories/${ref.manifest.folderName}/${ref.filename}`,
          description: ref.manifest.excerpt || "",
        }).catch(() => {});
        queuedReview++;
      }
    }
    await saveHoldoutSet(childId, { keys: holdoutKeys, source: "bootstrap", sampleSize: holdoutKeys.length });
    await saveModelHealth(childId, {
      childName,
      lastBootstrapAt: new Date().toISOString(),
      bootstrapFingerprints: filteredFps.length,
      seededPositive,
      queuedReview,
      holdoutCount: holdoutKeys.length,
    });
    await releaseJobLock(`face_bootstrap_${childId}`, {
      status: "completed",
      completedAt: new Date().toISOString(),
      stats: { fingerprints: filteredFps.length, seededPositive, queuedReview, holdoutCount: holdoutKeys.length },
    });
    await ctx.logger("INFO", `Initial Face AI build completed for ${childName || "child"}: ${seededPositive} seeded, ${queuedReview} queued, ${holdoutKeys.length} holdout.`);
    return { ok: true, fingerprints: filteredFps.length, seededPositive, queuedReview, holdoutCount: holdoutKeys.length };
  } catch (err) {
    await releaseJobLock(`face_bootstrap_${childId}`, { status: "failed", error: err.message, failedAt: new Date().toISOString() }).catch(() => {});
    return { ok: false, error: err.message };
  }
}
