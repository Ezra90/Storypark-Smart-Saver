/**
 * dashboard-review.js — Review Tab UI Module
 * 
 * ┌─ WHAT THIS FILE OWNS ─┐
 * │ • Review queue grid rendering                              │
 * │ • Approve / Reject / Undo buttons                          │
 * │ • Face selector UI for multi-face photos                   │
 * │ • Lightbox (full-size image preview)                       │
 * │ • Batch download + build HTML buttons                      │
 * │ • Auto re-evaluation trigger                               │
 * │ • Keyboard shortcuts (A/R/Z)                               │
 * └─────────────────────────────────────────────────────────────┘
 */

import { loadModels, detectFaces } from "./lib/face.js";
import { appendDescriptor, appendNegativeDescriptor, addRejection } from "./lib/db.js";
import { getLinkedFolder, restoreFromRejected, moveFileToRejected, deleteFile } from "./lib/disk-sync.js";

const $reviewGrid = document.getElementById("reviewGrid");
const $reviewEmpty = document.getElementById("reviewEmpty");
const $reviewCount = document.getElementById("reviewCount");
const $btnUndo = document.getElementById("btnUndo");
const $btnRefreshR = document.getElementById("btnRefreshReview");
const $btnBatch = document.getElementById("btnBatchDownload");
const $btnBuildHtml = document.getElementById("btnBuildHtml");
const $btnFinalV = document.getElementById("btnFinalVerify");
const $lightbox = document.getElementById("lightbox");
const $lbImg = document.getElementById("lightboxImg");
const $reviewBadge = document.getElementById("reviewBadge");

let reviewQueue = [];
const selectedFace = new Map();
const childPhaseCache = new Map();
const REVIEW_PAGE_SIZE = 10;
let _reviewPageStart = 0;
let _pendingNewCount = 0;
let _totalAutoResolved = 0;
const $reviewStatus = document.getElementById("reviewStatusBar");
const $reviewStatusText = document.getElementById("reviewStatusText");

const MAX_LIGHTBOX_CACHE = 15;
const _fullImageCache = new Map();

let _reviewsSinceReEval = 0;
const RE_EVAL_AFTER_N_REVIEWS = 10;
let _reEvalRunning = false;
let _queueUpdateDebounceTimer = null;
let _localActionInProgress = false;

export function initReviewTab(helpers) {
  const { send, toast, formatDate } = helpers;

  function openLightbox(thumbnailSrc, originalUrl) {
    if (!thumbnailSrc && !originalUrl) return;
    $lbImg.src = thumbnailSrc || "";
    $lightbox.classList.add("open");

    if (originalUrl) {
      if (_fullImageCache.has(originalUrl)) {
        $lbImg.src = _fullImageCache.get(originalUrl);
        return;
      }
      $lbImg.style.opacity = "0.6";
      fetch(originalUrl, { credentials: "include" })
        .then(res => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.blob();
        })
        .then(blob => {
          const blobUrl = URL.createObjectURL(blob);
          if (_fullImageCache.size >= MAX_LIGHTBOX_CACHE) {
            const oldestKey = _fullImageCache.keys().next().value;
            URL.revokeObjectURL(_fullImageCache.get(oldestKey));
            _fullImageCache.delete(oldestKey);
          }
          _fullImageCache.set(originalUrl, blobUrl);
          if ($lightbox.classList.contains("open")) {
            $lbImg.src = blobUrl;
            $lbImg.style.opacity = "1";
          }
        })
        .catch(() => {
          $lbImg.style.opacity = "1";
        });
    }
  }

  $lightbox?.addEventListener("click", () => {
    $lightbox.classList.remove("open");
    $lbImg.src = "";
    $lbImg.style.opacity = "1";
  });

  function updateReviewStatus() {
    if (!$reviewStatus || !$reviewStatusText) return;
    const parts = [];
    const total = reviewQueue.length;
    if (total > REVIEW_PAGE_SIZE) {
      const end = Math.min(_reviewPageStart + REVIEW_PAGE_SIZE, total);
      parts.push(`📋 Showing ${_reviewPageStart + 1}–${end} of ${total}`);
    }
    if (_pendingNewCount > 0) {
      parts.push(`⏳ ${_pendingNewCount} new items queued`);
    }
    if (_totalAutoResolved > 0) {
      parts.push(`🧠 ${_totalAutoResolved} auto-resolved by AI`);
    }
    if (parts.length > 0) {
      $reviewStatus.style.display = "flex";
      $reviewStatusText.textContent = parts.join(" · ");
    } else {
      $reviewStatus.style.display = "none";
    }
  }

  function buildCardElement(item) {
    const faceIdx = selectedFace.get(item.id) ?? 0;
    const card = document.createElement("div");
    card.className = "review-card";
    card.dataset.id = item.id;

    const imgCol = document.createElement("div");
    imgCol.className = "card-image";

    const fullSrc = item.fullPhotoDataUrl || "";
    const faceSrc = item.allFaces?.[faceIdx]?.croppedDataUrl || item.croppedFaceDataUrl || "";
    const mainSrc = fullSrc || faceSrc;

    const mainImg = document.createElement("img");
    mainImg.src = mainSrc;
    mainImg.alt = fullSrc ? "Full photo" : "Detected face";
    mainImg.style.cursor = "pointer";
    const originalUrl = item.storyData?.originalUrl || "";
    mainImg.addEventListener("click", () => openLightbox(mainSrc, originalUrl));
    imgCol.appendChild(mainImg);

    if (item.allFaces && item.allFaces.length > 0) {
      const sel = document.createElement("div");
      sel.className = "face-selector";
      item.allFaces.forEach((f, i) => {
        const btn = document.createElement("button");
        btn.className = `face-btn${i === faceIdx ? " selected" : ""}`;
        const fi = document.createElement("img");
        fi.src = f.croppedDataUrl || "";
        fi.title = f.matchPct != null ? `${f.matchPct}% match` : "Face";
        btn.appendChild(fi);
        btn.addEventListener("click", () => {
          selectedFace.set(item.id, i);
          renderReview();
        });
        sel.appendChild(btn);
      });
      imgCol.appendChild(sel);
    } else if (faceSrc && fullSrc) {
      const sel = document.createElement("div");
      sel.className = "face-selector";
      const btn = document.createElement("button");
      btn.className = "face-btn selected";
      const fi = document.createElement("img");
      fi.src = faceSrc;
      fi.title = "Detected face";
      btn.appendChild(fi);
      sel.appendChild(btn);
      imgCol.appendChild(sel);
    }
    card.appendChild(imgCol);

    const info = document.createElement("div");
    info.className = "card-info";
    const nameEl = document.createElement("div");
    nameEl.className = "child-name";
    nameEl.textContent = item.childName || "Unknown";
    info.appendChild(nameEl);
    const pctVal = item.allFaces?.[faceIdx]?.matchPct ?? item.matchPct ?? 0;
    const pctEl = document.createElement("div");
    if (item.noFace) {
      pctEl.className = "match-pct";
      pctEl.textContent = "📷 Activity photo — no face detected";
      pctEl.style.fontSize = "13px";
      pctEl.style.color = "#60a5fa";
    } else {
      pctEl.className = "match-pct" + (pctVal >= 80 ? " high" : pctVal < 60 ? " low" : "");
      const childFirst = (item.childName || "").split(/\s+/)[0] || "child";
      pctEl.textContent = item.noTrainingData ? "No training data" : `${pctVal}% match to ${childFirst}`;
    }
    info.appendChild(pctEl);
    if (item.storyData?.createdAt) {
      const dateEl = document.createElement("div");
      dateEl.className = "post-date";
      dateEl.textContent = `📅 ${formatDate(item.storyData.createdAt)}`;
      info.appendChild(dateEl);
    }
    if (item.totalFaces > 1) {
      const faceLabel = document.createElement("div");
      faceLabel.className = "face-label";
      faceLabel.style.cssText = "font-size:12px;color:#a78bfa;font-weight:600;margin-top:4px;";
      faceLabel.textContent = `👤 Face ${(item.faceIndex ?? 0) + 1} of ${item.totalFaces} in this photo`;
      info.appendChild(faceLabel);
    }
    if (item.savePath) {
      const fnEl = document.createElement("div");
      fnEl.className = "filename";
      fnEl.textContent = item.savePath.split("/").pop();
      info.appendChild(fnEl);
    }
    if (item.noTrainingData) {
      const badge = document.createElement("span");
      badge.className = "bootstrap-badge";
      badge.textContent = "📚 Profile building — approve to train";
      info.appendChild(badge);
    }
    card.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const childPhase = childPhaseCache.get(item.childId)?.phase ?? 1;
    const isTrainingPhase = childPhase < 3;
    const isNoFacePhoto = item.noFace === true;

    if (isNoFacePhoto) {
      const btnKeep = document.createElement("button");
      btnKeep.className = "btn-review btn-approve";
      btnKeep.textContent = "✅ Keep";
      btnKeep.title = "Save this activity photo for download when Phase 3 is reached";
      btnKeep.addEventListener("click", () => handleReviewApprove(item.id, true));
      actions.appendChild(btnKeep);
    } else {
      const btnA = document.createElement("button");
      btnA.className = "btn-review btn-approve";
      btnA.textContent = isTrainingPhase ? "✅ This is my child" : "✓ Approve";
      btnA.addEventListener("click", () => handleReviewApprove(item.id, isTrainingPhase));
      actions.appendChild(btnA);
    }
    const btnR = document.createElement("button");
    btnR.className = "btn-review btn-reject";
    btnR.textContent = isNoFacePhoto ? "✗ Skip" : "✗ Reject";
    btnR.addEventListener("click", () => handleReviewReject(item.id));
    actions.appendChild(btnR);
    card.appendChild(actions);
    return card;
  }

  function renderReview() {
    $reviewGrid.innerHTML = "";
    if (reviewQueue.length === 0) {
      $reviewEmpty.style.display = "block";
      $reviewCount.textContent = "No items";
      updateReviewStatus();
      return;
    }
    $reviewEmpty.style.display = "none";
    $reviewCount.textContent = `${reviewQueue.length} media file${reviewQueue.length !== 1 ? "s" : ""} to review`;

    const pageEnd = Math.min(_reviewPageStart + REVIEW_PAGE_SIZE, reviewQueue.length);
    const pageItems = reviewQueue.slice(_reviewPageStart, pageEnd);
    updateReviewStatus();

    for (const item of pageItems) {
      $reviewGrid.appendChild(buildCardElement(item));
    }
  }

  function removeCardAnimated(id) {
    const idx = reviewQueue.findIndex(i => i.id === id);
    if (idx !== -1) reviewQueue.splice(idx, 1);
    selectedFace.delete(id);

    if (reviewQueue.length > 0) {
      $reviewBadge.style.display = "";
      $reviewBadge.textContent = reviewQueue.length;
      $reviewCount.textContent = `${reviewQueue.length} media file${reviewQueue.length !== 1 ? "s" : ""} to review`;
    } else {
      $reviewBadge.style.display = "none";
      $reviewCount.textContent = "No items";
    }

    const card = $reviewGrid.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.classList.add("removing");
      card.addEventListener("transitionend", () => {
        card.remove();
        _fillPageGap();
      }, { once: true });
      setTimeout(() => {
        if (card.parentNode) {
          card.remove();
          _fillPageGap();
        }
      }, 400);
    } else {
      _fillPageGap();
    }

    if (reviewQueue.length === 0) {
      $reviewEmpty.style.display = "block";
    }

    updateReviewStatus();
  }

  function _fillPageGap() {
    const visibleCount = $reviewGrid.querySelectorAll(".review-card:not(.removing)").length;
    const pageEnd = Math.min(_reviewPageStart + REVIEW_PAGE_SIZE, reviewQueue.length);

    if (visibleCount < REVIEW_PAGE_SIZE && pageEnd > _reviewPageStart + visibleCount) {
      const nextIdx = _reviewPageStart + visibleCount;
      if (nextIdx < reviewQueue.length) {
        const newCard = buildCardElement(reviewQueue[nextIdx]);
        newCard.classList.add("appearing");
        $reviewGrid.appendChild(newCard);
        newCard.addEventListener("animationend", () => newCard.classList.remove("appearing"), { once: true });
      }
    }

    if (_reviewPageStart >= reviewQueue.length && reviewQueue.length > 0) {
      _reviewPageStart = 0;
      renderReview();
    }

    updateReviewStatus();
  }

  function appendCards(newItems) {
    if (newItems.length === 0) return;
    $reviewEmpty.style.display = "none";

    const visibleCount = $reviewGrid.querySelectorAll(".review-card:not(.removing)").length;
    const slotsAvailable = REVIEW_PAGE_SIZE - visibleCount;

    for (let i = 0; i < Math.min(slotsAvailable, newItems.length); i++) {
      const card = buildCardElement(newItems[i]);
      card.classList.add("appearing");
      $reviewGrid.appendChild(card);
      card.addEventListener("animationend", () => card.classList.remove("appearing"), { once: true });
    }

    $reviewCount.textContent = `${reviewQueue.length} media file${reviewQueue.length !== 1 ? "s" : ""} to review`;
    if (reviewQueue.length > 0) {
      $reviewBadge.style.display = "";
      $reviewBadge.textContent = reviewQueue.length;
    }
    updateReviewStatus();
  }

  async function mergeReviewQueue(freshQueue) {
    const freshIds = new Set(freshQueue.map(i => i.id));
    const localIds = new Set(reviewQueue.map(i => i.id));

    const removedIds = [];
    for (const id of localIds) {
      if (!freshIds.has(id)) removedIds.push(id);
    }

    const addedItems = freshQueue.filter(i => !localIds.has(i.id));

    if (removedIds.length === 0 && addedItems.length === 0) {
      if (freshQueue.length > 0) {
        $reviewBadge.style.display = "";
        $reviewBadge.textContent = freshQueue.length;
      } else {
        $reviewBadge.style.display = "none";
      }
      return;
    }

    if (removedIds.length > 0) {
      _totalAutoResolved += removedIds.length;
    }

    for (const id of removedIds) {
      const idx = reviewQueue.findIndex(i => i.id === id);
      if (idx !== -1) reviewQueue.splice(idx, 1);
      selectedFace.delete(id);
      const card = $reviewGrid.querySelector(`[data-id="${id}"]`);
      if (card) {
        card.classList.add("removing");
        setTimeout(() => card.remove(), 350);
      }
    }

    reviewQueue.push(...addedItems);

    const newChildIds = new Set(addedItems.map(i => i.childId).filter(Boolean));
    for (const cid of newChildIds) {
      if (!childPhaseCache.has(cid)) {
        const phRes = await send({ type: "GET_CHILD_PHASE", childId: cid });
        if (phRes?.ok) childPhaseCache.set(cid, phRes.phase);
      }
    }

    setTimeout(() => {
      appendCards(addedItems);
    }, removedIds.length > 0 ? 380 : 0);

    if (reviewQueue.length > 0) {
      $reviewBadge.style.display = "";
      $reviewBadge.textContent = reviewQueue.length;
      $reviewCount.textContent = `${reviewQueue.length} media file${reviewQueue.length !== 1 ? "s" : ""} to review`;
      $reviewEmpty.style.display = "none";
    } else {
      $reviewBadge.style.display = "none";
      $reviewCount.textContent = "No items";
      $reviewEmpty.style.display = "block";
    }
    updateReviewStatus();
  }

  async function triggerReEvaluation() {
    if (_reEvalRunning) return;
    const childIds = new Set(reviewQueue.map(i => i.childId).filter(Boolean));
    if (childIds.size === 0) return;
    _reEvalRunning = true;
    let totalApproved = 0, totalRejected = 0;
    try {
      for (const cid of childIds) {
        const res = await send({ type: "RE_EVALUATE_QUEUE", childId: cid });
        if (res?.ok) {
          totalApproved += res.autoApproved || 0;
          totalRejected += res.autoRejected || 0;
        }
      }
      if (totalApproved > 0 || totalRejected > 0) {
        toast(`🧠 Re-evaluated: ${totalApproved} auto-approved, ${totalRejected} auto-rejected`, "success", 4000);
        await refreshReviewQueue();
      }
    } catch (e) {
      console.warn("[re-eval] Failed:", e.message);
    } finally {
      _reEvalRunning = false;
    }
  }

  async function _rescueFromRejected(item) {
    try {
      const handle = await getLinkedFolder();
      if (!handle || !item.originalFilePath) return;

      await restoreFromRejected(handle, item.originalFilePath);

      const filename = item.originalFilePath.split("/").pop();
      await send({
        type: "ADD_FILE_TO_MANIFEST",
        storyId: item.storyData?.storyId,
        filename,
        childId: item.childId,
      });

      await send({ type: "REGENERATE_FROM_DISK", storyId: item.storyData?.storyId, childId: item.childId });

      toast(`✅ Rescued ${filename} from Rejected Matches`, "success", 3000);
    } catch (e) {
      console.warn("[rescue]", e.message);
    }
  }

  async function handleReviewApprove(id, trainOnly = false) {
    if (_localActionInProgress) return;
    _localActionInProgress = true;
    _reviewsSinceReEval++;

    const item = reviewQueue.find(i => i.id === id);
    if (!item) { _localActionInProgress = false; return; }

    const faceIdx = selectedFace.get(id) ?? 0;
    const card = $reviewGrid.querySelector(`[data-id="${id}"]`);
    if (card) {
      const btns = card.querySelectorAll(".btn-review");
      btns.forEach(b => { b.disabled = true; });
    }

    try {
      if (item.isFromRejected) {
        await _rescueFromRejected(item);
      }

      const desc = item.allFaces?.[faceIdx]?.descriptor || item.descriptor || null;
      if (desc && !item.noFace) {
        const year = new Date().getFullYear().toString();
        await appendDescriptor(item.childId, item.childName, desc, year);
      }

      const res = await send({ type: "REVIEW_APPROVE", id, selectedFaceIndex: faceIdx, trainOnly });
      if (res?.ok) {
        removeCardAnimated(id);
        chrome.runtime.sendMessage({ type: "REFRESH_PROFILES" }).catch(() => {});
        if (_reviewsSinceReEval >= RE_EVAL_AFTER_N_REVIEWS) {
          _reviewsSinceReEval = 0;
          setTimeout(() => triggerReEvaluation(), 500);
        }
      } else {
        toast("❌ Approve failed: " + (res?.error || "Unknown"), "error");
        if (card) {
          const btns = card.querySelectorAll(".btn-review");
          btns.forEach(b => { b.disabled = false; });
        }
      }
    } catch (e) {
      toast("❌ Error: " + e.message, "error");
      if (card) {
        const btns = card.querySelectorAll(".btn-review");
        btns.forEach(b => { b.disabled = false; });
      }
    } finally {
      _localActionInProgress = false;
    }
  }

  async function handleReviewReject(id) {
    if (_localActionInProgress) return;
    _localActionInProgress = true;
    _reviewsSinceReEval++;

    const item = reviewQueue.find(i => i.id === id);
    if (!item) { _localActionInProgress = false; return; }

    const faceIdx = selectedFace.get(id) ?? 0;
    const card = $reviewGrid.querySelector(`[data-id="${id}"]`);
    if (card) {
      const btns = card.querySelectorAll(".btn-review");
      btns.forEach(b => { b.disabled = true; });
    }

    try {
      const desc = item.allFaces?.[faceIdx]?.descriptor || item.descriptor || null;
      if (desc && !item.noFace) {
        await appendNegativeDescriptor(item.childId, desc);
      }

      if (item.isOfflineFile && item.filePath) {
        const handle = await getLinkedFolder();
        if (handle) {
          await moveFileToRejected(handle, item.filePath);
          if (item.storyData?.storyId && item.storyData?.originalUrl) {
            await addRejection(item.storyData.storyId, item.storyData.originalUrl);
          }
        }
      }

      const res = await send({ type: "REVIEW_REJECT", id });
      if (res?.ok) {
        removeCardAnimated(id);
        if (_reviewsSinceReEval >= RE_EVAL_AFTER_N_REVIEWS) {
          _reviewsSinceReEval = 0;
          setTimeout(() => triggerReEvaluation(), 500);
        }
      } else {
        toast("❌ Reject failed: " + (res?.error || "Unknown"), "error");
        if (card) {
          const btns = card.querySelectorAll(".btn-review");
          btns.forEach(b => { b.disabled = false; });
        }
      }
    } catch (e) {
      toast("❌ Error: " + e.message, "error");
      if (card) {
        const btns = card.querySelectorAll(".btn-review");
        btns.forEach(b => { b.disabled = false; });
      }
    } finally {
      _localActionInProgress = false;
    }
  }

  async function refreshReviewQueue() {
    clearTimeout(_queueUpdateDebounceTimer);
    _queueUpdateDebounceTimer = null;

    const res = await send({ type: "GET_REVIEW_QUEUE" });
    if (!res?.ok) return;

    const freshQueue = res.queue || [];

    for (const item of freshQueue) {
      if (!childPhaseCache.has(item.childId)) {
        const phRes = await send({ type: "GET_CHILD_PHASE", childId: item.childId });
        if (phRes?.ok) childPhaseCache.set(item.childId, phRes.phase);
      }
    }

    if (document.querySelector(".tab-panel.active")?.id === "tabReview") {
      await mergeReviewQueue(freshQueue);
    } else {
      reviewQueue = freshQueue;
      if (reviewQueue.length > 0) {
        $reviewBadge.style.display = "";
        $reviewBadge.textContent = reviewQueue.length;
      } else {
        $reviewBadge.style.display = "none";
      }
    }
  }

  // Event listeners
  $btnRefreshR?.addEventListener("click", () => refreshReviewQueue());

  $btnUndo?.addEventListener("click", async () => {
    $btnUndo.disabled = true;
    const res = await send({ type: "UNDO_LAST_REVIEW" });
    $btnUndo.disabled = false;
    if (res?.ok) {
      toast("⤺ Undone", "success");
      await refreshReviewQueue();
    } else {
      toast("❌ " + (res?.error || "Nothing to undo"), "error");
    }
  });

  $btnBatch?.addEventListener("click", async () => {
    $btnBatch.disabled = true;
    $btnBatch.textContent = "⏳ Starting…";
    const res = await send({ type: "BATCH_DOWNLOAD_APPROVED" });
    $btnBatch.disabled = false;
    $btnBatch.textContent = "📥 Download Approved";
    if (res?.ok) {
      toast(`✅ Batch download started — ${res.count} files queued`, "success");
    } else {
      toast("❌ " + (res?.error || "No files to download"), "error");
    }
  });

  $btnBuildHtml?.addEventListener("click", async () => {
    $btnBuildHtml.disabled = true;
    $btnBuildHtml.textContent = "⏳ Rebuilding…";
    const res = await send({ type: "REBUILD_HTML_ALL" });
    $btnBuildHtml.disabled = false;
    $btnBuildHtml.textContent = "🔄 Rebuild Pages & Cards";
    if (res?.ok) {
      toast(`✅ Rebuilt ${res.count} story pages`, "success");
    } else {
      toast("❌ " + (res?.error || "Rebuild failed"), "error");
    }
  });

  $btnFinalV?.addEventListener("click", async () => {
    $btnFinalV.disabled = true;
    $btnFinalV.textContent = "⏳ Verifying…";
    await triggerReEvaluation();
    $btnFinalV.disabled = false;
    $btnFinalV.textContent = "✅ Final Verification";
  });

  // Keyboard shortcuts (A = approve, R = reject, Z = undo)
  document.addEventListener("keydown", (e) => {
    if (document.querySelector(".tab-panel.active")?.id !== "tabReview") return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    const firstCard = reviewQueue[_reviewPageStart];
    if (!firstCard) return;

    if (e.key === "a" || e.key === "A") {
      e.preventDefault();
      handleReviewApprove(firstCard.id);
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      handleReviewReject(firstCard.id);
    } else if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      $btnUndo?.click();
    }
  });

  // Export for central message listener
  window._reviewQueueUpdated = () => {
    if (_localActionInProgress) return;
    clearTimeout(_queueUpdateDebounceTimer);
    _queueUpdateDebounceTimer = setTimeout(() => {
      refreshReviewQueue();
    }, 300);
  };

  window._refreshReviewQueue = refreshReviewQueue;
  window._triggerReEvaluation = triggerReEvaluation;

  // Initial load
  refreshReviewQueue();
}

export { refreshReviewQueue as getRefreshReviewQueue };
