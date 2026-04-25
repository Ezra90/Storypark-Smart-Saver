/**
 * dashboard-scan.js — Scan Tab UI Module
 * 
 * ┌─ WHAT THIS FILE OWNS ─┐
 * │ • Child selector + phase badge                              │
 * │ • Scan Latest / Scan All / Resume buttons                   │
 * │ • Smart Sort (offline facial scan from Scan tab)            │
 * │ • Progress bar + scan log display                           │
 * │ • Scan checkpoint management                                │
 * │ • Test Connection button                                    │
 * └─────────────────────────────────────────────────────────────┘
 */

import { loadModels, detectFaces, matchEmbedding } from "./lib/face.js";
import { getDescriptors, appendDescriptor, appendNegativeDescriptor, addToReviewQueue, saveImageFingerprint, getAllDownloadedStories, addRejection } from "./lib/db.js";
import { getLinkedFolder, walkFolder, readFileAsDataUrl, moveFileToRejected } from "./lib/disk-sync.js";

const ALL_CHILDREN = "__ALL__";
let isRunning = false;
let _scanLogFollowing = true;
let humanAvailable = typeof Human !== "undefined";

// Export for use by central dashboard.js
export function getIsRunning() { return isRunning; }
export function setIsRunning(val) { isRunning = val; }

// DOM references
const $childSelect  = document.getElementById("childSelect");
const $btnRefresh   = document.getElementById("btnRefresh");
const $btnScanMissing = document.getElementById("btnScanMissing");
const $btnLatest    = document.getElementById("btnExtractLatest");
const $btnDeep      = document.getElementById("btnDeepRescan");
const $btnTest      = document.getElementById("btnTestConnection");
const $btnStop      = document.getElementById("btnStopScan");
const $statusDot    = document.getElementById("statusDot");
const $statusText   = document.getElementById("statusText");
const $progressBar  = document.getElementById("progressBar");
const $progressText = document.getElementById("progressText");
const $scanLog      = document.getElementById("scanLogBox");
const $btnFollowScanLog = document.getElementById("btnFollowScanLog");
const $phaseBadge   = document.getElementById("phaseBadge");
const $btnResume    = document.getElementById("btnResumeScan");
const $resumeInfo   = document.getElementById("resumeInfo");
const $btnOfflineScanMain = document.getElementById("btnOfflineScanMain");

/**
 * Initialize the Scan Tab.
 * Wire event listeners and load initial state.
 * Called once from dashboard.js on page load.
 */
export function initScanTab(helpers) {
  const { send, toast, formatDate, updateProgressBar, yieldForGC, refreshReviewQueue } = helpers;

  function setStatus(color, text) {
    $statusDot.className = "dot" + (color ? ` ${color}` : "");
    $statusText.textContent = text;
  }

  function scanLog(message) {
    if ($scanLog.firstElementChild?.textContent === "Waiting for action…") $scanLog.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = message;
    $scanLog.appendChild(p);
    if (_scanLogFollowing) $scanLog.scrollTop = $scanLog.scrollHeight;
    _updateFollowBtn();
  }

  function _isAtBottom(el) {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 15;
  }

  function _updateFollowBtn() {
    if ($btnFollowScanLog) {
      $btnFollowScanLog.style.display = _scanLogFollowing ? "none" : "flex";
    }
  }

  $scanLog?.addEventListener("scroll", () => {
    _scanLogFollowing = _isAtBottom($scanLog);
    _updateFollowBtn();
  });

  $btnFollowScanLog?.addEventListener("click", () => {
    _scanLogFollowing = true;
    $scanLog.scrollTop = $scanLog.scrollHeight;
    _updateFollowBtn();
  });

  function setRunning(running) {
    isRunning = running;
    if ($btnLatest) $btnLatest.disabled = running;
    if ($btnDeep) $btnDeep.disabled = running;
    if ($btnScanMissing) $btnScanMissing.disabled = running;
    if ($childSelect) $childSelect.disabled = running;
    if ($btnRefresh) $btnRefresh.disabled = running;
    if ($btnLatest) $btnLatest.style.display = running ? "none" : "";
    if ($btnDeep) $btnDeep.style.display = running ? "none" : "";
    if ($btnScanMissing) $btnScanMissing.style.display = running ? "none" : "";
    if ($btnStop) $btnStop.style.display = running ? "inline-flex" : "none";

    const $globalBanner = document.getElementById("globalScanBanner");
    const $globalStop = document.getElementById("btnGlobalStop");
    if ($globalBanner) $globalBanner.style.display = running ? "block" : "none";
    if ($globalStop && !running) {
      $globalStop.disabled = false;
      $globalStop.textContent = "🛑 Stop Scan";
    }

    if ($btnOfflineScanMain) {
      $btnOfflineScanMain.disabled = running || !$childSelect.value;
    }

    if (!running) {
      if ($btnStop) {
        $btnStop.disabled = false;
        $btnStop.textContent = "🛑 Stop Scan";
      }
      if ($progressBar) $progressBar.style.display = "none";
      if ($progressText) $progressText.style.display = "none";
    }
  }

  function populateChildren(children) {
    $childSelect.innerHTML = "";
    if (!children || children.length === 0) {
      $childSelect.innerHTML = '<option value="">No children found — open Storypark first</option>';
      if ($btnLatest) $btnLatest.disabled = true;
      if ($btnDeep) $btnDeep.disabled = true;
      if ($btnScanMissing) $btnScanMissing.disabled = true;
      return;
    }
    const allOpt = document.createElement("option");
    allOpt.value = ALL_CHILDREN;
    allOpt.textContent = "👨‍👩‍👧‍👦 All Children";
    $childSelect.appendChild(allOpt);
    for (const c of children) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      $childSelect.appendChild(o);
    }
    chrome.storage.local.get("lastSelectedChildId", ({ lastSelectedChildId }) => {
      if (lastSelectedChildId) {
        const exists = [...$childSelect.options].some(o => o.value === lastSelectedChildId);
        if (exists) $childSelect.value = lastSelectedChildId;
      }
      if (!isRunning && $childSelect.value) {
        if ($btnLatest) $btnLatest.disabled = false;
        if ($btnDeep) $btnDeep.disabled = false;
        if ($btnScanMissing) $btnScanMissing.disabled = false;
      }
    });
  }

  function checkForResume() {
    const childId = $childSelect.value;
    if (!childId || childId === ALL_CHILDREN) {
      if ($btnResume) $btnResume.style.display = "none";
      if ($resumeInfo) $resumeInfo.style.display = "none";
      return;
    }
    send({ type: "GET_SCAN_CHECKPOINT", childId }).then(res => {
      if (res?.ok && res.checkpoint) {
        const cp = res.checkpoint;
        if ($btnResume) {
          $btnResume.style.display = "";
          $btnResume.disabled = isRunning;
          const _resumeRemaining = (cp.totalStories || 0) - (cp.storyIndex || 0);
          $btnResume.textContent = `▶ Resume from story ${cp.storyIndex} (${_resumeRemaining} remaining)`;
        }
        if ($resumeInfo) {
          $resumeInfo.style.display = "block";
          $resumeInfo.innerHTML = `⏸ Interrupted scan: story ${cp.storyIndex} of ${cp.totalStories} · Mode: ${cp.mode === "DEEP_RESCAN" ? "Full History" : "Latest"} · <a href="#" id="clearCheckpointLink" style="color:#a855f7;text-decoration:underline;">Clear</a>`;
          setTimeout(() => {
            const link = document.getElementById("clearCheckpointLink");
            if (link) link.addEventListener("click", async (e) => {
              e.preventDefault();
              await chrome.storage.local.remove(`scanCheckpoint_${childId}`).catch(() => {});
              if ($btnResume) $btnResume.style.display = "none";
              if ($resumeInfo) $resumeInfo.style.display = "none";
              toast("✓ Checkpoint cleared");
            });
          }, 0);
        }
      } else {
        if ($btnResume) $btnResume.style.display = "none";
        if ($resumeInfo) $resumeInfo.style.display = "none";
      }
    });
  }

  async function _createSmallThumbnail(dataUrl, maxDim = 200) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
          canvas.width = Math.round(img.width * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.6));
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function loadAllChildrenConfidence() {
    const $panel = document.getElementById("allChildrenPanel");
    if (!$panel) return;
    const res = await send({ type: "GET_CHILDREN" });
    const children = res?.children || [];
    if (children.length === 0) { $panel.style.display = "none"; return; }

    $panel.style.display = "block";
    $panel.innerHTML = '<div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:6px;">🧠 Face Model Status</div>';

    for (const child of children) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;";
      const nameEl = document.createElement("span");
      nameEl.style.cssText = "min-width:140px;color:var(--text);font-weight:600;";
      nameEl.textContent = child.name;
      row.appendChild(nameEl);
      const phaseEl = document.createElement("span");
      phaseEl.style.cssText = "min-width:80px;font-size:11px;";
      phaseEl.textContent = "…";
      row.appendChild(phaseEl);
      const confEl = document.createElement("span");
      confEl.style.cssText = "font-size:11px;";
      confEl.textContent = "";
      row.appendChild(confEl);
      $panel.appendChild(row);
      send({ type: "GET_CHILD_PHASE", childId: child.id }).then(phRes => {
        if (!phRes?.ok) return;
        const p = phRes.phase;
        const EMOJIS = { 1: "🔍", 2: "✅", 3: "📊", 4: "🚀" };
        const LABELS = { 1: "Phase 1", 2: "Phase 2", 3: "Phase 3", 4: "Phase 4" };
        phaseEl.textContent = `${EMOJIS[p.phase] || "🔍"} ${LABELS[p.phase] || "?"} (${p.verifiedCount} verified)`;
      });
      send({ type: "GET_MODEL_CONFIDENCE", childId: child.id }).then(cRes => {
        if (!cRes?.ok) return;
        const pct = cRes.confidence;
        const color = pct >= 80 ? "var(--success)" : pct >= 50 ? "var(--warning)" : "var(--accent)";
        const label = pct >= 80 ? "Good" : pct >= 50 ? "Fair" : "Low";
        confEl.style.color = color;
        confEl.textContent = `📊 ${pct}% — ${label}`;
      });
    }
  }

  function loadChildPhase() {
    const childId = $childSelect.value;
    const $panel = document.getElementById("allChildrenPanel");
    if (childId === ALL_CHILDREN) {
      if ($phaseBadge) $phaseBadge.style.display = "none";
      const $conf = document.getElementById("confidenceBadge");
      if ($conf) $conf.style.display = "none";
      loadAllChildrenConfidence();
      return;
    }
    if ($panel) $panel.style.display = "none";
    if (!childId) { if ($phaseBadge) $phaseBadge.style.display = "none"; return; }
    chrome.runtime.sendMessage({ type: "GET_CHILD_PHASE", childId }, res => {
      if (!res?.ok) { if ($phaseBadge) $phaseBadge.style.display = "none"; return; }
      const p = res.phase;
      if ($phaseBadge) {
        $phaseBadge.style.display = "inline-block";
        $phaseBadge.className = `phase-badge phase-${p.phase}`;
        const _need1 = Math.max(0, 10 - p.verifiedCount);
        const _need2 = Math.max(0, 50 - p.verifiedCount);
        const _need3 = Math.max(0, 100 - p.verifiedCount);
        if (p.phase === 1) {
          $phaseBadge.textContent = `🔍 Building profile (${p.verifiedCount}/10)`;
          $phaseBadge.title = `Approve ${_need1} more media to advance — AI is learning your child's face. Downloads start at Phase 4 (100+ approvals). Go to Review tab and approve photos now!`;
        } else if (p.phase === 2) {
          $phaseBadge.textContent = `✅ Getting smarter (${p.verifiedCount}/50)`;
          $phaseBadge.title = `Approve ${_need2} more media — AI is improving. Uncertain matches still go to review. Downloads start at Phase 4.`;
        } else if (p.phase === 3) {
          $phaseBadge.textContent = `📊 Nearly ready (${p.verifiedCount}/100)`;
          $phaseBadge.title = `Approve ${_need3} more media with 80%+ model confidence to unlock automatic downloads. Almost there!`;
        } else {
          $phaseBadge.textContent = `🚀 Auto-downloading (${p.verifiedCount} approved)`;
          $phaseBadge.title = `Automatic download mode — high-confidence matches download without review. ${p.verifiedCount} face descriptors learned.`;
        }
      }
    });
    chrome.runtime.sendMessage({ type: "GET_MODEL_CONFIDENCE", childId }, res => {
      const $conf = document.getElementById("confidenceBadge");
      if (!$conf) return;
      if (!res?.ok) { $conf.style.display = "none"; return; }
      $conf.style.display = "inline-block";
      const pct = res.confidence;
      const color = pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
      $conf.style.color = color;
      $conf.textContent = `📊 Model: ${pct}% (${res.details})`;
      $conf.title = `Descriptors: ${res.descriptorCount}, Consistency: ${res.consistency}%, Verification: ${res.verificationScore}%`;
    });
  }

  function updateCentreInfo() {
    chrome.storage.local.get("activeCentreName", ({ activeCentreName }) => {
      const el = document.getElementById("centreInfo");
      if (el) el.textContent = activeCentreName ? `📍 ${activeCentreName}` : "";
    });
  }

  function loadChildren() {
    send({ type: "GET_CHILDREN" }).then(res => { if (res?.ok) populateChildren(res.children); });
    updateCentreInfo();
    send({ type: "REFRESH_PROFILE" }).then(res => {
      if (res?.ok) { populateChildren(res.children); updateCentreInfo(); }
    });
  }

  function triggerExtraction(type) {
    if (isRunning) return;
    const childId = $childSelect.value;
    const childName = $childSelect.options[$childSelect.selectedIndex]?.text || "";
    if (!childId) { scanLog("Please select a child first."); return; }
    const isAll = childId === ALL_CHILDREN;
    const msgType = isAll
      ? (type === "EXTRACT_LATEST" ? "EXTRACT_ALL_LATEST" : "DEEP_RESCAN_ALL")
      : type;
    setRunning(true);
    $scanLog.innerHTML = "";
    if ($progressBar) { $progressBar.value = 0; $progressBar.max = 100; $progressBar.style.display = "block"; }
    if ($progressText) { $progressText.style.display = "block"; $progressText.textContent = "Starting…"; }
    setStatus("yellow", type === "EXTRACT_LATEST" ? "Scanning latest…" : "Scanning all stories…");
    scanLog(type === "EXTRACT_LATEST"
      ? (isAll ? "Scanning latest stories for all children…" : "Scanning latest stories…")
      : (isAll ? "Scanning all stories for all children…" : "Scanning all stories from the beginning…"));
    send({ type: msgType, childId, childName }).then(res => {
      setRunning(false);
      if (res?.ok) {
        setStatus("green", "Done");
        const s = res.stats;
        scanLog(`✓ Done — Downloaded: ${s.approved}, Review: ${s.queued}, Rejected: ${s.rejected}`);
        if (s.queued > 0) refreshReviewQueue();
      } else {
        setStatus("red", "Error");
        scanLog("✗ " + (res?.error || "Unknown error"));
      }
    });
  }

  async function runSmartSort() {
    if (isRunning) return;
    const childId = $childSelect.value;
    if (!childId) { scanLog("Please select a child first."); return; }

    const handle = await getLinkedFolder();
    if (!handle) {
      toast("Link a download folder first — go to Settings → 📁 Link Download Folder", "error", 5000);
      return;
    }

    if (!humanAvailable) { toast("Face models not available", "error"); return; }
    try { await loadModels(); } catch (e) {
      toast(`❌ Face models failed to load: ${e.message}`, "error");
      return;
    }

    let childrenToScan = [];
    if (childId === ALL_CHILDREN) {
      const res = await send({ type: "GET_CHILDREN" });
      childrenToScan = res?.children || [];
      if (childrenToScan.length === 0) { scanLog("No children found — refresh your profile first."); return; }
    } else {
      const childName = $childSelect.options[$childSelect.selectedIndex]?.text || "";
      childrenToScan = [{ id: childId, name: childName }];
    }

    setRunning(true);
    $scanLog.innerHTML = "";
    if ($progressBar) { $progressBar.value = 0; $progressBar.max = 100; $progressBar.style.display = "block"; }
    if ($progressText) { $progressText.style.display = "block"; }
    setStatus("yellow", "Smart Sort…");
    scanLog(`🧠 Starting Smart Sort for ${childId === ALL_CHILDREN ? "all children" : childrenToScan[0].name}…`);
    scanLog("⚡ Reading photos from disk — no internet needed.");

    const settingsData = await chrome.storage.local.get(["autoThreshold", "minThreshold", "keepScenarioPhotos"]).catch(() => ({}));
    const autoThreshold = settingsData.autoThreshold ?? 85;
    const minThreshold = settingsData.minThreshold ?? 50;
    const keepScenarioPhotos = settingsData.keepScenarioPhotos ?? false;
    const year = new Date().getFullYear().toString();
    const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;
    const INVALID_CHARS = /[/\\:*?"<>|]/g;

    let totalAutoApproved = 0, totalQueued = 0, totalRejected = 0, totalNoFace = 0;

    for (const child of childrenToScan) {
      const cId = child.id;
      const cName = child.name;
      const childSafe = cName.replace(INVALID_CHARS, "_").trim();
      const _sssLinked = handle.name === "Storypark Smart Saver";
      const storiesPrefix = _sssLinked ? `${childSafe}/Stories` : `Storypark Smart Saver/${childSafe}/Stories`;
      const rejectedPrefix = _sssLinked ? `${childSafe} Rejected Matches/Stories` : `Storypark Smart Saver/${childSafe} Rejected Matches/Stories`;

      scanLog(`\n👶 Scanning ${cName}…`);

      const rec = await getDescriptors(cId).catch(() => null);
      const storedDescs = rec?.descriptors || [];
      if (storedDescs.length === 0) {
        scanLog(`  📚 No face training for ${cName} yet — all detected faces will go to Review tab (Phase 1 mode)`);
      }

      const allManifests = await getAllDownloadedStories().catch(() => []);
      const childManifests = allManifests.filter(m => m.childId === cId || m.childName === cName);
      const manifestByFolder = new Map(childManifests.map(m => [m.folderName, m]));

      let allFiles = [];
      try {
        allFiles = await walkFolder(handle, "", {});
      } catch (e) {
        scanLog(`  ❌ Could not read folder: ${e.message}`);
        continue;
      }

      const imageFiles = allFiles.filter(f =>
        (f.startsWith(storiesPrefix + "/") || f.startsWith(rejectedPrefix + "/")) && MEDIA_EXT.test(f)
      );

      if (imageFiles.length === 0) {
        scanLog(`  ⚠ No photos found for ${cName} — run a Full History Scan first to download stories.`);
        continue;
      }

      scanLog(`  📂 Found ${imageFiles.length} photos — analysing…`);
      if ($progressBar) $progressBar.max = imageFiles.length;

      let autoApproved = 0, queued = 0, rejected = 0, noFace = 0, errors = 0;
      const _childLoopStart = Date.now();

      for (let i = 0; i < imageFiles.length; i++) {
        const filePath = imageFiles[i];
        updateProgressBar($progressBar, $progressText, i + 1, imageFiles.length, _childLoopStart,
          `${cName}: ${i + 1}/${imageFiles.length} — ${filePath.split("/").pop()}`);

        await yieldForGC(i + 1, imageFiles.length, $progressText);

        try {
          const dataUrl = await readFileAsDataUrl(handle, filePath);
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

          let faces = [];
          try { faces = await detectFaces(img); } catch { /* model error */ }

          if (faces.length === 0) {
            noFace++;
            if (!keepScenarioPhotos) {
              const thumb = await _createSmallThumbnail(dataUrl);
              await addToReviewQueue({
                childId: cId, childName: cName,
                storyData: { storyId: `offline:${filePath}`, createdAt: null, originalUrl: null },
                savePath: filePath, description: `📷 Scenario photo — no face detected. Keep?`,
                croppedFaceDataUrl: thumb, fullPhotoDataUrl: null,
                descriptor: null, matchPct: 0, noFace: true, isOfflineFile: true, filePath,
              });
              queued++;
            }
            continue;
          }

          let bestScore = 0, bestDescriptor = null;
          if (storedDescs.length > 0) {
            for (const face of faces) {
              if (face.embedding) {
                const score = (await matchEmbedding(face.embedding, storedDescs)) ?? 0;
                if (score > bestScore) { bestScore = score; bestDescriptor = face.embedding; }
              }
            }
          }

          const pathParts = filePath.split("/");
          const folderIdx = _sssLinked ? 2 : 3;
          const folderName = pathParts.length >= (folderIdx + 2) ? pathParts[folderIdx] : null;
          const filenameInPath = pathParts[pathParts.length - 1];
          const manifest = folderName ? manifestByFolder.get(folderName) : null;
          const isFromRejected = filePath.includes(" Rejected Matches/");

          const originalFilePath = isFromRejected
            ? filePath.split("/").map((p, i) => i === 1 ? p.replace(/ Rejected Matches$/, "") : p).join("/")
            : filePath;

          const mediaEntry = manifest?.mediaUrls?.find(m => m.filename === filenameInPath);
          const originalUrl = mediaEntry?.originalUrl || null;

          if (manifest?.storyId && originalUrl && faces.length > 0) {
            await saveImageFingerprint({
              storyId: manifest.storyId,
              imageUrl: originalUrl,
              childId: cId,
              faces: faces
                .filter(f => f.embedding)
                .map(f => ({ descriptor: Array.from(f.embedding) })),
              noFace: false,
            }).catch(() => {});
          }

          const effectiveScore = storedDescs.length === 0 ? (minThreshold + autoThreshold) / 2 : bestScore;
          const bestDesc = bestDescriptor || (faces[0]?.embedding ? faces[0].embedding : null);

          if (storedDescs.length > 0 && bestScore >= autoThreshold) {
            if (bestDescriptor) await appendDescriptor(cId, cName, Array.from(bestDescriptor), year);
            autoApproved++;
          } else if (effectiveScore >= minThreshold) {
            const thumbnail = await _createSmallThumbnail(dataUrl);
            const fromRejectedNote = isFromRejected
              ? `⤴ From Rejected Matches — approve to rescue | ` : "";
            await addToReviewQueue({
              childId: cId, childName: cName,
              storyData: {
                storyId: manifest?.storyId || `offline:${filePath}`,
                createdAt: manifest?.storyDate ? `${manifest.storyDate}T00:00:00Z` : null,
                originalUrl,
              },
              savePath: filePath,
              description: `${fromRejectedNote}📁 ${filePath.split("/").pop()}`,
              croppedFaceDataUrl: thumbnail,
              fullPhotoDataUrl: null,
              descriptor: bestDesc ? Array.from(bestDesc) : null,
              matchPct: Math.round(bestScore),
              noFace: false, isOfflineFile: true, filePath,
              noTrainingData: storedDescs.length === 0,
              isFromRejected,
              originalFilePath,
            });
            queued++;
          } else {
            if (bestDescriptor) await appendNegativeDescriptor(cId, Array.from(bestDescriptor));
            rejected++;
            try {
              await moveFileToRejected(handle, filePath);
              const mEntry = manifest?.mediaUrls?.find(m => m.filename === filenameInPath);
              if (manifest?.storyId && mEntry?.originalUrl) {
                await addRejection(manifest.storyId, mEntry.originalUrl).catch(() => {});
              }
            } catch { /* non-fatal */ }
          }
        } catch (e) {
          errors++;
        }
      }

      if (autoApproved > 0) chrome.runtime.sendMessage({ type: "REFRESH_PROFILES" }).catch(() => {});
      send({ type: "ADVANCE_PHASE", childId: cId }).catch(() => {});

      const rejectedFiles = imageFiles.filter(f => f.includes(" Rejected Matches/"));
      if (rejectedFiles.length > 0) {
        scanLog(`  📦 Also scanned ${rejectedFiles.length} photos from Rejected Matches folder (fresh detection for rescue)`);
      }
      scanLog(`  ✅ ${autoApproved} confirmed · 👀 ${queued} to review · ❌ ${rejected} rejected · 📷 ${noFace} no face`);
      if (errors > 0) scanLog(`  ⚠ ${errors} files could not be read`);

      totalAutoApproved += autoApproved;
      totalQueued += queued;
      totalRejected += rejected;
      totalNoFace += noFace;
    }

    await refreshReviewQueue();

    setRunning(false);
    setStatus("green", "Smart Sort complete");
    const summary = `✅ Smart Sort Done — ${totalAutoApproved} confirmed, ${totalQueued} to review, ${totalRejected} moved to Rejected Matches`;
    scanLog(`\n${summary}`);
    if (totalQueued > 0) scanLog(`💡 Go to the 👀 Pending Review tab — ${totalQueued} photos need your decision.`);
    toast(summary, "success", 6000);
  }

  // Event listeners
  $childSelect?.addEventListener("change", () => {
    chrome.storage.local.set({ lastSelectedChildId: $childSelect.value });
    if (!isRunning && $childSelect.value) {
      if ($btnLatest) $btnLatest.disabled = false;
      if ($btnDeep) $btnDeep.disabled = false;
      if ($btnScanMissing) $btnScanMissing.disabled = false;
      if ($btnOfflineScanMain) $btnOfflineScanMain.disabled = false;
    } else if (!$childSelect.value) {
      if ($btnLatest) $btnLatest.disabled = true;
      if ($btnDeep) $btnDeep.disabled = true;
      if ($btnScanMissing) $btnScanMissing.disabled = true;
      if ($btnOfflineScanMain) $btnOfflineScanMain.disabled = true;
    }
    loadChildPhase();
    checkForResume();
  });

  $btnRefresh?.addEventListener("click", () => {
    $childSelect.innerHTML = "<option>Refreshing…</option>";
    if ($btnLatest) $btnLatest.disabled = true;
    if ($btnDeep) $btnDeep.disabled = true;
    if ($btnScanMissing) $btnScanMissing.disabled = true;
    send({ type: "REFRESH_PROFILE" }).then(res => {
      if (res?.ok) { populateChildren(res.children); updateCentreInfo(); }
      else $childSelect.innerHTML = '<option value="">Failed — open Storypark first</option>';
    });
  });

  $btnLatest?.addEventListener("click", () => triggerExtraction("EXTRACT_LATEST"));
  $btnDeep?.addEventListener("click", () => triggerExtraction("DEEP_RESCAN"));
  $btnScanMissing?.addEventListener("click", () => triggerExtraction("EXTRACT_LATEST"));
  $btnOfflineScanMain?.addEventListener("click", () => runSmartSort());

  $btnStop?.addEventListener("click", () => {
    send({ type: "CANCEL_SCAN" });
    $btnStop.disabled = true;
    $btnStop.textContent = "⏳ Cancelling…";
    const $gs = document.getElementById("btnGlobalStop");
    if ($gs) { $gs.disabled = true; $gs.textContent = "⏳ Cancelling…"; }
    setStatus("yellow", "Cancelling…");
    scanLog("⏹ Cancellation requested…");
  });

  document.getElementById("btnGlobalStop")?.addEventListener("click", () => {
    send({ type: "CANCEL_SCAN" });
    const $gs = document.getElementById("btnGlobalStop");
    if ($gs) { $gs.disabled = true; $gs.textContent = "⏳ Cancelling…"; }
    if ($btnStop) {
      $btnStop.disabled = true;
      $btnStop.textContent = "⏳ Cancelling…";
    }
    setStatus("yellow", "Cancelling…");
    scanLog("⏹ Cancellation requested…");
  });

  $btnResume?.addEventListener("click", () => {
    if (isRunning) return;
    const childId = $childSelect.value;
    const childName = $childSelect.options[$childSelect.selectedIndex]?.text || "";
    if (!childId || childId === ALL_CHILDREN) return;
    setRunning(true);
    if ($btnResume) $btnResume.style.display = "none";
    if ($resumeInfo) $resumeInfo.style.display = "none";
    $scanLog.innerHTML = "";
    if ($progressBar) { $progressBar.value = 0; $progressBar.max = 100; $progressBar.style.display = "block"; }
    if ($progressText) { $progressText.style.display = "block"; $progressText.textContent = "Resuming scan…"; }
    setStatus("yellow", "Resuming scan…");
    scanLog("▶ Resuming interrupted scan…");
    send({ type: "RESUME_SCAN", childId, childName }).then(res => {
      setRunning(false);
      checkForResume();
      if (res?.ok) {
        setStatus("green", "Done");
        const s = res.stats;
        scanLog(`✓ Done — Downloaded: ${s.approved}, Review: ${s.queued}, Rejected: ${s.rejected}`);
        if (s.queued > 0) refreshReviewQueue();
      } else {
        setStatus("red", "Error");
        scanLog("✗ " + (res?.error || "Unknown error"));
      }
    });
  });

  $btnTest?.addEventListener("click", () => {
    $btnTest.disabled = true;
    $btnTest.textContent = "⏳ Testing…";
    send({ type: "TEST_CONNECTION" }).then(res => {
      $btnTest.disabled = false;
      $btnTest.textContent = "🔌 Test Connection";
      if (res?.ok) toast(`✅ Connected${res.email ? ` (${res.email})` : ""}`, "success");
      else toast(`❌ Not connected${res?.error ? `: ${res.error}` : ""}`, "error");
    });
  });

  // Export progress update function for central message listener
  window._scanUpdateProgress = (msg) => {
    if ($progressBar) {
      $progressBar.value = msg.current;
      $progressBar.max = msg.total;
      $progressBar.style.display = "block";
    }
    if ($progressText) {
      const etaPart = msg.eta ? ` · ⏱ ${msg.eta}` : "";
      $progressText.style.display = "block";
      $progressText.textContent = `${msg.current}/${msg.total} · ${msg.date || ""}${etaPart}`;
    }
  };

  window._scanComplete = () => {
    setRunning(false);
    setStatus("green", "Complete");
    checkForResume();
  };

  // Initial load
  loadChildren();
  loadChildPhase();
  checkForResume();
}
