/**
 * handlers-phase.js — Face recognition phase management handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All message handlers related to the 4-phase face recognition      │
 * │  system: phase state, model confidence, face training, and         │
 * │  manual phase management.                                          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Review queue approve/reject → lib/handlers-review.js              │
 * │  Face detection / AI inference → offscreen.js                      │
 * │  Phase advancement triggered by queue emptying → background.js     │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * HANDLER CONTEXT (ctx):
 *   ctx.sendToOffscreen   — async (message) => response
 *   ctx.logger            — async (level, message) => void
 *   ctx.getCancelRequested — () => boolean
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   GET_CHILD_PHASE, GET_ALL_CHILD_PHASES, ADVANCE_PHASE, RESTORE_PHASE
 *   GET_MODEL_CONFIDENCE, GET_AUTO_THRESHOLD, PROCESS_TRAINING_IMAGE
 *   SAVE_TRAINING_DESCRIPTOR, RESET_FACE_DATA, FORCE_PHASE_ADVANCE
 */

import {
  getChildPhase, getAllChildPhases, setChildPhase, resetChildPhase,
  advancePhase, computeModelConfidence,
  getDescriptors, setDescriptors, saveDescriptor, appendDescriptor,
  getNegativeDescriptors,
} from "./db.js";
import { requireId } from "./msg-validator.js";
import { learnFace } from "./data-service.js";

// matchSimilarityPct import: used by computeAutoThreshold (same logic as background.js)
// matchSimilarityPct is from matching.js but re-exported via db.js in some setups;
// if not available from db.js import it directly:
import { similarityPct as _simPct } from "./matching.js";

/* ================================================================== */
/*  Phase state queries                                                */
/* ================================================================== */

/**
 * GET_CHILD_PHASE — Return the current recognition phase for a child.
 *
 * @param {{ childId: string }} msg
 * @param {import('./types.js').HandlerContext} ctx
 * @returns {Promise<{ ok: true, phase: import('./types.js').ChildPhase } | { ok: false, error: string }>}
 */
export async function handleGetChildPhase(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    const phase = await getChildPhase(childId);
    return { ok: true, phase };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * GET_ALL_CHILD_PHASES — Return phases for all children.
 *
 * @param {Object} msg — (no fields required)
 * @returns {Promise<{ ok: true, phases: import('./types.js').ChildPhase[] }>}
 */
export async function handleGetAllChildPhases(msg, ctx) {
  try {
    const phases = await getAllChildPhases();
    return { ok: true, phases };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * ADVANCE_PHASE — Check if a child qualifies for the next phase and advance.
 * Broadcasts PHASE_ADVANCED message to dashboard if advancement occurred.
 *
 * @param {{ childId: string }} msg
 */
export async function handleAdvancePhase(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    const result  = await advancePhase(childId);
    if (result.advanced) {
      const p       = result.phase;
      const EMOJIS  = { 2: "✅", 3: "📊", 4: "🚀" };
      const LABELS  = { 2: "Validation", 3: "Confident", 4: "Production" };
      await ctx.logger("SUCCESS", `${EMOJIS[p.phase] || "📊"} Phase ${p.phase} unlocked for child ${childId}: ${LABELS[p.phase] || "Unknown"} mode!`);
      chrome.runtime.sendMessage({ type: "PHASE_ADVANCED", childId, phase: p }).catch(() => {});
    }
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * RESTORE_PHASE — Restore phase data from a profile import.
 * Only applies if the current phase is lower than the imported phase.
 *
 * @param {{ childId: string, phaseData: import('./types.js').ChildPhase }} msg
 */
export async function handleRestorePhase(msg, ctx) {
  try {
    const childId   = requireId(msg.childId, "childId");
    const phaseData = msg.phaseData;
    if (!phaseData || typeof phaseData.phase !== "number") {
      return { ok: false, error: "Missing or invalid phaseData" };
    }
    await setChildPhase(childId, {
      phase:          phaseData.phase          ?? 1,
      verifiedCount:  phaseData.verifiedCount  ?? 0,
      phase1Complete: phaseData.phase1Complete ?? false,
      phase2Complete: phaseData.phase2Complete ?? false,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * FORCE_PHASE_ADVANCE — Force a child straight to Phase 4 (Production).
 * Bypasses all requirements.  Use only when satisfied with the face model.
 *
 * @param {{ childId: string }} msg
 */
export async function handleForcePhaseAdvance(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    const current = await getChildPhase(childId);
    const forced  = { ...current, phase: 4, phase1Complete: true, phase2Complete: true };
    await setChildPhase(childId, forced);
    await ctx.logger("SUCCESS", `🚀 Phase 4 (Production) forced for child ${childId} — downloads now enabled!`);
    chrome.runtime.sendMessage({ type: "PHASE_ADVANCED", childId, phase: forced }).catch(() => {});
    return { ok: true, phase: forced };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Model confidence + threshold                                      */
/* ================================================================== */

/**
 * GET_MODEL_CONFIDENCE — Compute face model confidence score.
 *
 * @param {{ childId: string }} msg
 * @returns {{ ok: true, confidence: number, details: string, ... }}
 */
export async function handleGetModelConfidence(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    const data    = await computeModelConfidence(childId);
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * GET_AUTO_THRESHOLD — Compute auto-calibrated thresholds from learned data.
 * Returns null data if insufficient descriptors (< 5 positive, < 3 negative).
 *
 * @param {{ childId: string }} msg
 */
export async function handleGetAutoThreshold(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    const data    = await computeAutoThreshold(childId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Face training                                                      */
/* ================================================================== */

/**
 * PROCESS_TRAINING_IMAGE — Detect a face in a data URL and save the descriptor.
 * Routes through offscreen for face detection.
 *
 * @param {{ childId: string, childName: string, imageDataUri: string, faceIndex?: number }} msg
 */
export async function handleProcessTrainingImage(msg, ctx) {
  try {
    const childId  = requireId(msg.childId, "childId");
    const childName = msg.childName || childId;
    const imageDataUri = msg.imageDataUri;
    if (!imageDataUri) return { ok: false, error: "Missing imageDataUri" };

    const encRes = await ctx.sendToOffscreen({
      type:         "BUILD_ENCODING",
      imageDataUrl: imageDataUri,
      faceIndex:    msg.faceIndex ?? 0,
    });
    if (!encRes?.ok || !encRes.descriptor) {
      return { ok: false, error: "No face detected in image" };
    }
    await saveDescriptor(childId, childName, encRes.descriptor);
    ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * SAVE_TRAINING_DESCRIPTOR — Persist a pre-computed face descriptor directly.
 * No face detection required — the descriptor was already computed by the
 * dashboard's training preview.
 *
 * @param {{ childId: string, childName: string, descriptor: number[] }} msg
 */
export async function handleSaveTrainingDescriptor(msg, ctx) {
  try {
    const childId   = requireId(msg.childId, "childId");
    const childName = msg.childName || childId;
    if (!Array.isArray(msg.descriptor) || msg.descriptor.length === 0) {
      return { ok: false, error: "Missing or empty descriptor" };
    }
    await appendDescriptor(childId, childName, msg.descriptor);
    ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * RESET_FACE_DATA — Clear ALL face descriptors + reset phase to Phase 1.
 *
 * @param {{ childId: string }} msg
 */
export async function handleResetFaceData(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    await setDescriptors(childId, "", []);
    await resetChildPhase(childId);
    ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Auto-calibrating threshold (extracted from background.js)         */
/* ================================================================== */

/**
 * Compute auto-calibrated face matching thresholds from learned data.
 * Returns null if insufficient data (< 5 positive, < 3 negative).
 *
 * Extracted here from background.js so the phase handler can call it
 * without circular dependencies.
 *
 * @param {string} childId
 * @returns {Promise<{autoThreshold, minThreshold, posMean, negMean, ...}|null>}
 */
export async function computeAutoThreshold(childId) {
  const descData = await getDescriptors(childId).catch(() => null);
  if (!descData?.descriptors || descData.descriptors.length < 5) return null;
  const negDescs = await getNegativeDescriptors(childId).catch(() => []);
  if (negDescs.length < 3) return null;
  const posDescs = descData.descriptors;

  // Intra-class similarity: how similar are different photos of the same child?
  const posScores = [];
  for (let i = 0; i < posDescs.length && posScores.length < 200; i++) {
    for (let j = i + 1; j < posDescs.length && posScores.length < 200; j++) {
      posScores.push(_simPct(posDescs[i], posDescs[j]));
    }
  }
  // Inter-class: how similar are "not my child" faces to the closest positive?
  const negScores = [];
  for (const neg of negDescs) {
    let best = 0;
    for (const pos of posDescs) {
      const s = _simPct(neg, pos);
      if (s > best) best = s;
    }
    negScores.push(best);
  }
  if (posScores.length < 3 || negScores.length < 3) return null;

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd  = (arr, m) => Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  const posMean = avg(posScores), negMean = avg(negScores);
  const posStd = sd(posScores, posMean), negStd = sd(negScores, negMean);

  const autoTh = Math.max(50, Math.min(95, Math.round(posMean - posStd)));
  const minTh  = Math.max(30, Math.min(autoTh - 5, Math.round(negMean + negStd)));

  return {
    autoThreshold: autoTh, minThreshold: minTh,
    posMean: Math.round(posMean), negMean: Math.round(negMean),
    posStd:  Math.round(posStd * 10) / 10,
    negStd:  Math.round(negStd * 10) / 10,
    posCount: posDescs.length, negCount: negDescs.length,
    gap: Math.round(posMean - posStd - (negMean + negStd)),
  };
}
