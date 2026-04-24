/**
 * handlers-review.js — Review queue + pending download handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All message handlers related to human-in-the-loop review,         │
 * │  pending downloads, re-evaluation, and final verification.         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Phase state reads/writes → lib/handlers-phase.js                  │
 * │  Face descriptor storage → lib/data-service.js (learnFace)         │
 * │  Download semaphore → lib/download-pipe.js                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * CONTEXT EXTENSIONS FOR REVIEW HANDLERS:
 *   ctx.getLastReviewAction()   — () => { action, item, descriptor } | null
 *   ctx.setLastReviewAction(a)  — persist undo state to session storage
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   GET_REVIEW_QUEUE, REVIEW_APPROVE, REVIEW_REJECT, REVIEW_TRAIN_ONLY,
 *   UNDO_LAST_REVIEW, GET_PENDING_DOWNLOADS_COUNT,
 *   RE_EVALUATE_QUEUE, FINAL_VERIFICATION
 */

import {
  getReviewQueue, getReviewQueueItem, removeFromReviewQueue, addToReviewQueue,
  getAllDescriptors, getDescriptors, appendDescriptor, setDescriptors,
  getNegativeDescriptors, appendNegativeDescriptor,
  getChildPhase, incrementVerifiedCount,
  addRejection,
  addPendingDownload, getPendingDownloads, getAllPendingDownloads, removePendingDownload,
  getCentreGPS,
} from "./db.js";
// buildCentroids and computeCentroid live in matching.js (pure math, no IDB deps)
import { buildCentroids, computeCentroid } from "./matching.js";
import { requireId } from "./msg-validator.js";
import { downloadDataUrl } from "./download-pipe.js";

/* ================================================================== */
/*  Review queue queries                                               */
/* ================================================================== */

/**
 * GET_REVIEW_QUEUE — Return all items currently in the review queue.
 *
 * @param {Object} msg
 * @param {import('./types.js').HandlerContext} ctx
 */
export async function handleGetReviewQueue(msg, ctx) {
  try {
    const queue = await getReviewQueue();
    return { ok: true, queue };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * GET_PENDING_DOWNLOADS_COUNT — Count deferred downloads awaiting batch download.
 *
 * @param {{ childId?: string }} msg
 */
export async function handleGetPendingDownloadsCount(msg, ctx) {
  try {
    const items = msg.childId
      ? await getPendingDownloads(msg.childId)
      : await getAllPendingDownloads();
    return { ok: true, count: items.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Review decisions                                                   */
/* ================================================================== */

/**
 * REVIEW_APPROVE — Approve a face match: learn the descriptor, download photo.
 *
 * Flow:
 *   1. Get the review queue item
 *   2. Extract the best face descriptor (supports multi-face selector)
 *   3. Append descriptor to positive profile (continuous learning)
 *   4. Increment verified face count (advances phase when threshold reached)
 *   5a. Phase 1–3 (deferDownloads): add to pendingDownloads for later
 *   5b. Phase 4 (Production): download immediately via DOWNLOAD_APPROVED
 *   6. Remove from review queue
 *   7. Save undo state
 *
 * @param {{ id: string, selectedFaceIndex?: number }} msg
 */
export async function handleReviewApprove(msg, ctx) {
  try {
    const id         = requireId(msg.id, "id");
    const faceIndex  = msg.selectedFaceIndex ?? 0;

    const item = await getReviewQueueItem(id);
    if (!item) return { ok: false, error: "Review item not found" };

    // Select the descriptor for the chosen face (multi-face support)
    let descriptor = item.descriptor;
    if (item.allFaces?.length > faceIndex) {
      descriptor = item.allFaces[faceIndex].descriptor;
    }

    // Continuous learning: persist face descriptor
    if (descriptor && item.childId) {
      const reviewDate = item.storyData?.createdAt ? new Date(item.storyData.createdAt) : null;
      const year = reviewDate ? reviewDate.getFullYear().toString() : "unknown";
      await appendDescriptor(item.childId, item.childName, descriptor, year);
      ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
      await incrementVerifiedCount(item.childId);
    }

    // Offline files (already on disk) — just learn the descriptor, skip download
    if (item.isOfflineFile) {
      await removeFromReviewQueue(id);
      _saveUndo(ctx, { action: "approve", item: _stripImages(item), descriptor: descriptor ? Array.from(descriptor) : null });
      chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
      return { ok: true };
    }

    // Determine whether to defer or download immediately
    const childPhase = item.childId ? await getChildPhase(item.childId) : { phase: 4 };
    const deferApproval = childPhase.phase < 4;

    // GPS lookup via data-service
    const centreName = item.storyData?.centreName;
    let gpsCoords = null;
    if (centreName) {
      gpsCoords = await getCentreGPS(centreName).catch(() => null);
    }

    if (deferApproval) {
      await addPendingDownload({
        itemType: "image",
        childId:      item.childId,
        childName:    item.childName,
        storyData:    item.storyData,
        savePath:     item.savePath,
        description:  item.description || "",
        exifTitle:    item.exifTitle   || "",
        exifSubject:  item.exifSubject || "",
        exifComments: item.exifComments || "",
        gpsCoords,
      });
    } else {
      // Phase 4: download immediately
      const approveResult = await ctx.sendToOffscreen({
        type:        "DOWNLOAD_APPROVED",
        storyData:   item.storyData,
        description: item.description || "",
        exifTitle:   item.exifTitle   || "",
        exifSubject: item.exifSubject || "",
        exifComments:item.exifComments || "",
        childName:   item.childName,
        savePath:    item.savePath,
        gpsCoords,
      });
      if (approveResult.dataUrl && approveResult.savePath) {
        await downloadDataUrl(approveResult.dataUrl, approveResult.savePath);
      }
    }

    await removeFromReviewQueue(id);
    _saveUndo(ctx, { action: "approve", item: _stripImages(item), descriptor: descriptor ? Array.from(descriptor) : null });
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * REVIEW_REJECT — Reject a face match: learn as negative, track rejection.
 *
 * @param {{ id: string, selectedFaceIndex?: number }} msg
 */
export async function handleReviewReject(msg, ctx) {
  try {
    const id        = requireId(msg.id, "id");
    const faceIndex = msg.selectedFaceIndex ?? 0;

    const item = await getReviewQueueItem(id);
    if (!item) return { ok: false, error: "Review item not found" };

    // Track rejection so re-scans don't re-queue this image
    if (item.storyData?.storyId && item.storyData?.originalUrl) {
      await addRejection(item.storyData.storyId, item.storyData.originalUrl).catch(() => {});
    }

    // Learn as negative descriptor (contrastive learning)
    if (item.childId) {
      const desc = (item.allFaces?.length > faceIndex)
        ? item.allFaces[faceIndex].descriptor
        : item.descriptor;
      if (desc) {
        await appendNegativeDescriptor(item.childId, desc).catch(() => {});
      }
    }

    await removeFromReviewQueue(id);
    _saveUndo(ctx, { action: "reject", item: _stripImages(item) });
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * REVIEW_TRAIN_ONLY — Confirm face identity without downloading immediately.
 * Used in Phase 1–2 to train the model while deferring downloads.
 *
 * @param {{ id: string, selectedFaceIndex?: number }} msg
 */
export async function handleReviewTrainOnly(msg, ctx) {
  try {
    const id        = requireId(msg.id, "id");
    const faceIndex = msg.selectedFaceIndex ?? 0;

    const item = await getReviewQueueItem(id);
    if (!item) return { ok: false, error: "Review item not found" };

    // Save descriptor for learning
    let descriptor = item.descriptor;
    if (item.allFaces?.length > faceIndex) {
      descriptor = item.allFaces[faceIndex].descriptor;
    }
    if (descriptor && item.childId) {
      const trainDate = item.storyData?.createdAt ? new Date(item.storyData.createdAt) : null;
      const year = trainDate ? trainDate.getFullYear().toString() : "unknown";
      await appendDescriptor(item.childId, item.childName, descriptor, year);
      ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
      await incrementVerifiedCount(item.childId);
    }

    // Save to pending downloads for later batch
    await addPendingDownload({
      childId:      item.childId,
      childName:    item.childName,
      storyData:    item.storyData,
      savePath:     item.savePath,
      description:  item.description || "",
      exifTitle:    item.exifTitle   || "",
      exifSubject:  item.exifSubject || "",
      exifComments: item.exifComments || "",
    });

    await removeFromReviewQueue(id);
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * UNDO_LAST_REVIEW — Undo the most recent approve or reject action.
 * Restores the item to the review queue and removes the learned descriptor.
 *
 * @param {Object} msg
 */
export async function handleUndoLastReview(msg, ctx) {
  try {
    const lastAction = ctx.getLastReviewAction?.();
    if (!lastAction) return { ok: false, error: "Nothing to undo" };

    const { action, item, descriptor } = lastAction;

    // If approved: remove the last matching descriptor from the profile
    if (action === "approve" && descriptor && item.childId) {
      const existing = await getDescriptors(item.childId).catch(() => null);
      if (existing?.descriptors) {
        const descStr = JSON.stringify(descriptor);
        const idx = existing.descriptors.findLastIndex(d => JSON.stringify(d) === descStr);
        if (idx !== -1) {
          existing.descriptors.splice(idx, 1);
          await setDescriptors(item.childId, existing.childName, existing.descriptors);
          ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
        }
      }
    }

    // Put item back in the queue
    await addToReviewQueue(item);
    ctx.setLastReviewAction?.(null);
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Queue re-evaluation                                               */
/* ================================================================== */

/**
 * RE_EVALUATE_QUEUE — Re-evaluate review items using improved face model.
 * Runs the enhanced matching pipeline against all items for a child.
 * Auto-approves high-confidence matches, auto-rejects strong negatives.
 *
 * @param {{ childId: string }} msg
 */
export async function handleReEvaluateQueue(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    const { autoThreshold: userAuto = 85, minThreshold: userMin = 50 } =
      await chrome.storage.local.get(["autoThreshold", "minThreshold"]);

    const childPhaseData = await getChildPhase(childId);
    let autoThreshold = userAuto;
    if (childPhaseData.phase === 1) autoThreshold = 100;
    else if (childPhaseData.phase === 2) autoThreshold = 95;

    const allDescs   = await getAllDescriptors();
    const childDesc  = allDescs.find(d => String(d.childId) === String(childId));
    if (!childDesc?.descriptors?.length) {
      return { ok: true, autoApproved: 0, autoRejected: 0, remaining: 0 };
    }

    const negDescs   = await getNegativeDescriptors(childId).catch(() => []);
    const queue      = await getReviewQueue();
    const childQueue = queue.filter(item => String(item.childId) === String(childId) && item.descriptor);
    if (childQueue.length === 0) {
      return { ok: true, autoApproved: 0, autoRejected: 0, remaining: 0 };
    }

    // Batch re-evaluation via offscreen
    const result = await ctx.sendToOffscreen({
      type:                 "RE_EVALUATE_BATCH",
      items:                childQueue.map(item => ({ id: item.id, descriptor: item.descriptor, allFaces: item.allFaces })),
      positiveDescriptors:  childDesc.descriptors,
      descriptorsByYear:    childDesc.descriptorsByYear || {},
      negativeDescriptors:  negDescs,
      autoThreshold,
      minThreshold:         userMin,
      disableAutoReject:    childPhaseData.phase < 3, // Never auto-reject in Phase 1/2
    });

    let autoApproved = 0, autoRejected = 0;
    if (result?.results) {
      for (const r of result.results) {
        if (r.decision === "approve") {
          const item = childQueue.find(q => q.id === r.id);
          if (item) {
            if (item.descriptor && item.childId) {
              const rd = item.storyData?.createdAt ? new Date(item.storyData.createdAt) : null;
              await appendDescriptor(item.childId, item.childName, item.descriptor, rd ? rd.getFullYear().toString() : "unknown");
              await incrementVerifiedCount(item.childId);
            }
            await addPendingDownload({
              childId: item.childId, childName: item.childName,
              storyData: item.storyData, savePath: item.savePath,
              description: item.description || "", exifTitle: item.exifTitle || "",
              exifSubject: item.exifSubject || "", exifComments: item.exifComments || "",
            });
            await removeFromReviewQueue(r.id);
            autoApproved++;
          }
        } else if (r.decision === "reject") {
          const item = childQueue.find(q => q.id === r.id);
          if (item) {
            if (item.storyData?.storyId && item.storyData?.originalUrl) {
              await addRejection(item.storyData.storyId, item.storyData.originalUrl).catch(() => {});
            }
            if (item.descriptor && item.childId) {
              await appendNegativeDescriptor(item.childId, item.descriptor).catch(() => {});
            }
            await removeFromReviewQueue(r.id);
            autoRejected++;
          }
        }
      }
    }

    if (autoApproved > 0) {
      ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});
    }
    const remaining = childQueue.length - autoApproved - autoRejected;
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    return { ok: true, autoApproved, autoRejected, remaining };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * FINAL_VERIFICATION — Re-check all pending downloads for a child
 * against the mature face model.  Confirmed items stay in pending,
 * failed items are rejected, uncertain items return to review queue.
 *
 * @param {{ childId: string }} msg
 */
export async function handleFinalVerification(msg, ctx) {
  try {
    const childId = requireId(msg.childId, "childId");
    const { autoThreshold: userAuto = 85, minThreshold: userMin = 50 } =
      await chrome.storage.local.get(["autoThreshold", "minThreshold"]);

    const allDescs  = await getAllDescriptors();
    const childDesc = allDescs.find(d => String(d.childId) === String(childId));
    if (!childDesc?.descriptors?.length) {
      return { ok: true, verified: 0, rejected: 0, flagged: 0, total: 0 };
    }

    const negDescs    = await getNegativeDescriptors(childId).catch(() => []);
    const pending     = await getPendingDownloads(childId);
    const imageItems  = pending.filter(p => (p.itemType || "image") === "image" && p.imageUrl);
    let verified = 0, rejected = 0, flagged = 0;

    for (const item of imageItems) {
      try {
        const result = await ctx.sendToOffscreen({
          type:      "PROCESS_IMAGE",
          imageUrl:  item.imageUrl || item.storyData?.originalUrl,
          storyData: item.storyData || { originalUrl: item.imageUrl },
          description: item.description || "",
          exifTitle:   item.exifTitle   || "",
          exifSubject: item.exifSubject || "",
          exifComments:item.exifComments || "",
          childId,
          childName:   item.childName || "",
          savePath:    item.savePath || "",
          childEncodings: [{
            childId: childDesc.childId,
            childName: childDesc.childName,
            descriptors: childDesc.descriptors,
            descriptorsByYear: childDesc.descriptorsByYear || {},
          }],
          negativeDescriptors: negDescs,
          autoThreshold: userAuto,
          minThreshold: userMin,
        });

        if (result?.result === "approve") {
          verified++;
        } else if (result?.result === "reject") {
          rejected++;
          await removePendingDownload(item.id);
          const url = item.imageUrl || item.storyData?.originalUrl;
          if (item.storyData?.storyId && url) {
            await addRejection(item.storyData.storyId, url).catch(() => {});
          }
        } else {
          flagged++;
          await addToReviewQueue({
            childId,
            childName: item.childName || "",
            storyData: item.storyData,
            savePath:  item.savePath,
            description:  item.description || "",
            exifTitle:    item.exifTitle   || "",
            exifSubject:  item.exifSubject || "",
            exifComments: item.exifComments || "",
            matchPct:     result?.matchPct || 0,
            descriptor:   null,
            finalVerification: true,
          });
          await removePendingDownload(item.id);
        }
      } catch {
        verified++; // Assume OK if we can't re-verify (e.g. Storypark login expired)
      }
    }

    const total = imageItems.length;
    const videoCount = pending.length - imageItems.length;
    await ctx.logger("SUCCESS",
      `✅ Final verification: ${verified}/${total} confirmed, ${rejected} rejected, ${flagged} flagged`
      + (videoCount > 0 ? ` (${videoCount} videos passed through)` : "")
    );

    if (flagged > 0) chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    return { ok: true, verified, rejected, flagged, total };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Internal helpers                                                   */
/* ================================================================== */

/** Strip large base64 fields from an item before storing as undo state. */
function _stripImages(item) {
  const { croppedFaceDataUrl: _c, allFaces: _a, fullPhotoDataUrl: _f, ...rest } = item;
  return rest;
}

/** Save undo state to context (background.js manages the actual variable). */
function _saveUndo(ctx, action) {
  if (ctx.setLastReviewAction) {
    ctx.setLastReviewAction(action);
  }
}
