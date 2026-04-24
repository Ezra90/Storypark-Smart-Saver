/**
 * dashboard.js – Unified full-page dashboard for Storypark Smart Saver.
 *
 * Combines functionality from:
 *   - popup.js  (scan tab: child selector, extraction, progress)
 *   - review.js (review tab: HITL face verification queue)
 *   - options.js (settings tab: thresholds, centres, training, debug)
 *
 * All four tabs share state via chrome.storage and communicate with
 * background.js via chrome.runtime.sendMessage.
 */

import { loadModels, detectFaces, matchEmbedding } from "./lib/face.js";
import { getDescriptors, setDescriptors, MAX_DESCRIPTORS_PER_CHILD, getAllDownloadedStories, addDownloadedStory, removeFileFromStoryManifest, markFilenameRejectedInManifest, addRejection, appendDescriptor, appendNegativeDescriptor, addToReviewQueue, saveImageFingerprint, getCentreGPS } from "./lib/db.js";
import { linkFolder, getLinkedFolder, clearLinkedFolder, reconcileWithCache, repairManifestFromDisk, walkFolder, readFileAsDataUrl, moveFileToRejected, restoreFromRejected, deleteFile } from "./lib/disk-sync.js";

/* ================================================================== */
/*  Shared helpers                                                     */
/* ================================================================== */

const $toast = document.getElementById("toast");
let _toastTimer = null;

function toast(message, type = "success", ms = 3000) {
  clearTimeout(_toastTimer);
  $toast.textContent = message;
  $toast.className = `show ${type}`;
  _toastTimer = setTimeout(() => { $toast.className = type; }, ms);
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => resolve(res));
  });
}

function formatDate(iso) {
  if (!iso) return "";
  const d = iso.split("T")[0];
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
}

/** Format milliseconds as "~Xh Ym" / "~Ym" / "< 1m" for ETA displays in the dashboard page context. */
function _fmtEta(ms) {
  if (!ms || ms <= 0 || !isFinite(ms)) return "";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return "< 1m";
  const h = Math.floor(s / 3600), m2 = Math.floor((s % 3600) / 60);
  return h > 0 ? (m2 > 0 ? `~${h}h ${m2}m` : `~${h}h`) : `~${m2}m`;
}

/* ── Shared UI helpers (Settings-tab operations) ── */

/**
 * Set a button to "running" (disabled) or "idle" (enabled) state.
 * @param {HTMLElement} $btn  Button element
 * @param {boolean} running
 * @param {string} idleLabel   Label when idle   (e.g. "🧹 Run Clean Up")
 * @param {string} [runLabel]  Label when running (defaults to "⏳ Working…")
 */
function setOperationRunning($btn, running, idleLabel, runLabel = "⏳ Working…") {
  if (!$btn) return;
  $btn.disabled = running;
  $btn.textContent = running ? runLabel : idleLabel;
}

/**
 * Show the progress section and reset the bar.
 * @param {HTMLElement} $container  The outer progress div (shown/hidden)
 * @param {HTMLElement} $bar        The <progress> element
 * @param {HTMLElement} $report     The result/report div (hidden while running)
 * @param {number} total            Total items for the bar's max
 */
function showOperationProgress($container, $bar, $report, total) {
  if ($container) $container.style.display = "block";
  if ($bar) { $bar.value = 0; if (total != null) $bar.max = total; }
  if ($report) $report.style.display = "none";
}

/** Hide the progress section when an operation completes. */
function hideOperationProgress($container) {
  if ($container) $container.style.display = "none";
}

/**
 * Update a progress bar + label with an automatically-calculated ETA.
 * Call once per loop iteration instead of duplicating 5 lines in every loop.
 *
 * @param {HTMLElement} $bar       <progress> element
 * @param {HTMLElement} $text      Progress text element
 * @param {number} processed       Items done so far (1-based)
 * @param {number} total           Total items
 * @param {number} loopStart       Date.now() captured at loop start
 * @param {string} label           Full text to show (filename, count, etc.)
 */
function updateProgressBar($bar, $text, processed, total, loopStart, label) {
  if ($bar) $bar.value = processed;
  if ($text) {
    const elapsed = Date.now() - loopStart;
    const avgMs   = processed > 1 ? elapsed / (processed - 1) : 0;
    const eta     = (processed >= 4 && avgMs > 0 && (total - processed) > 0)
      ? ` · ⏱ ${_fmtEta(avgMs * (total - processed))}` : "";
    $text.textContent = `${label}${eta}`;
  }
}

/**
 * Yield for GC every 10 iterations + recycle the offscreen AI document every 50.
 * Call inside any face-detection loop to prevent OOM on large photo libraries.
 *
 * @param {number} processed    Items done so far
 * @param {number} total        Total items
 * @param {HTMLElement} $text   Progress text element (shows "♻️ Refreshing…" during recycle)
 */
async function yieldForGC(processed, total, $text) {
  if (processed % 10 === 0) await new Promise(r => setTimeout(r, 0));
  if (processed % 50 === 0 && processed < total) {
    if ($text) $text.textContent = `♻️ Refreshing AI memory… (${processed}/${total})`;
    await chrome.runtime.sendMessage({ type: "RECYCLE_OFFSCREEN" }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
  }
}

/* ================================================================== */
/*  User Guide + Changelog — dynamic markdown loader                  */
/*  Content lives in userguide.md and changelog.md (extension root).  */
/*  To update the guide: edit those files — no code changes needed.   */
/* ================================================================== */

/**
 * Convert a subset of Markdown to HTML for the guide/changelog panels.
 *
 * Supported syntax:
 *   # Title             → green h3 heading
 *   ## Section          → white h4 section heading (with top border)
 *   ### N. Step Title   → numbered step card (same style as tutorial-step)
 *   > Tip text          → yellow tutorial-tip box (single or multi-line)
 *   [option-a]...[/option-a] → green left-border option box
 *   [option-b]...[/option-b] → blue left-border option box
 *   [phase-N]...[/phase-N]   → coloured phase info box
 *   - item or * item    → bullet list
 *   ---                 → horizontal rule
 *   **text**            → <strong>
 *   *text*              → <em>
 *   `code`              → inline code span
 *   [text](url)         → external link
 *   Blank lines         → paragraph boundaries
 */
function mdToHtml(md) {
  // Pre-process: replace custom block tags before paragraph splitting
  let text = md
    .replace(/\[option-a\]([\s\S]*?)\[\/option-a\]/g, (_, c) =>
      `\n\n<div class="guide-option-a">${mdInline(c.trim())}</div>\n\n`)
    .replace(/\[option-b\]([\s\S]*?)\[\/option-b\]/g, (_, c) =>
      `\n\n<div class="guide-option-b">${mdInline(c.trim())}</div>\n\n`)
    .replace(/\[phase-1\]([\s\S]*?)\[\/phase-1\]/g, (_, c) =>
      `\n\n<div class="guide-phase guide-phase-1">${mdInline(c.trim())}</div>\n\n`)
    .replace(/\[phase-2\]([\s\S]*?)\[\/phase-2\]/g, (_, c) =>
      `\n\n<div class="guide-phase guide-phase-2">${mdInline(c.trim())}</div>\n\n`)
    .replace(/\[phase-3\]([\s\S]*?)\[\/phase-3\]/g, (_, c) =>
      `\n\n<div class="guide-phase guide-phase-3">${mdInline(c.trim())}</div>\n\n`)
    .replace(/\[phase-4\]([\s\S]*?)\[\/phase-4\]/g, (_, c) =>
      `\n\n<div class="guide-phase guide-phase-4">${mdInline(c.trim())}</div>\n\n`);

  let html = '';
  for (const rawBlock of text.split(/\n{2,}/)) {
    const block = rawBlock.trim();
    if (!block) continue;

    // Pre-rendered HTML blocks — pass through unchanged
    if (block.startsWith('<div class="guide-')) { html += block; continue; }

    const lines = block.split('\n');
    const first = lines[0];

    if (first.startsWith('# ')) {
      html += `<h3 class="guide-h1">${mdInline(first.slice(2))}</h3>`;
      if (lines.length > 1) html += `<p class="guide-p">${mdInline(lines.slice(1).join(' '))}</p>`;
    } else if (first.startsWith('## ')) {
      html += `<h4 class="guide-h2">${mdInline(first.slice(3))}</h4>`;
    } else if (/^### (\d+)\.\s+(.+)/.test(first)) {
      // Numbered step card
      const m = first.match(/^### (\d+)\.\s+(.+)/);
      const body = lines.slice(1).map(l => mdInline(l)).join('<br>');
      html += `<div class="tutorial-step"><span class="step-num">${m[1]}</span><div>` +
        `<p><strong>${mdInline(m[2])}</strong></p>` +
        (body ? `<p style="margin-top:4px;color:var(--muted);">${body}</p>` : '') +
        `</div></div>`;
    } else if (first.startsWith('> ')) {
      const tip = lines.map(l => l.replace(/^> ?/, '')).join('<br>');
      html += `<div class="tutorial-tip">${mdInline(tip)}</div>`;
    } else if (first === '---') {
      html += '<hr class="guide-hr">';
    } else if (lines.every(l => /^[-*]\s/.test(l.trim()) || !l.trim())) {
      const items = lines.filter(l => /^[-*]\s/.test(l.trim()))
        .map(l => `<li>${mdInline(l.trim().slice(2))}</li>`);
      html += `<ul class="guide-ul">${items.join('')}</ul>`;
    } else {
      html += `<p class="guide-p">${lines.map(l => mdInline(l)).join('<br>')}</p>`;
    }
  }
  return html;
}

/** Apply inline markdown: **bold**, *italic*, `code`, [text](url). */
function mdInline(text) {
  return (text || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em style="color:var(--success)">$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-size:11px;font-family:monospace;">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="guide-a">$1</a>');
}

/**
 * Fetch userguide.md from the extension package and render it into #guideTabGuide.
 * Falls back gracefully on error.
 */
async function loadUserGuide() {
  const $el = document.getElementById("guideTabGuide");
  if (!$el) return;
  try {
    const md = await fetch(chrome.runtime.getURL("userguide.md")).then(r => r.text());
    $el.innerHTML = mdToHtml(md);
  } catch (e) {
    $el.innerHTML = '<p class="guide-p">⚠ Could not load user guide. Try reloading the extension.</p>';
    console.warn("[loadUserGuide]", e.message);
  }
}

/**
 * Fetch changelog.md from the extension package and render it into #guideTabChangelog.
 * Falls back gracefully on error.
 */
async function loadChangelog() {
  const $el = document.getElementById("guideTabChangelog");
  if (!$el) return;
  try {
    const md = await fetch(chrome.runtime.getURL("changelog.md")).then(r => r.text());
    $el.innerHTML = mdToHtml(md);
  } catch (e) {
    $el.innerHTML = '<p class="guide-p">⚠ Could not load changelog. Try reloading the extension.</p>';
    console.warn("[loadChangelog]", e.message);
  }
}

/** Wire the [📖 Guide] / [📋 What's New] tab buttons inside the tutorial card. */
function initGuideTabs() {
  document.querySelectorAll(".guide-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tabId = `guideTab${btn.dataset.guideTab.charAt(0).toUpperCase() + btn.dataset.guideTab.slice(1)}`;
      document.querySelectorAll(".guide-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".guide-tab-content").forEach(c => c.classList.toggle("active", c.id === tabId));
    });
  });
}

/* ================================================================== */
/*  Sidebar tab navigation                                             */
/* ================================================================== */

const navBtns  = document.querySelectorAll(".nav-btn");
const panels   = document.querySelectorAll(".tab-panel");
const $kbHints = document.getElementById("keyboardHints");
let activeTab  = "scan";
let _reviewsSinceReEval = 0; // counts approvals/rejections since last re-evaluation
const RE_EVAL_AFTER_N_REVIEWS = 10; // trigger queue re-evaluation every N reviews
let _reEvalRunning = false; // prevent concurrent re-evaluations
let _queueUpdateDebounceTimer = null; // coalesce multiple REVIEW_QUEUE_UPDATED messages
let _localActionInProgress = false;   // true during approve/reject API calls — skip background updates

function switchTab(tabName) {
  activeTab = tabName;
  navBtns.forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  panels.forEach(p => {
    const panelMap = { scan: "tabScan", review: "tabReview", log: "tabLog", settings: "tabSettings" };
    p.classList.toggle("active", p.id === panelMap[tabName]);
  });
  // Show keyboard hints only on review tab
  if ($kbHints) $kbHints.style.display = tabName === "review" ? "block" : "none";
  // Lazy-load data when switching to certain tabs
  if (tabName === "review") {
    refreshReviewQueue();
    // Auto re-evaluate queue when user returns to Review tab
    // This catches items that can now auto-resolve with descriptors
    // learned since the last time they visited the tab
    triggerReEvaluation();
  }
  if (tabName === "log") loadActivityLog();
  if (tabName === "settings") {
    initSettingsTab();      // one-time: event wiring (guarded by _settingsInited)
    loadSettingsChildren(); // always: refresh confidence data on every tab visit
  }
}

navBtns.forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// Handle hash-based deep links (e.g. dashboard.html#settings)
if (location.hash) {
  const tab = location.hash.replace("#", "");
  if (["scan", "review", "log", "settings"].includes(tab)) {
    switchTab(tab);
  }
}

/* ================================================================== */
/*  SCAN TAB                                                           */
/* ================================================================== */

const $childSelect  = document.getElementById("childSelect");
const $btnRefresh   = document.getElementById("btnRefresh");
const $btnLatest    = document.getElementById("btnExtractLatest");
const $btnDeep      = document.getElementById("btnDeepRescan");
const $btnTest      = document.getElementById("btnTestConnection");
const $btnStop      = document.getElementById("btnStopScan");
const $statusDot    = document.getElementById("statusDot");
const $statusText   = document.getElementById("statusText");
const $progressBar  = document.getElementById("progressBar");
const $progressText = document.getElementById("progressText");
const $scanLog      = document.getElementById("scanLogBox");
const $btnFollowScanLog     = document.getElementById("btnFollowScanLog");
const $btnFollowActivityLog = document.getElementById("btnFollowActivityLog");
let _scanLogFollowing     = true; // false when user has scrolled up
let _activityLogFollowing = true;
const $phaseBadge   = document.getElementById("phaseBadge");
const $btnResume          = document.getElementById("btnResumeScan");
const $resumeInfo         = document.getElementById("resumeInfo");
const $btnOfflineScanMain = document.getElementById("btnOfflineScanMain");

const ALL_CHILDREN = "__ALL__";
let isRunning = false;

function setStatus(color, text) {
  $statusDot.className = "dot" + (color ? ` ${color}` : "");
  $statusText.textContent = text;
}

function _updateFollowBtn(el, btn, following) {
  if (!btn) return;
  btn.style.display = following ? "none" : "flex";
}

function _isAtBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 15;
}

function scanLog(message) {
  if ($scanLog.firstElementChild?.textContent === "Waiting for action…") $scanLog.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = message;
  $scanLog.appendChild(p);
  // Only auto-scroll when following
  if (_scanLogFollowing) {
    $scanLog.scrollTop = $scanLog.scrollHeight;
  }
  _updateFollowBtn($scanLog, $btnFollowScanLog, _scanLogFollowing);
}

// Smart scroll listeners — pause auto-scroll when user scrolls up
$scanLog.addEventListener("scroll", () => {
  _scanLogFollowing = _isAtBottom($scanLog);
  _updateFollowBtn($scanLog, $btnFollowScanLog, _scanLogFollowing);
});
$btnFollowScanLog?.addEventListener("click", () => {
  _scanLogFollowing = true;
  $scanLog.scrollTop = $scanLog.scrollHeight;
  _updateFollowBtn($scanLog, $btnFollowScanLog, true);
});

function setRunning(running) {
  isRunning = running;
  $btnLatest.disabled = running;
  $btnDeep.disabled   = running;
  $childSelect.disabled = running;
  $btnRefresh.disabled  = running;
  $btnLatest.style.display = running ? "none" : "";
  $btnDeep.style.display   = running ? "none" : "";
  $btnStop.style.display   = running ? "inline-flex" : "none";
  // Global stop banner — visible on ALL tabs when scanning
  const $globalBanner = document.getElementById("globalScanBanner");
  const $globalStop   = document.getElementById("btnGlobalStop");
  if ($globalBanner) $globalBanner.style.display = running ? "block" : "none";
  if ($globalStop && !running) {
    $globalStop.disabled = false;
    $globalStop.textContent = "🛑 Stop Scan";
  }
  // Also disable/enable the Offline Facial Scan button
  if ($btnOfflineScanMain) {
    $btnOfflineScanMain.disabled = running || !$childSelect.value;
  }
  if (!running) {
    $btnStop.disabled = false;
    $btnStop.textContent = "🛑 Stop Scan";
    $progressBar.style.display = "none";
    $progressText.style.display = "none";
  }
}

function populateChildren(children) {
  $childSelect.innerHTML = "";
  if (!children || children.length === 0) {
    $childSelect.innerHTML = '<option value="">No children found — open Storypark first</option>';
    $btnLatest.disabled = true;
    $btnDeep.disabled = true;
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
      $btnLatest.disabled = false;
      $btnDeep.disabled = false;
    }
  });
}

$childSelect.addEventListener("change", () => {
  chrome.storage.local.set({ lastSelectedChildId: $childSelect.value });
  if (!isRunning && $childSelect.value) {
    $btnLatest.disabled = false;
    $btnDeep.disabled = false;
    if ($btnOfflineScanMain) $btnOfflineScanMain.disabled = false;
  } else if (!$childSelect.value) {
    $btnLatest.disabled = true;
    $btnDeep.disabled = true;
    if ($btnOfflineScanMain) $btnOfflineScanMain.disabled = true;
  }
  loadChildPhase();
  checkForResume();
});

/** Check if a scan checkpoint exists for the selected child and show/hide the Resume button. */
function checkForResume() {
  const childId = $childSelect.value;
  if (!childId || childId === ALL_CHILDREN) {
    $btnResume.style.display = "none";
    $resumeInfo.style.display = "none";
    return;
  }
  send({ type: "GET_SCAN_CHECKPOINT", childId }).then(res => {
    if (res?.ok && res.checkpoint) {
      const cp = res.checkpoint;
      $btnResume.style.display = "";
      $btnResume.disabled = isRunning;
      const _resumeRemaining = (cp.totalStories || 0) - (cp.storyIndex || 0);
      $btnResume.textContent = `▶ Resume from story ${cp.storyIndex} (${_resumeRemaining} remaining)`;
      $resumeInfo.style.display = "block";
      $resumeInfo.innerHTML = `⏸ Interrupted scan: story ${cp.storyIndex} of ${cp.totalStories} · Mode: ${cp.mode === "DEEP_RESCAN" ? "Full History" : "Latest"} · <a href="#" id="clearCheckpointLink" style="color:#a855f7;text-decoration:underline;">Clear</a>`;
      // Wire up clear link
      setTimeout(() => {
        const link = document.getElementById("clearCheckpointLink");
        if (link) link.addEventListener("click", async (e) => {
          e.preventDefault();
          // Clear the checkpoint by sending a dummy resume that will just clear it
          await chrome.storage.local.remove(`scanCheckpoint_${childId}`).catch(() => {});
          // Also clear via background's DB function
          await send({ type: "GET_SCAN_CHECKPOINT", childId }); // Just to confirm it's gone after we re-check
          $btnResume.style.display = "none";
          $resumeInfo.style.display = "none";
          toast("✓ Checkpoint cleared");
        });
      }, 0);
    } else {
      $btnResume.style.display = "none";
      $resumeInfo.style.display = "none";
    }
  });
}

/**
 * Create a small JPEG thumbnail from a data URL for Review tab card display.
 * Used by the Offline Smart Scan to generate thumbnails without face cropping.
 *
 * @param {string} dataUrl  Full image data URL
 * @param {number} maxDim   Max width or height (default 200px)
 * @returns {Promise<string>}  Small data URL (~10-20KB)
 */
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

/**
 * Load and display a confidence summary for ALL children.
 * Called when "All Children" is selected in the child dropdown.
 */
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

    // Fetch phase + confidence asynchronously
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
  // When "All Children" is selected, show the multi-child confidence panel instead
  const $panel = document.getElementById("allChildrenPanel");
  if (childId === ALL_CHILDREN) {
    $phaseBadge.style.display = "none";
    const $conf = document.getElementById("confidenceBadge");
    if ($conf) $conf.style.display = "none";
    loadAllChildrenConfidence();
    return;
  }
  if ($panel) $panel.style.display = "none";
  if (!childId) { $phaseBadge.style.display = "none"; return; }
  chrome.runtime.sendMessage({ type: "GET_CHILD_PHASE", childId }, res => {
    if (!res?.ok) { $phaseBadge.style.display = "none"; return; }
    const p = res.phase;
    $phaseBadge.style.display = "inline-block";
    $phaseBadge.className = `phase-badge phase-${p.phase}`;
    const _need1 = Math.max(0, 10  - p.verifiedCount);
    const _need2 = Math.max(0, 50  - p.verifiedCount);
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
  });
  // Also fetch model confidence
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

$btnRefresh.addEventListener("click", () => {
  $childSelect.innerHTML = "<option>Refreshing…</option>";
  $btnLatest.disabled = true;
  $btnDeep.disabled = true;
  send({ type: "REFRESH_PROFILE" }).then(res => {
    if (res?.ok) { populateChildren(res.children); updateCentreInfo(); }
    else $childSelect.innerHTML = '<option value="">Failed — open Storypark first</option>';
  });
});

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
  $progressBar.value = 0; $progressBar.max = 100;
  $progressBar.style.display = "block";
  $progressText.style.display = "block";
  $progressText.textContent = "Starting…";
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

$btnLatest.addEventListener("click", () => triggerExtraction("EXTRACT_LATEST"));
$btnDeep.addEventListener("click", () => triggerExtraction("DEEP_RESCAN"));

// Offline Facial Scan button — runs face matching on local disk files
$btnOfflineScanMain?.addEventListener("click", () => triggerOfflineScan());

/**
 * Trigger the Offline Facial Scan from the Scan tab.
 * Supports both single-child and All-Children modes.
 * Uses the Scan tab's progress bar and log — same UX as online scans.
 * Works with zero training data (everything queued for review).
 */
async function triggerOfflineScan() {
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

  // Determine which children to scan
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
  $progressBar.value = 0; $progressBar.max = 100;
  $progressBar.style.display = "block";
  $progressText.style.display = "block";
  setStatus("yellow", "Offline Facial Scan…");
  scanLog(`🔍 Starting Offline Facial Scan for ${childId === ALL_CHILDREN ? "all children" : childrenToScan[0].name}…`);
  scanLog("⚡ Reading photos from disk — no internet needed.");

  // Get thresholds + scenario photo setting
  const settingsData = await chrome.storage.local.get(["autoThreshold", "minThreshold", "keepScenarioPhotos"]).catch(() => ({}));
  const autoThreshold = settingsData.autoThreshold ?? 85;
  const minThreshold  = settingsData.minThreshold  ?? 50;
  const keepScenarioPhotos = settingsData.keepScenarioPhotos ?? false;
  const year = new Date().getFullYear().toString();
  const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;
  const INVALID_CHARS = /[/\\:*?"<>|]/g;

  let totalAutoApproved = 0, totalQueued = 0, totalRejected = 0, totalNoFace = 0;

  for (const child of childrenToScan) {
    const cId = child.id;
    const cName = child.name;
    const childSafe = cName.replace(INVALID_CHARS, "_").trim();
    // Detect whether the SSS folder itself is linked (paths differ):
    //   SSS linked:    "Harry Hill/Stories/..."
    //   Parent linked: "Storypark Smart Saver/Harry Hill/Stories/..."
    const _sssLinked     = handle.name === "Storypark Smart Saver";
    const storiesPrefix  = _sssLinked ? `${childSafe}/Stories` : `Storypark Smart Saver/${childSafe}/Stories`;
    const rejectedPrefix = _sssLinked ? `${childSafe} Rejected Matches/Stories` : `Storypark Smart Saver/${childSafe} Rejected Matches/Stories`;

    scanLog(`\n👶 Scanning ${cName}…`);

    // Get stored descriptors (may be empty → Phase 1 mode, queue everything)
    const rec = await getDescriptors(cId).catch(() => null);
    const storedDescs = rec?.descriptors || [];
    if (storedDescs.length === 0) {
      scanLog(`  📚 No face training for ${cName} yet — all detected faces will go to Review tab (Phase 1 mode)`);
    }

    // Load story manifests for fingerprint cache lookup (storyId + originalUrl)
    const allManifests = await getAllDownloadedStories().catch(() => []);
    const childManifests = allManifests.filter(m => m.childId === cId || m.childName === cName);
    const manifestByFolder = new Map(childManifests.map(m => [m.folderName, m]));

    // Walk child's Stories AND Rejected Matches folders (no skipRejected filter)
    // We include Rejected Matches so the improved model can rescue incorrectly rejected photos
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
    $progressBar.max = imageFiles.length;

    let autoApproved = 0, queued = 0, rejected = 0, noFace = 0, errors = 0;
    const _childLoopStart = Date.now(); // ETA tracking per child

    for (let i = 0; i < imageFiles.length; i++) {
      const filePath = imageFiles[i];
      updateProgressBar($progressBar, $progressText, i + 1, imageFiles.length, _childLoopStart,
        `${cName}: ${i + 1}/${imageFiles.length} — ${filePath.split("/").pop()}`);

      try {
        const dataUrl = await readFileAsDataUrl(handle, filePath);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

        let faces = [];
        try { faces = await detectFaces(img); } catch { /* model error */ }

        if (faces.length === 0) {
          noFace++;
          // Scenario photo: queue for review unless auto-keep is on
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

        // Parse file path to find manifest (for fingerprint cache + review card info)
        // Structure: ROOT/childName/Stories/folderName/filename (or Rejected Matches variant)
        const pathParts       = filePath.split("/");
        const folderName      = pathParts.length >= 5 ? pathParts[3] : null;
        const filenameInPath  = pathParts[pathParts.length - 1];
        const manifest        = folderName ? manifestByFolder.get(folderName) : null;
        const isFromRejected  = filePath.includes(" Rejected Matches/");

        // Compute the original Stories path for auto-rescue on approval.
        // Rejected Matches path: ROOT/ChildName Rejected Matches/Stories/folder/file.jpg
        // Original path:         ROOT/ChildName/Stories/folder/file.jpg
        const originalFilePath = isFromRejected
          ? filePath.split("/").map((p, i) => i === 1 ? p.replace(/ Rejected Matches$/, "") : p).join("/")
          : filePath;

        // Resolve Storypark originalUrl for fingerprint cache (fully offline lookup via IDB)
        const mediaEntry = manifest?.mediaUrls?.find(m => m.filename === filenameInPath);
        const originalUrl = mediaEntry?.originalUrl || null;

        // Save fingerprint cache — allows next online Deep Rescan to skip re-downloading this image
        // Key: storyId_originalUrl — matches what background.js fingerprint cache uses
        if (manifest?.storyId && originalUrl && faces.length > 0) {
          await saveImageFingerprint({
            storyId:  manifest.storyId,
            imageUrl: originalUrl,
            childId:  cId,
            faces:    faces
              .filter(f => f.embedding)
              .map(f => ({ descriptor: Array.from(f.embedding) })),
            noFace:   false,
          }).catch(() => {});
        }

        // If no training data: treat as medium confidence (send to review)
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
            originalFilePath, // original Stories path for auto-rescue on approval
          });
          queued++;
        } else {
          if (bestDescriptor) await appendNegativeDescriptor(cId, Array.from(bestDescriptor));
          rejected++;
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

  // Refresh Review tab badge
  await refreshReviewQueue();

  setRunning(false);
  setStatus("green", "Offline scan complete");
  const summary = `✅ Offline Scan Done — ${totalAutoApproved} confirmed, ${totalQueued} to review, ${totalRejected} rejected`;
  scanLog(`\n${summary}`);
  if (totalQueued > 0) scanLog(`💡 Go to the 👀 Pending Review tab — ${totalQueued} photos need your decision.`);
  toast(summary, "success", 6000);
}
$btnStop.addEventListener("click", () => {
  send({ type: "CANCEL_SCAN" });
  $btnStop.disabled = true;
  $btnStop.textContent = "⏳ Cancelling…";
  // Also update global stop banner
  const $gs = document.getElementById("btnGlobalStop");
  if ($gs) { $gs.disabled = true; $gs.textContent = "⏳ Cancelling…"; }
  setStatus("yellow", "Cancelling…");
  scanLog("⏹ Cancellation requested…");
});

// Global stop button (visible on ALL tabs)
document.getElementById("btnGlobalStop")?.addEventListener("click", () => {
  send({ type: "CANCEL_SCAN" });
  const $gs = document.getElementById("btnGlobalStop");
  if ($gs) { $gs.disabled = true; $gs.textContent = "⏳ Cancelling…"; }
  $btnStop.disabled = true;
  $btnStop.textContent = "⏳ Cancelling…";
  setStatus("yellow", "Cancelling…");
  scanLog("⏹ Cancellation requested…");
});

// Resume scan button
$btnResume.addEventListener("click", () => {
  if (isRunning) return;
  const childId = $childSelect.value;
  const childName = $childSelect.options[$childSelect.selectedIndex]?.text || "";
  if (!childId || childId === ALL_CHILDREN) return;
  setRunning(true);
  $btnResume.style.display = "none";
  $resumeInfo.style.display = "none";
  $scanLog.innerHTML = "";
  $progressBar.value = 0; $progressBar.max = 100;
  $progressBar.style.display = "block";
  $progressText.style.display = "block";
  $progressText.textContent = "Resuming scan…";
  setStatus("yellow", "Resuming scan…");
  scanLog("▶ Resuming interrupted scan…");
  send({ type: "RESUME_SCAN", childId, childName }).then(res => {
    setRunning(false);
    checkForResume(); // Check if a new checkpoint was created (cancelled again)
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

$btnTest.addEventListener("click", () => {
  $btnTest.disabled = true;
  $btnTest.textContent = "⏳ Testing…";
  send({ type: "TEST_CONNECTION" }).then(res => {
    $btnTest.disabled = false;
    $btnTest.textContent = "🔌 Test Connection";
    if (res?.ok) toast(`✅ Connected${res.email ? ` (${res.email})` : ""}`, "success");
    else toast(`❌ Not connected${res?.error ? `: ${res.error}` : ""}`, "error");
  });
});

/* ================================================================== */
/*  REVIEW TAB                                                         */
/* ================================================================== */

const $reviewGrid  = document.getElementById("reviewGrid");
const $reviewEmpty = document.getElementById("reviewEmpty");
const $reviewCount = document.getElementById("reviewCount");
const $btnUndo     = document.getElementById("btnUndo");
const $btnRefreshR = document.getElementById("btnRefreshReview");
const $btnBatch    = document.getElementById("btnBatchDownload");
const $btnBuildHtml = document.getElementById("btnBuildHtml");
const $btnFinalV   = document.getElementById("btnFinalVerify");
const $lightbox    = document.getElementById("lightbox");
const $lbImg       = document.getElementById("lightboxImg");
const $reviewBadge = document.getElementById("reviewBadge");

let reviewQueue = [];
const selectedFace = new Map();
const childPhaseCache = new Map();
let _prevChildIds = new Set();
const REVIEW_PAGE_SIZE = 10; // render only N cards at a time to keep DOM light
let _reviewPageStart = 0;    // current page offset into reviewQueue
let _pendingNewCount = 0;    // items found during scan but not yet rendered
let _totalAutoResolved = 0;  // running total of items auto-resolved by AI this session
const $reviewStatus = document.getElementById("reviewStatusBar");
const $reviewStatusText = document.getElementById("reviewStatusText");

/** Cache for full-resolution images loaded from Storypark (blob URLs). */
const _fullImageCache = new Map();

/**
 * Open the lightbox. If an originalUrl is provided, load the full-resolution
 * image from Storypark (with caching) and swap it in once ready.
 * Shows the thumbnail immediately while the full image loads.
 */
function openLightbox(thumbnailSrc, originalUrl) {
  if (!thumbnailSrc && !originalUrl) return;
  // Show thumbnail immediately
  $lbImg.src = thumbnailSrc || "";
  $lightbox.classList.add("open");

  // If we have an originalUrl, fetch the full-res image
  if (originalUrl) {
    if (_fullImageCache.has(originalUrl)) {
      $lbImg.src = _fullImageCache.get(originalUrl);
      return;
    }
    // Show loading indicator
    $lbImg.style.opacity = "0.6";
    fetch(originalUrl, { credentials: "include" })
      .then(res => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.blob();
      })
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        _fullImageCache.set(originalUrl, blobUrl);
        // Only update if lightbox is still open showing this image
        if ($lightbox.classList.contains("open")) {
          $lbImg.src = blobUrl;
          $lbImg.style.opacity = "1";
        }
      })
      .catch(() => {
        // Failed to load full image — keep showing thumbnail
        $lbImg.style.opacity = "1";
      });
  }
}
$lightbox.addEventListener("click", () => { $lightbox.classList.remove("open"); $lbImg.src = ""; $lbImg.style.opacity = "1"; });

/** Update the review status bar below the header */
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

/** Build a single review card DOM element for the given queue item. */
function buildCardElement(item) {
  const faceIdx = selectedFace.get(item.id) ?? 0;
  const card = document.createElement("div");
  card.className = "review-card";
  card.dataset.id = item.id;

  // Image column — show full photo thumbnail with face selector below
  const imgCol = document.createElement("div");
  imgCol.className = "card-image";

  // Main image: full photo thumbnail (zoomed out) if available, else cropped face
  const fullSrc = item.fullPhotoDataUrl || "";
  const faceSrc = item.allFaces?.[faceIdx]?.croppedDataUrl || item.croppedFaceDataUrl || "";
  const mainSrc = fullSrc || faceSrc;

  const mainImg = document.createElement("img");
  mainImg.src = mainSrc;
  mainImg.alt = fullSrc ? "Full photo" : "Detected face";
  mainImg.style.cursor = "pointer";
  // Pass originalUrl so lightbox can load full-res image from Storypark
  const originalUrl = item.storyData?.originalUrl || "";
  mainImg.addEventListener("click", () => openLightbox(mainSrc, originalUrl));
  imgCol.appendChild(mainImg);

  // Face selector: show cropped faces below the full photo for multi-face or single-face items
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
      btn.addEventListener("click", () => { selectedFace.set(item.id, i); renderReview(); });
      sel.appendChild(btn);
    });
    imgCol.appendChild(sel);
  } else if (faceSrc && fullSrc) {
    // Single face + full photo available: show the face crop as a small indicator
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

  // Info column
  const info = document.createElement("div");
  info.className = "card-info";
  const nameEl = document.createElement("div");
  nameEl.className = "child-name";
  nameEl.textContent = item.childName || "Unknown";
  info.appendChild(nameEl);
  const pctVal = item.allFaces?.[faceIdx]?.matchPct ?? item.matchPct ?? 0;
  const pctEl = document.createElement("div");
  if (item.noFace) {
    // Activity photo — no face detected (artwork, group scene, etc.)
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

  // Actions column
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const childPhase = childPhaseCache.get(item.childId)?.phase ?? 1;
  // Phase 1+2: defer downloads, only train. Phase 3: download immediately.
  const isTrainingPhase = childPhase < 3;
  const isNoFacePhoto = item.noFace === true;

  if (isNoFacePhoto) {
    // Activity photo (no face detected) — user can keep or skip
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

/** Full DOM rebuild of the review grid — used only on tab switch, manual refresh, or initial load. */
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

  // Paginate: only render a page of items to keep DOM light
  const pageEnd = Math.min(_reviewPageStart + REVIEW_PAGE_SIZE, reviewQueue.length);
  const pageItems = reviewQueue.slice(_reviewPageStart, pageEnd);
  updateReviewStatus();

  for (const item of pageItems) {
    $reviewGrid.appendChild(buildCardElement(item));
  }
}

/**
 * Animated removal of a single card from the grid.
 * Fades out, removes from local reviewQueue, and fills the gap with the next item.
 */
function removeCardAnimated(id) {
  // Remove from local reviewQueue array
  const idx = reviewQueue.findIndex(i => i.id === id);
  if (idx !== -1) reviewQueue.splice(idx, 1);
  selectedFace.delete(id);

  // Update badge + count
  if (reviewQueue.length > 0) {
    $reviewBadge.style.display = "";
    $reviewBadge.textContent = reviewQueue.length;
    $reviewCount.textContent = `${reviewQueue.length} media file${reviewQueue.length !== 1 ? "s" : ""} to review`;
  } else {
    $reviewBadge.style.display = "none";
    $reviewCount.textContent = "No items";
  }

  // Animate the card out
  const card = $reviewGrid.querySelector(`[data-id="${id}"]`);
  if (card) {
    card.classList.add("removing");
    card.addEventListener("transitionend", () => {
      card.remove();
      _fillPageGap();
    }, { once: true });
    // Fallback: if transitionend doesn't fire (e.g. card not visible), remove after timeout
    setTimeout(() => {
      if (card.parentNode) {
        card.remove();
        _fillPageGap();
      }
    }, 400);
  } else {
    _fillPageGap();
  }

  // Show empty state if queue is now empty
  if (reviewQueue.length === 0) {
    $reviewEmpty.style.display = "block";
  }

  updateReviewStatus();
}

/**
 * After a card is removed, check if we need to append the next card to fill the page.
 * Keeps the visible page at REVIEW_PAGE_SIZE items when more items exist in the queue.
 */
function _fillPageGap() {
  const visibleCount = $reviewGrid.querySelectorAll(".review-card:not(.removing)").length;
  const pageEnd = Math.min(_reviewPageStart + REVIEW_PAGE_SIZE, reviewQueue.length);

  // If there are more items in the queue beyond what's visible, append the next one
  if (visibleCount < REVIEW_PAGE_SIZE && pageEnd > _reviewPageStart + visibleCount) {
    const nextIdx = _reviewPageStart + visibleCount;
    if (nextIdx < reviewQueue.length) {
      const newCard = buildCardElement(reviewQueue[nextIdx]);
      newCard.classList.add("appearing");
      $reviewGrid.appendChild(newCard);
      // Remove animation class after it completes
      newCard.addEventListener("animationend", () => newCard.classList.remove("appearing"), { once: true });
    }
  }

  // Clamp page start if we've gone past the end
  if (_reviewPageStart >= reviewQueue.length && reviewQueue.length > 0) {
    _reviewPageStart = 0;
    renderReview(); // full rebuild since page position changed
  }

  updateReviewStatus();
}

/**
 * Append new review items to the grid incrementally (e.g. during scan or smart merge).
 * Only appends if the current page has room.
 */
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

/**
 * Smart merge: diff the fresh queue against the local queue and make incremental
 * DOM changes instead of wiping and rebuilding the entire grid.
 * - Removes cards that vanished (auto-resolved by AI)
 * - Appends new cards that appeared (from scanning)
 * - Leaves existing cards untouched
 */
async function mergeReviewQueue(freshQueue) {
  const freshIds = new Set(freshQueue.map(i => i.id));
  const localIds = new Set(reviewQueue.map(i => i.id));

  // Items that vanished from the queue (auto-resolved)
  const removedIds = [];
  for (const id of localIds) {
    if (!freshIds.has(id)) removedIds.push(id);
  }

  // Items that are new (from scanning or undo)
  const addedItems = freshQueue.filter(i => !localIds.has(i.id));

  // If there are no changes, just update the badge and return
  if (removedIds.length === 0 && addedItems.length === 0) {
    // Still update badge in case count changed elsewhere
    if (freshQueue.length > 0) {
      $reviewBadge.style.display = "";
      $reviewBadge.textContent = freshQueue.length;
    } else {
      $reviewBadge.style.display = "none";
    }
    return;
  }

  // Track auto-resolved items
  if (removedIds.length > 0) {
    _totalAutoResolved += removedIds.length;
  }

  // Remove vanished items
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

  // Add new items to the local queue
  reviewQueue.push(...addedItems);

  // Refresh phase cache for any new child IDs
  const newChildIds = new Set(addedItems.map(i => i.childId).filter(Boolean));
  for (const cid of newChildIds) {
    if (!childPhaseCache.has(cid)) {
      const phRes = await send({ type: "GET_CHILD_PHASE", childId: cid });
      if (phRes?.ok) childPhaseCache.set(cid, phRes.phase);
    }
  }

  // Append new cards to the grid after a brief delay (let removals animate out)
  setTimeout(() => {
    appendCards(addedItems);
  }, removedIds.length > 0 ? 380 : 0);

  // Update counts
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

/**
 * Trigger re-evaluation of review queue items using the enhanced matching
 * pipeline. Called periodically after approvals/rejections to auto-resolve
 * items that now match with improved face profiles.
 * Non-blocking — runs in background and refreshes UI on completion.
 */
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

/**
 * Auto-rescue a photo from the "Rejected Matches" folder when the user approves it.
 *
 * Flow:
 *   1. Move file back to original Stories location using FSA API
 *   2. Re-add the filename to the story's IDB manifest (approvedFilenames)
 *   3. Regenerate HTML so story.html includes the restored photo
 *
 * Non-fatal — if the file move fails (e.g. file already moved), the
 * descriptor was still learned and the user is notified.
 *
 * @param {Object} item  The Review queue item with isFromRejected + originalFilePath
 */
async function _rescueFromRejected(item) {
  try {
    const handle = await getLinkedFolder();
    if (!handle || !item.originalFilePath) return;

    // Move file back from Rejected Matches to original Stories location
    await restoreFromRejected(handle, item.originalFilePath);

    // Re-add filename to IDB manifest so story.html + index.html include it again
    const filename = item.originalFilePath.split("/").pop();
    const storyId  = item.storyData?.storyId;
    const childId  = item.childId;

    if (storyId && !storyId.startsWith("offline:") && childId && filename) {
      await send({ type: "ADD_FILE_TO_MANIFEST", childId, storyId, filename });
    }

    // Regenerate HTML to include the restored photo in story.html and index pages
    await send({ type: "BUILD_HTML_STRUCTURE" }).catch(() => {});

    toast(`✅ Rescued! "${filename}" moved back to ${item.childName}'s Stories folder`, "success", 5000);
  } catch (e) {
    console.warn("[rescue-from-rejected] Failed:", e.message);
    // Non-fatal: descriptor was still learned, file move may have failed
    toast(`⚠ Could not auto-move rescued photo (${e.message}) — face was still learned`, "error", 5000);
  }
}

async function handleReviewApprove(id, trainOnly = false) {
  const faceIdx = selectedFace.get(id) ?? 0;
  // Capture item data BEFORE the card is removed (for auto-rescue of Rejected Matches items)
  const queueItemSnapshot = reviewQueue.find(q => q.id === id);
  disableReviewCard(id);
  _localActionInProgress = true;
  const msgType = trainOnly ? "REVIEW_TRAIN_ONLY" : "REVIEW_APPROVE";
  const res = await send({ type: msgType, id, selectedFaceIndex: faceIdx });
  if (res?.ok) {
    toast(trainOnly ? "✅ Face learned (download deferred)" : "✓ Approved & downloading");
    $btnUndo.disabled = false; $btnUndo.style.opacity = "1";
    _reviewsSinceReEval++;
    // Auto-rescue: if approved from Rejected Matches folder, move file back automatically
    if (queueItemSnapshot?.isFromRejected && queueItemSnapshot?.originalFilePath) {
      _rescueFromRejected(queueItemSnapshot).catch(e => {
        console.warn("[rescue-from-rejected]", e.message);
      });
    }
    // Incremental card removal — no full DOM rebuild
    removeCardAnimated(id);
    updateBatchButton(); // fire-and-forget
    // Clear the action flag after a short delay to absorb trailing messages
    // but still allow rapid keyboard reviewing (was 2000ms, now 500ms)
    setTimeout(() => { _localActionInProgress = false; }, 500);
    // Trigger re-evaluation after every N reviews
    if (_reviewsSinceReEval >= RE_EVAL_AFTER_N_REVIEWS) {
      _reviewsSinceReEval = 0;
      triggerReEvaluation(); // fire-and-forget
    }
  } else {
    _localActionInProgress = false;
    toast(res?.error || "Approve failed", "error");
    enableReviewCard(id);
  }
}

async function handleReviewReject(id) {
  disableReviewCard(id);
  _localActionInProgress = true;
  const res = await send({ type: "REVIEW_REJECT", id });
  if (res?.ok) {
    toast("✗ Rejected");
    $btnUndo.disabled = false; $btnUndo.style.opacity = "1";
    _reviewsSinceReEval++;
    // Incremental card removal — no full DOM rebuild
    removeCardAnimated(id);
    // Clear the action flag after a short delay (was 2000ms, now 500ms for rapid reviewing)
    setTimeout(() => { _localActionInProgress = false; }, 500);
    // Trigger re-evaluation after every N reviews
    if (_reviewsSinceReEval >= RE_EVAL_AFTER_N_REVIEWS) {
      _reviewsSinceReEval = 0;
      triggerReEvaluation(); // fire-and-forget
    }
  } else {
    _localActionInProgress = false;
    toast(res?.error || "Reject failed", "error");
    enableReviewCard(id);
  }
}

async function handleUndo() {
  const res = await send({ type: "UNDO_LAST_REVIEW" });
  if (res?.ok) {
    toast("⤺ Undone");
    $btnUndo.disabled = true; $btnUndo.style.opacity = "0.4";
    await refreshReviewQueue();
  } else {
    toast(res?.error || "Nothing to undo", "error");
  }
}

function disableReviewCard(id) {
  const card = $reviewGrid.querySelector(`[data-id="${id}"]`);
  if (card) card.querySelectorAll("button").forEach(b => b.disabled = true);
}
function enableReviewCard(id) {
  const card = $reviewGrid.querySelector(`[data-id="${id}"]`);
  if (card) card.querySelectorAll("button").forEach(b => b.disabled = false);
}

async function refreshReviewQueue() {
  const res = await send({ type: "GET_REVIEW_QUEUE" });
  const prevIds = _prevChildIds;
  reviewQueue = res?.ok ? (res.queue || []) : [];
  _prevChildIds = new Set(reviewQueue.map(i => i.childId).filter(Boolean));
  _pendingNewCount = 0; // reset pending since we now have the full fresh queue

  // Update badge
  if (reviewQueue.length > 0) {
    $reviewBadge.style.display = "";
    $reviewBadge.textContent = reviewQueue.length;
  } else {
    $reviewBadge.style.display = "none";
  }

  // Clamp page start: if user approved/rejected all visible items,
  // the page may now be past the end. Move back to show items.
  if (_reviewPageStart >= reviewQueue.length && reviewQueue.length > 0) {
    // Auto-load: snap to beginning of the queue (new items come first)
    _reviewPageStart = 0;
  }

  // Refresh phase cache
  const childIds = new Set(reviewQueue.map(i => i.childId).filter(Boolean));
  for (const cid of childIds) {
    const phRes = await send({ type: "GET_CHILD_PHASE", childId: cid });
    if (phRes?.ok) childPhaseCache.set(cid, phRes.phase);
  }

  renderReview();

  // Phase advancement when queue empties
  if (reviewQueue.length === 0 && prevIds.size > 0) {
    for (const childId of prevIds) {
      const advRes = await send({ type: "ADVANCE_PHASE", childId });
      if (advRes?.advanced) {
        const p = advRes.phase;
        const ADV_EMOJIS = { 2: "✅", 3: "📊", 4: "" };
        const ADV_LABELS = { 2: "Validation", 3: "Confident", 4: "Production — downloads unlocked!" };
        toast(`${ADV_EMOJIS[p.phase] || "📊"} Phase ${p.phase}: ${ADV_LABELS[p.phase] || "Unknown"}`, "success", 5000);
      }
    }
  }

  await updateBatchButton();
}

async function updateBatchButton() {
  const res = await send({ type: "GET_PENDING_DOWNLOADS_COUNT" });
  const count = res?.ok ? res.count : 0;
  if (count > 0) {
    $btnBatch.textContent = `📥 Download ${count} Approved`;
    $btnBatch.style.display = "inline-flex";
    // Show Final Verification when there are pending downloads
    $btnFinalV.style.display = "inline-flex";
  } else {
    $btnBatch.style.display = "none";
    $btnFinalV.style.display = "none";
  }
  // Build HTML + Generate Cards are always visible (can regenerate from stored manifests anytime)
  $btnBuildHtml.style.display = "inline-flex";
  const $btnGenC = document.getElementById("btnGenerateCards");
  if ($btnGenC) $btnGenC.style.display = "inline-flex";
}


$btnBatch.addEventListener("click", async () => {
  $btnBatch.disabled = true;
  $btnBatch.textContent = "⏳ Downloading…";
  const res = await send({ type: "BATCH_DOWNLOAD_APPROVED" });
  if (res?.ok) {
    toast(`📥 Downloaded ${res.downloaded} photos`);
    if (res.failed > 0) {
      toast(`⚠ ${res.failed} item${res.failed !== 1 ? "s" : ""} failed — click again to retry`, "error", 6000);
    }
    // Auto-generate HTML structure after download
    toast("📄 Building HTML pages…", "success", 2000);
    await send({ type: "BUILD_HTML_STRUCTURE" });
    toast(`✅ Downloaded ${res.downloaded} photos + HTML built`, "success", 4000);
  } else {
    toast(res?.error || "Batch download failed", "error");
  }
  $btnBatch.disabled = false;
  await updateBatchButton();
});

// Build HTML — regenerate all HTML from stored manifests (no photo downloads)
$btnBuildHtml.addEventListener("click", async () => {
  $btnBuildHtml.disabled = true;
  $btnBuildHtml.textContent = "⏳ Building…";
  const res = await send({ type: "BUILD_HTML_STRUCTURE" });
  if (res?.ok) {
    toast(`📄 HTML rebuilt: ${res.storyCount} story pages + index pages`, "success", 4000);
  } else {
    toast(res?.error || "HTML build failed", "error");
  }
  $btnBuildHtml.disabled = false;
  $btnBuildHtml.textContent = "📄 Build HTML";
});


// Generate Story Cards — review tab button
document.getElementById("btnGenerateCards")?.addEventListener("click", async () => {
  const $btn = document.getElementById("btnGenerateCards");
  if ($btn) { $btn.disabled = true; $btn.textContent = "Generating..."; }
  const childId = $childSelect.value && $childSelect.value !== ALL_CHILDREN ? $childSelect.value : undefined;
  const res = await send({ type: "GENERATE_STORY_CARDS_ALL", ...(childId ? { childId } : {}) });
  if ($btn) { $btn.disabled = false; $btn.textContent = "Generate Cards"; }
  if (res?.ok) toast(res.generated + " cards generated", "success", 4000);
  else toast(res?.error || "Card generation failed", "error");
});

// Final Verification — re-check all pending against mature model
$btnFinalV.addEventListener("click", async () => {
  const childId = $childSelect.value;
  if (!childId || childId === ALL_CHILDREN) {
    toast("Select a specific child first", "error");
    return;
  }
  if (!confirm("Re-check all pending photos against your mature face model?\n\nThis will re-download and re-analyze each image.\nFalse positives will be removed, uncertain matches go back to review.")) return;
  $btnFinalV.disabled = true;
  $btnFinalV.textContent = "⏳ Verifying…";
  const res = await send({ type: "FINAL_VERIFICATION", childId });
  if (res?.ok) {
    const msg = `✅ Verified: ${res.verified}/${res.total} confirmed, ${res.rejected} rejected, ${res.flagged} flagged`;
    toast(msg, "success", 6000);
    await refreshReviewQueue();
    await updateBatchButton();
  } else {
    toast(res?.error || "Verification failed", "error");
  }
  $btnFinalV.disabled = false;
  $btnFinalV.textContent = "✅ Final Verification";
});

$btnUndo.addEventListener("click", handleUndo);
$btnRefreshR.addEventListener("click", refreshReviewQueue);

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
  if (e.key === "Escape" && $lightbox.classList.contains("open")) { $lightbox.classList.remove("open"); return; }
  if (activeTab !== "review" || reviewQueue.length === 0) return;
  // Guard: prevent rapid-fire hotkeys while an action is in flight
  if (_localActionInProgress) return;
  // Target the first VISIBLE card (respects pagination), not reviewQueue[0]
  const visibleItem = reviewQueue[_reviewPageStart];
  if (!visibleItem) return;
  const firstId = visibleItem.id;
  const kbPhase = childPhaseCache.get(visibleItem.childId)?.phase ?? 1;
  const kbTrainOnly = kbPhase < 3; // Phase 1+2: train only, defer downloads
  switch (e.key.toLowerCase()) {
    case "a": handleReviewApprove(firstId, kbTrainOnly); break;
    case "r": handleReviewReject(firstId); break;
    case "z": handleUndo(); break;
  }
});

/* ================================================================== */
/*  ACTIVITY LOG TAB                                                   */
/* ================================================================== */

const $activityLog = document.getElementById("activityLogBox");
const $btnClearLog = document.getElementById("btnClearLog");

function appendActivityEntry(entry) {
  if ($activityLog.children.length === 1 && $activityLog.firstElementChild?.textContent === "No activity yet.") {
    $activityLog.innerHTML = "";
  }
  const p = document.createElement("p");
  const datePart = entry.storyDate ? `${entry.storyDate} ` : "";
  const ts = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false });
  const cls = { SUCCESS: "level-SUCCESS", WARNING: "level-WARNING", ERROR: "level-ERROR", INFO: "" };
  p.className = cls[entry.level] || "";
  p.appendChild(document.createTextNode(`[${datePart}${ts}] [${entry.level}] ${entry.message}`));

  // Render metadata as inline pills if present (childName, centreName, roomName, counts, gps)
  if (entry.meta) {
    const m = entry.meta;
    // Each pill: { t: text, c: "r,g,b" CSS colour }
    const pills = [];
    if (m.childName)  pills.push({ t: `👶 ${m.childName}`,  c: "96,165,250"  });   // blue
    if (m.centreName) pills.push({ t: `🏫 ${m.centreName}`, c: "154,154,175" });  // muted
    if (m.roomName)   pills.push({ t: `🏠 ${m.roomName}`,   c: "154,154,175" });  // muted
    if (m.photoCount != null) pills.push({ t: `📷 ${m.photoCount}`, c: "74,222,128" });  // green
    if (m.approved   != null) pills.push({ t: `✅ ${m.approved}`,   c: "74,222,128" });  // green
    if (m.queued     != null && m.queued   > 0) pills.push({ t: `👀 ${m.queued}`,   c: "251,191,36"  }); // yellow
    if (m.rejected   != null && m.rejected > 0) pills.push({ t: `✗ ${m.rejected}`,  c: "154,154,175" }); // muted
    if (m.gps === true)  pills.push({ t: "📍 GPS",    c: "74,155,143" }); // teal
    if (m.gps === false) pills.push({ t: "📍 no GPS", c: "154,154,175" }); // muted
    if (pills.length > 0) {
      const wrap = document.createElement("span");
      wrap.style.marginLeft = "6px";
      for (const pill of pills) {
        const s = document.createElement("span");
        s.style.cssText = `display:inline-block;margin:0 2px;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(${pill.c},0.15);color:rgb(${pill.c});border:1px solid rgba(${pill.c},0.3);`;
        s.textContent = pill.t;
        wrap.appendChild(s);
      }
      p.appendChild(wrap);
    }
  }

  $activityLog.appendChild(p);
  if (_activityLogFollowing) {
    $activityLog.scrollTop = $activityLog.scrollHeight;
  }
  _updateFollowBtn($activityLog, $btnFollowActivityLog, _activityLogFollowing);
}

function loadActivityLog() {
  send({ type: "GET_ACTIVITY_LOG" }).then(res => {
    if (!res?.ok) return;
    $activityLog.innerHTML = "";
    if (!res.activityLog?.length) {
      $activityLog.innerHTML = '<p class="level-INFO">No activity yet.</p>';
      return;
    }
    for (const e of res.activityLog) appendActivityEntry(e);
  });
}

// Activity log smart scroll
$activityLog.addEventListener("scroll", () => {
  _activityLogFollowing = _isAtBottom($activityLog);
  _updateFollowBtn($activityLog, $btnFollowActivityLog, _activityLogFollowing);
});
$btnFollowActivityLog?.addEventListener("click", () => {
  _activityLogFollowing = true;
  $activityLog.scrollTop = $activityLog.scrollHeight;
  _updateFollowBtn($activityLog, $btnFollowActivityLog, true);
});

$btnClearLog.addEventListener("click", () => {
  send({ type: "CLEAR_ACTIVITY_LOG" }).then(() => {
    $activityLog.innerHTML = '<p class="level-INFO">No activity yet.</p>';
  });
});

/* ================================================================== */
/*  SETTINGS TAB                                                       */
/* ================================================================== */

let _settingsInited = false;
let centreLocationsCache = {};
let pendingTrainingFiles = [];
let humanAvailable = false;

// Settings DOM refs (grabbed lazily since they're in the settings panel)
const $childrenListS    = document.getElementById("childrenListSettings");
const $btnRefreshChildS = document.getElementById("btnRefreshChildren");
const $autoRange        = document.getElementById("autoThresholdRange");
const $autoNum          = document.getElementById("autoThresholdNumber");
const $minRange         = document.getElementById("minThresholdRange");
const $minNum           = document.getElementById("minThresholdNumber");
const $centreList       = document.getElementById("centreList");
const $btnAddCentre     = document.getElementById("btnAddCentre");
const $btnDiscover      = document.getElementById("btnDiscoverCentres");
const $btnSaveLoc       = document.getElementById("btnSaveLocations");
const $trainChild       = document.getElementById("trainingChildSelect");
const $trainFile        = document.getElementById("trainingFileInput");
const $trainPreviews    = document.getElementById("trainingPreviews");
const $trainProgress    = document.getElementById("trainingProgress");
const $btnSaveTrain     = document.getElementById("btnSaveTraining");
const $btnExport        = document.getElementById("btnExportProfile");
const $btnImport        = document.getElementById("btnImportProfile");
const $importInput      = document.getElementById("importProfileInput");
const $btnReset         = document.getElementById("btnResetFaceData");
const $btnSaveSettings  = document.getElementById("btnSaveSettings");

// Full backup elements
const $btnFullBackupExp = document.getElementById("btnFullBackupExport");
const $btnFullBackupImp = document.getElementById("btnFullBackupImport");
const $fullBackupInput  = document.getElementById("fullBackupInput");
const $backupMeta       = document.getElementById("backupMeta");
const $backupStatus     = document.getElementById("backupStatus");
const $btnDiagLog       = document.getElementById("btnDownloadDiagLog");
const $chkDebug         = document.getElementById("chkDebugCaptureMode");
const $btnDebugLog      = document.getElementById("btnDownloadDebugLog");
const $btnClearDebug    = document.getElementById("btnClearDebugLog");
const $debugStatus      = document.getElementById("debugLogStatus");
const $phaseIndicator   = document.getElementById("phaseIndicator");
const $trainStatus      = document.getElementById("trainingStatus");

function initSettingsTab() {
  if (_settingsInited) return;
  _settingsInited = true;

  // Check human.js
  humanAvailable = typeof Human !== "undefined";
  if (!humanAvailable) document.getElementById("humanWarning").style.display = "block";

  // Load saved settings
  const $chkSkipFace = document.getElementById("chkSkipFaceRec");
  const $skipFaceWarn = document.getElementById("skipFaceWarning");

  chrome.storage.local.get(
    ["autoThreshold", "minThreshold", "debugCaptureMode", "attendanceFilter", "saveStoryHtml", "saveStoryCard", "skipFaceRec", "fillGapsOnly"],
    ({ autoThreshold = 85, minThreshold = 50, debugCaptureMode = false, attendanceFilter = false, saveStoryHtml = true, saveStoryCard = true, skipFaceRec = false, fillGapsOnly = false }) => {
      $autoRange.value = autoThreshold; $autoNum.value = autoThreshold;
      $minRange.value = minThreshold; $minNum.value = minThreshold;
      $chkDebug.checked = debugCaptureMode === true;
      document.getElementById("chkAttendanceFilter").checked = attendanceFilter === true;
      document.getElementById("chkSaveStoryHtml").checked = saveStoryHtml !== false;
      document.getElementById("chkSaveStoryCard").checked = saveStoryCard !== false;
      document.getElementById("chkFillGapsOnly").checked = fillGapsOnly === true;
      $chkSkipFace.checked = skipFaceRec === true;
      $skipFaceWarn.style.display = skipFaceRec ? "block" : "none";
    }
  );

  $chkSkipFace.addEventListener("change", () => {
    const v = $chkSkipFace.checked;
    $skipFaceWarn.style.display = v ? "block" : "none";
    chrome.storage.local.set({ skipFaceRec: v }); // auto-save immediately
    // Sync with the "Download All Media" toggle on the Scan tab
    const $chkMain = document.getElementById("chkSkipFaceRecMain");
    const $warnMain = document.getElementById("downloadAllMediaWarning");
    if ($chkMain) $chkMain.checked = v;
    if ($warnMain) $warnMain.style.display = v ? "block" : "none";
    toast(`✓ ${v ? "Download All Media enabled" : "Face recognition enabled"}`, "success", 2000);
  });

  // Auto-save other checkboxes immediately on change (no Save button needed for these)
  document.getElementById("chkAttendanceFilter")?.addEventListener("change", (e) => {
    chrome.storage.local.set({ attendanceFilter: e.target.checked });
    toast(e.target.checked ? "✓ Routine filter enabled" : "✓ Routine filter disabled", "success", 1500);
  });
  document.getElementById("chkFillGapsOnly")?.addEventListener("change", (e) => {
    chrome.storage.local.set({ fillGapsOnly: e.target.checked });
    toast(e.target.checked ? "✓ Download Missing Only enabled" : "✓ Download Missing Only disabled", "success", 1500);
  });
  document.getElementById("chkSaveStoryHtml")?.addEventListener("change", (e) => {
    chrome.storage.local.set({ saveStoryHtml: e.target.checked });
    toast(e.target.checked ? "✓ Story HTML saving enabled" : "✓ Story HTML saving disabled", "success", 1500);
  });
  document.getElementById("chkSaveStoryCard")?.addEventListener("change", (e) => {
    chrome.storage.local.set({ saveStoryCard: e.target.checked });
    toast(e.target.checked ? "✓ Story Card saving enabled" : "✓ Story Card saving disabled", "success", 1500);
  });
  // Rewrite Metadata option checkboxes — auto-save on change
  document.getElementById("chkRewriteGps")?.addEventListener("change",  (e) => chrome.storage.local.set({ rewriteGps:  e.target.checked }));
  document.getElementById("chkRewriteDate")?.addEventListener("change", (e) => chrome.storage.local.set({ rewriteDate: e.target.checked }));
  document.getElementById("chkRewriteIptc")?.addEventListener("change", (e) => chrome.storage.local.set({ rewriteIptc: e.target.checked }));
  document.getElementById("chkKeepScenarioPhotos")?.addEventListener("change", (e) => {
    chrome.storage.local.set({ keepScenarioPhotos: e.target.checked });
    toast(e.target.checked ? "✓ Scenario photos auto-kept" : "✓ Scenario photos sent to Review", "success", 1500);
  });

  // Threshold sync with clamping (0-100)
  function clampThreshold(el) {
    let v = parseInt(el.value, 10);
    if (isNaN(v)) v = 0;
    v = Math.max(0, Math.min(100, v));
    el.value = v;
    return v;
  }
  $autoRange.addEventListener("input", () => { $autoNum.value = $autoRange.value; });
  $autoNum.addEventListener("input", () => { const v = clampThreshold($autoNum); $autoRange.value = v; });
  $autoNum.addEventListener("blur", () => clampThreshold($autoNum));
  $minRange.addEventListener("input", () => { $minNum.value = $minRange.value; });
  $minNum.addEventListener("input", () => { const v = clampThreshold($minNum); $minRange.value = v; });
  $minNum.addEventListener("blur", () => clampThreshold($minNum));

  // Children list (settings)
  loadSettingsChildren();

  // Centre locations
  loadCentreLocations();

  // Wire up all settings event handlers
  wireSettingsEvents();
}

function loadSettingsChildren() {
  send({ type: "GET_CHILDREN" }).then(res => {
    if (!res?.ok) return;
    const children = res.children || [];
    $childrenListS.innerHTML = "";
    $trainChild.innerHTML = '<option value="">— select a child —</option>';
    const $cleanupChildReset = document.getElementById("cleanupChildSelect");
    if ($cleanupChildReset) $cleanupChildReset.innerHTML = '<option value="">— select a child —</option>';
    const $rwChildReset = document.getElementById("rewriteChildSelect");
    if ($rwChildReset) $rwChildReset.innerHTML = '<option value="">All children</option>';
    const $repairChildReset = document.getElementById("repairChildSelect");
    if ($repairChildReset) $repairChildReset.innerHTML = '<option value="__ALL__">👨‍👩‍👧‍👦 All Children</option>';
    const $scReset = document.getElementById("storyCardsChildSel"); if ($scReset) $scReset.innerHTML = '<option value="">All children</option>';
    if (children.length === 0) {
      $childrenListS.innerHTML = '<p style="font-size:13px;color:var(--muted);">No children found.</p>';
      return;
    }
    for (const c of children) {
      const div = document.createElement("div");
      div.style.cssText = "padding:8px 10px;border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:14px;margin-bottom:8px;background:var(--bg);display:flex;align-items:center;justify-content:space-between;gap:8px;";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = `${c.name} (ID: ${c.id})`;
      div.appendChild(nameSpan);
      // Fetch and display model confidence for this child
      const confSpan = document.createElement("span");
      confSpan.style.cssText = "font-size:12px;font-weight:600;white-space:nowrap;";
      confSpan.textContent = "…";
      div.appendChild(confSpan);
      send({ type: "GET_MODEL_CONFIDENCE", childId: c.id }).then(res => {
        if (!res?.ok) { confSpan.textContent = ""; return; }
        const pct = res.confidence;
        const color = pct >= 80 ? "#4ade80" : pct >= 50 ? "#fbbf24" : "#e94560";
        const label = pct >= 80 ? "Good" : pct >= 50 ? "Fair" : "Low";
        confSpan.style.color = color;
        confSpan.textContent = `📊 ${pct}% confidence — ${label}`;
        confSpan.title = `Descriptors: ${res.descriptorCount}, Consistency: ${res.consistency}%, Verification: ${res.verificationScore}%`;
      });
      $childrenListS.appendChild(div);
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      $trainChild.appendChild(opt);

      // Also populate cleanup child select
      const $cleanupChild = document.getElementById("cleanupChildSelect");
      if ($cleanupChild) {
        const cleanupOpt = document.createElement("option");
        cleanupOpt.value = c.id;
        cleanupOpt.textContent = c.name;
        $cleanupChild.appendChild(cleanupOpt);
      }
      // Populate Fix Photo Metadata child select
      const $rwChildSel = document.getElementById("rewriteChildSelect");
      if ($rwChildSel) {
        const rwOpt = document.createElement("option");
        rwOpt.value = c.id;
        rwOpt.textContent = c.name;
        $rwChildSel.appendChild(rwOpt);
      }
      // Populate Repair Database child select
      const $repairChildSel = document.getElementById("repairChildSelect");
      if ($repairChildSel) {
        const repairOpt = document.createElement("option");
        repairOpt.value = c.id;
        repairOpt.textContent = c.name;
        $repairChildSel.appendChild(repairOpt);
      }
      // Populate Generate Story Cards child select
      const $scSel=document.getElementById("storyCardsChildSel");
      if($scSel){const scOpt=document.createElement("option");scOpt.value=c.id;scOpt.textContent=c.name;$scSel.appendChild(scOpt);}
    }
  });
}

$btnRefreshChildS.addEventListener("click", () => {
  $btnRefreshChildS.textContent = "Refreshing…";
  send({ type: "REFRESH_PROFILE" }).then(res => {
    $btnRefreshChildS.textContent = "↻ Refresh from Storypark";
    if (res?.ok) { loadSettingsChildren(); populateChildren(res.children); }
  });
});

/* ── Centre locations ── */

function parseCoords(str) {
  if (!str) return null;
  // Google Maps URL format: @-27.470,153.021 or ?q=-27.470,153.021
  const m1 = str.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
  const m2 = str.match(/q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  // Plain coords: -27.470, 153.021
  const m3 = str.match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/);
  if (m3) return { lat: parseFloat(m3[1]), lng: parseFloat(m3[2]) };
  return null;
}

function addCentreRow(name = "", lat = null, lng = null, address = null) {
  const row = document.createElement("div");
  row.className = "centre-row";
  row.style.cssText = "display:grid;grid-template-columns:2fr 3fr auto auto auto auto;gap:8px;align-items:end;margin-bottom:12px;";
  const coordStr = (lat != null && lng != null) ? `${lat}, ${lng}` : "";

  // Name field
  const nameField = document.createElement("div");
  nameField.className = "centre-field centre-name-field";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Centre name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = name;
  nameInput.placeholder = "e.g. Little Stars Childcare";
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);

  // Show discovered address if available
  if (address) {
    const addressEl = document.createElement("div");
    addressEl.style.cssText = "grid-column:1/-1;font-size:11px;color:var(--muted);margin:-4px 0 6px;padding-left:2px;";
    addressEl.textContent = `📌 ${address}`;
    nameField.appendChild(addressEl);
  }

  // Maps/coords field
  const mapsField = document.createElement("div");
  mapsField.className = "centre-field centre-maps-field";
  const mapsLabel = document.createElement("label");
  mapsLabel.textContent = "Google Maps Link or Coordinates";
  const mapsInput = document.createElement("input");
  mapsInput.type = "text";
  mapsInput.dataset.role = "mapsCoords";
  mapsInput.value = coordStr;
  mapsInput.placeholder = "Paste Google Maps URL or coords";
  mapsField.appendChild(mapsLabel);
  mapsField.appendChild(mapsInput);

  // "View on Map" link (visible when coords are set)
  const mapsLink = document.createElement("a");
  mapsLink.style.cssText = "font-size:12px;white-space:nowrap;align-self:flex-end;padding-bottom:8px;color:var(--success);text-decoration:none;";
  mapsLink.target = "_blank";
  mapsLink.rel = "noopener";
  const updateMapsLink = () => {
    const coords = parseCoords(mapsInput.value);
    if (coords) {
      mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
      mapsLink.textContent = "🗺️ View on Map";
      mapsLink.style.display = "";
      // Auto-clean Google Maps URLs to plain coords
      if (mapsInput.value.includes("maps.google") || mapsInput.value.includes("google.com/maps")) {
        mapsInput.value = `${coords.lat}, ${coords.lng}`;
      }
    } else {
      mapsLink.style.display = "none";
    }
  };
  updateMapsLink();
  mapsInput.addEventListener("change", updateMapsLink);
  mapsInput.addEventListener("blur", updateMapsLink);

  // "Search on Google Maps" link
  const searchMapsLink = document.createElement("a");
  searchMapsLink.style.cssText = "font-size:12px;white-space:nowrap;align-self:flex-end;padding-bottom:8px;color:var(--warning);text-decoration:none;";
  searchMapsLink.target = "_blank";
  searchMapsLink.rel = "noopener";
  searchMapsLink.textContent = "🔍 Search Maps";
  const updateSearchMapsLink = () => {
    const centreName = nameInput.value.trim();
    const q = address ? `${centreName}, ${address}` : centreName;
    searchMapsLink.href = q
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
      : "#";
    searchMapsLink.style.display = q ? "" : "none";
  };
  updateSearchMapsLink();
  nameInput.addEventListener("input", updateSearchMapsLink);

  // "Auto-Lookup" button — Nominatim OSM geocoding
  const btnLookup = document.createElement("button");
  btnLookup.className = "btn-secondary";
  btnLookup.textContent = "🔎 Auto-Lookup";
  btnLookup.type = "button";
  btnLookup.style.cssText = "width:auto;padding:6px 12px;margin:0;font-size:12px;align-self:flex-end;white-space:nowrap;";
  btnLookup.title = "Look up GPS coordinates from centre name using OpenStreetMap";
  btnLookup.addEventListener("click", async () => {
    const query = nameInput.value.trim();
    if (!query) { alert("Enter a centre name first."); return; }
    const origText = btnLookup.textContent;
    btnLookup.textContent = "Searching…";
    btnLookup.disabled = true;
    try {
      let searchQuery;
      if (address) {
        searchQuery = `${query}, ${address}`;
      } else {
        const lowerQuery = query.toLowerCase();
        const hasKeyword = /childcare|daycare|kindergarten|preschool|nursery|early learning|child care|day care/.test(lowerQuery);
        searchQuery = hasKeyword ? query : `${query} childcare`;
      }
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=5&addressdetails=1`,
        { headers: { "User-Agent": "StoryparkSmartSaver/2.0" } }
      );
      const results = await resp.json();
      if (results.length === 0) {
        alert('No results found. Try adding the suburb or city (e.g. "Sunshine Childcare Brisbane"), or use the "Search Maps" link.');
      } else if (results.length === 1) {
        mapsInput.value = `${results[0].lat}, ${results[0].lon}`;
        updateMapsLink();
        toast("✓ Coordinates found!");
      } else {
        // Multi-result picker
        const existing = row.querySelector(".nominatim-picker");
        if (existing) existing.remove();
        const picker = document.createElement("div");
        picker.className = "nominatim-picker";
        const label = document.createElement("p");
        label.style.cssText = "font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px;";
        label.textContent = `${results.length} results found — click to select:`;
        picker.appendChild(label);
        for (const r of results) {
          const btn = document.createElement("button");
          btn.className = "nominatim-result";
          btn.textContent = r.display_name;
          btn.addEventListener("click", () => {
            mapsInput.value = `${r.lat}, ${r.lon}`;
            updateMapsLink();
            picker.remove();
            toast("✓ Coordinates selected!");
          });
          picker.appendChild(btn);
        }
        const btnCancel = document.createElement("button");
        btnCancel.className = "btn-secondary";
        btnCancel.textContent = "Cancel";
        btnCancel.style.cssText = "margin-top:6px;font-size:11px;padding:4px 10px;";
        btnCancel.addEventListener("click", () => picker.remove());
        picker.appendChild(btnCancel);
        row.appendChild(picker);
      }
    } catch (e) {
      alert("Auto-lookup failed: " + e.message);
    }
    btnLookup.textContent = origText;
    btnLookup.disabled = false;
  });

  // Remove button
  const btnRemove = document.createElement("button");
  btnRemove.className = "btn-remove-centre";
  btnRemove.title = "Remove";
  btnRemove.textContent = "✕";
  btnRemove.style.cssText = "align-self:flex-end;";
  btnRemove.addEventListener("click", () => row.remove());

  row.appendChild(nameField);
  row.appendChild(mapsField);
  row.appendChild(searchMapsLink);
  row.appendChild(mapsLink);
  row.appendChild(btnLookup);
  row.appendChild(btnRemove);
  $centreList.appendChild(row);
}

function loadCentreLocations() {
  chrome.storage.local.get("centreLocations", ({ centreLocations = {} }) => {
    centreLocationsCache = centreLocations;
    $centreList.innerHTML = "";
    const names = Object.keys(centreLocations);
    if (names.length === 0) {
      addCentreRow();
    } else {
      for (const name of names) {
        const loc = centreLocations[name];
        addCentreRow(name, loc.lat, loc.lng, loc.address || null);
      }
    }
  });
}

function saveCentreLocations() {
  const fresh = {};
  for (const row of $centreList.querySelectorAll(".centre-row")) {
    const nameEl = row.querySelector("input[type=text]");
    const mapsEl = row.querySelector("input[data-role=mapsCoords]");
    if (!nameEl) continue;
    const key = nameEl.value.trim();
    if (!key) continue;
    const coords = mapsEl ? parseCoords(mapsEl.value) : null;
    const cached = centreLocationsCache[key] || {};
    fresh[key] = {
      lat: coords ? coords.lat : cached.lat ?? null,
      lng: coords ? coords.lng : cached.lng ?? null,
      address: cached.address ?? null,
    };
  }
  centreLocationsCache = fresh;
  chrome.storage.local.set({ centreLocations: fresh });
  toast("✓ Centre locations saved!");
}

/* ── Training ── */

async function refreshTrainingStatus(childId) {
  if (!childId) { $trainStatus.textContent = ""; return; }
  const rec = await getDescriptors(childId).catch(() => null);
  const count = rec?.descriptors?.length ?? 0;
  $trainStatus.textContent = count > 0
    ? `📊 ${count} face descriptor${count !== 1 ? "s" : ""} stored`
    : "No face data yet — upload training photos below.";
  // Phase indicator
  const phRes = await send({ type: "GET_CHILD_PHASE", childId });
  if (phRes?.ok) {
    const p = phRes.phase;
    $phaseIndicator.style.display = "block";
    $phaseIndicator.className = `phase-indicator phase-${p.phase}`;
    if (p.phase === 1) $phaseIndicator.innerHTML = `🔍 <strong>Phase 1: Discovery</strong> — ${p.verifiedCount}/10 verified. Approve faces in Review to build the profile. No downloads yet.`;
    else if (p.phase === 2) $phaseIndicator.innerHTML = `✅ <strong>Phase 2: Validation</strong> — ${p.verifiedCount}/50 verified. 95% threshold, most photos reviewed. No downloads yet.`;
    else if (p.phase === 3) $phaseIndicator.innerHTML = `📊 <strong>Phase 3: Confident</strong> — ${p.verifiedCount}/100 verified. Using your threshold. Need 80%+ model confidence to unlock downloads.`;
    else $phaseIndicator.innerHTML = `🚀 <strong>Phase 4: Production</strong> — ${p.verifiedCount} verified. Fully hands-off auto-download mode.`;
  }
}

function renderTrainingPreviews() {
  $trainPreviews.innerHTML = "";
  if (pendingTrainingFiles.length === 0) {
    $btnSaveTrain.disabled = true;
    return;
  }
  $btnSaveTrain.disabled = false;
  for (let i = 0; i < pendingTrainingFiles.length; i++) {
    const entry = pendingTrainingFiles[i];
    const wrapper = document.createElement("div");
    wrapper.className = "training-card-wrapper";
    wrapper.style.cssText = "display:inline-block;margin:4px;vertical-align:top;";
    const img = document.createElement("img");
    img.src = entry.dataUrl;
    img.style.cssText = "width:80px;height:80px;object-fit:cover;border-radius:6px;";
    wrapper.appendChild(img);
    // Match badge
    const matchDiv = document.createElement("div");
    matchDiv.className = "match-preview";
    matchDiv.style.cssText = "margin-top:4px;min-height:auto;padding:4px 6px;font-size:11px;";
    if (entry.matchPct != null) {
      const cls = entry.matchPct >= 80 ? "good" : entry.matchPct >= 50 ? "ok" : "bad";
      matchDiv.innerHTML = `<span class="match-badge ${cls}">${entry.matchPct}%</span>`;
    } else if (entry.noFace) {
      matchDiv.innerHTML = '<span class="match-badge none">No face</span>';
    } else {
      // No stored descriptors yet — first training upload, nothing to compare against
      matchDiv.innerHTML = '<span class="match-badge ok">✓ New</span>';
    }
    wrapper.appendChild(matchDiv);
    // Face selector
    if (entry.allFaces && entry.allFaces.length > 1) {
      const fSel = document.createElement("div");
      fSel.className = "settings-face-selector";
      entry.allFaces.forEach((f, fi) => {
        const fb = document.createElement("button");
        fb.className = "settings-face-btn" + (fi === (entry.selectedFaceIndex ?? 0) ? " selected" : "");
        fb.textContent = `Face ${fi + 1}`;
        fb.addEventListener("click", () => {
          entry.selectedFaceIndex = fi;
          entry.descriptor = f.descriptor;
          entry.matchPct = f.matchPct;
          renderTrainingPreviews();
        });
        fSel.appendChild(fb);
      });
      wrapper.appendChild(fSel);
    }
    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove-training";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => { pendingTrainingFiles.splice(i, 1); renderTrainingPreviews(); });
    wrapper.appendChild(removeBtn);
    $trainPreviews.appendChild(wrapper);
  }
}

function wireSettingsEvents() {
  $btnAddCentre.addEventListener("click", () => addCentreRow());
  $btnSaveLoc.addEventListener("click", saveCentreLocations);

  $btnDiscover.addEventListener("click", () => {
    $btnDiscover.textContent = "Discovering…";
    $btnDiscover.disabled = true;
    send({ type: "DISCOVER_CENTRES" }).then(() => {
      $btnDiscover.textContent = "🔍 Discover from Storypark";
      $btnDiscover.disabled = false;
      loadCentreLocations();
      toast("✓ Centre discovery complete");
    });
  });

  // Training child select
  $trainChild.addEventListener("change", async () => {
    pendingTrainingFiles = [];
    renderTrainingPreviews();
    if ($trainChild.value) await refreshTrainingStatus($trainChild.value);
    else { $trainStatus.textContent = ""; $phaseIndicator.style.display = "none"; }
  });

  // Training file upload
  $trainFile.addEventListener("change", async () => {
    const files = $trainFile.files;
    if (!files.length) return;
    const childId = $trainChild.value;
    if (!childId) { alert("Please select a child first."); $trainFile.value = ""; return; }

    $trainProgress.textContent = "Processing images…";
    const existingRec = await getDescriptors(childId).catch(() => null);
    const storedDescs = existingRec?.descriptors || [];

    // Load models if available
    if (humanAvailable) {
      try { await loadModels(); } catch { /* non-fatal */ }
    }

    for (let i = 0; i < files.length; i++) {
      $trainProgress.textContent = `Processing ${i + 1}/${files.length}…`;
      const file = files[i];
      const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
      const entry = { dataUrl, descriptor: null, matchPct: null, noFace: false, allFaces: null, selectedFaceIndex: 0 };

      if (humanAvailable) {
        try {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
          const faces = await detectFaces(img);
          if (faces.length === 0) {
            entry.noFace = true;
          } else {
            // Compute match % for each face against stored descriptors
            const allFaceData = [];
            for (const face of faces) {
              let pct = null;
              if (storedDescs.length > 0 && face.embedding) {
                const m = await matchEmbedding(face.embedding, storedDescs);
                pct = m ?? 0;
              }
              allFaceData.push({ descriptor: face.embedding ? Array.from(face.embedding) : null, matchPct: pct });
            }
            entry.allFaces = allFaceData;
            entry.descriptor = allFaceData[0].descriptor;
            entry.matchPct = allFaceData[0].matchPct;
          }
        } catch { entry.noFace = true; }
      }

      pendingTrainingFiles.push(entry);
      renderTrainingPreviews();
    }

    $trainProgress.textContent = `${pendingTrainingFiles.length} photo${pendingTrainingFiles.length !== 1 ? "s" : ""} ready to save.`;
    $trainFile.value = "";
  });

  // Save training
  $btnSaveTrain.addEventListener("click", async () => {
    const childId = $trainChild.value;
    if (!childId) { alert("Select a child first."); return; }
    const childName = $trainChild.options[$trainChild.selectedIndex]?.textContent || "";
    $btnSaveTrain.disabled = true;
    $btnSaveTrain.textContent = "Saving…";
    let saved = 0;
    for (const entry of pendingTrainingFiles) {
      try {
        const payload = entry.descriptor
          ? { type: "SAVE_TRAINING_DESCRIPTOR", childId, childName, descriptor: Array.from(entry.descriptor) }
          : { type: "PROCESS_TRAINING_IMAGE", childId, childName, imageDataUri: entry.dataUrl, faceIndex: entry.selectedFaceIndex ?? 0 };
        const res = await send(payload);
        if (res?.ok) saved++;
      } catch { /* skip */ }
    }
    pendingTrainingFiles = [];
    renderTrainingPreviews();
    $btnSaveTrain.textContent = "💾 Save training photos";
    $btnSaveTrain.disabled = true;
    toast(`✓ Saved ${saved} training photo${saved !== 1 ? "s" : ""}`);
    await refreshTrainingStatus(childId);
    loadChildPhase();
  });

  // Export profile — includes year-bucketed descriptors + phase data for
  // full backup/restore across devices or Chrome reinstalls.
  $btnExport.addEventListener("click", async () => {
    const childId = $trainChild.value;
    if (!childId) { alert("Select a child."); return; }
    const childName = $trainChild.options[$trainChild.selectedIndex]?.textContent || "";
    const rec = await getDescriptors(childId).catch(() => null);
    if (!rec?.descriptors?.length) { alert("No data to export."); return; }

    // Fetch phase data to include in the export
    const phRes = await send({ type: "GET_CHILD_PHASE", childId });
    const phaseData = phRes?.ok ? phRes.phase : null;

    // Build year summary for the confirmation dialog
    const yearBuckets = rec.descriptorsByYear || {};
    const yearSummary = Object.entries(yearBuckets)
      .filter(([, descs]) => descs.length > 0)
      .map(([year, descs]) => `${year}: ${descs.length}`)
      .join(", ");

    const exportData = {
      version: "2.1",
      exportDate: new Date().toISOString(),
      childId,
      childName,
      descriptors: rec.descriptors,
      descriptorsByYear: yearBuckets,
      phase: phaseData ? {
        phase: phaseData.phase,
        verifiedCount: phaseData.verifiedCount,
        phase1Complete: phaseData.phase1Complete,
        phase2Complete: phaseData.phase2Complete,
      } : null,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `storypark_face_profile_${childName.replace(/\s+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✓ Exported ${rec.descriptors.length} descriptors${yearSummary ? ` (${yearSummary})` : ""}`);
  });

  // Import profile — restores year-bucketed descriptors + phase data.
  // Supports both legacy flat-array exports and new v2.1 format.
  $btnImport.addEventListener("click", () => $importInput.click());
  $importInput.addEventListener("change", async () => {
    const file = $importInput.files[0];
    if (!file) return;
    $importInput.value = "";
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.descriptors) || parsed.descriptors.length === 0) { alert("Invalid profile file."); return; }

      // Auto-match child: if no child selected, try to match by name from file
      let childId = $trainChild.value;
      let childName;
      if (!childId && parsed.childName) {
        const opts = [...$trainChild.options];
        const match = opts.find(o => o.textContent.trim().toLowerCase() === parsed.childName.trim().toLowerCase());
        if (match) {
          childId = match.value;
          $trainChild.value = childId;
        }
      }
      childId = childId || parsed.childId || "";
      childName = $trainChild.value
        ? ($trainChild.options[$trainChild.selectedIndex]?.textContent || "")
        : (parsed.childName || "Unknown");
      if (!childId) { alert("Select a child first (or ensure the file has a matching child name)."); return; }

      // Build year summary for confirmation
      const importYearBuckets = parsed.descriptorsByYear || {};
      const yearSummary = Object.entries(importYearBuckets)
        .filter(([, descs]) => descs.length > 0)
        .map(([year, descs]) => `${year}: ${descs.length}`)
        .join(", ");
      const phaseInfo = parsed.phase
        ? `\nPhase ${parsed.phase.phase}, ${parsed.phase.verifiedCount} verified`
        : "";

      const existing = await getDescriptors(childId).catch(() => null);
      const existingCount = existing?.descriptors?.length ?? 0;
      let merged;
      if (existingCount > 0) {
        const doMerge = confirm(
          `${childName} has ${existingCount} descriptors.\n` +
          `Import has ${parsed.descriptors.length} descriptors${yearSummary ? ` (${yearSummary})` : ""}.${phaseInfo}\n\n` +
          `OK = Merge, Cancel = Replace.`
        );
        merged = doMerge
          ? [...existing.descriptors, ...parsed.descriptors].slice(-MAX_DESCRIPTORS_PER_CHILD)
          : parsed.descriptors.slice(-MAX_DESCRIPTORS_PER_CHILD);
      } else {
        merged = parsed.descriptors.slice(-MAX_DESCRIPTORS_PER_CHILD);
      }
      await setDescriptors(childId, childName, merged);

      // Restore phase data if present in the import and current child has no
      // phase data (i.e. phase 1 with 0 verified) — avoids overwriting progress.
      if (parsed.phase && parsed.phase.phase > 1) {
        const currentPhase = await send({ type: "GET_CHILD_PHASE", childId });
        if (currentPhase?.ok && currentPhase.phase.phase === 1 && currentPhase.phase.verifiedCount === 0) {
          await send({ type: "RESTORE_PHASE", childId, phaseData: parsed.phase });
        }
      }

      chrome.runtime.sendMessage({ type: "REFRESH_PROFILES" }).catch(() => {});
      toast(`✓ Imported ${merged.length} descriptors for ${childName}`);
      await refreshTrainingStatus(childId);
    } catch (e) { alert("Import failed: " + e.message); }
  });

  // Reset face data
  $btnReset.addEventListener("click", () => {
    const childId = $trainChild.value;
    if (!childId) { alert("Select a child."); return; }
    const childName = $trainChild.options[$trainChild.selectedIndex]?.textContent || "";
    if (!confirm(`Reset ALL face data for ${childName}? Cannot be undone.`)) return;
    $btnReset.disabled = true;
    send({ type: "RESET_FACE_DATA", childId }).then(res => {
      $btnReset.disabled = false;
      if (res?.ok) {
        toast(`✓ Face data reset for ${childName}`);
        pendingTrainingFiles = [];
        renderTrainingPreviews();
        refreshTrainingStatus(childId);
        loadChildPhase();
      } else alert("Reset failed: " + (res?.error || "Unknown"));
    });
  });

  // Save all settings
  $btnSaveSettings.addEventListener("click", async () => {
    $btnSaveSettings.disabled = true;
    $btnSaveSettings.textContent = "Saving…";
    const autoThreshold = parseInt($autoNum.value, 10) || 85;
    const minThreshold = parseInt($minNum.value, 10) || 50;
    if (minThreshold >= autoThreshold) {
      toast("⚠ Review threshold must be lower than Auto-Approve", "error");
      $btnSaveSettings.disabled = false;
      $btnSaveSettings.textContent = "💾 Save Settings";
      return;
    }
    saveCentreLocations();
    const attendanceFilter = document.getElementById("chkAttendanceFilter").checked;
    const saveStoryHtml = document.getElementById("chkSaveStoryHtml").checked;
    const saveStoryCard = document.getElementById("chkSaveStoryCard").checked;
    const skipFaceRec = document.getElementById("chkSkipFaceRec").checked;
    const fillGapsOnly = document.getElementById("chkFillGapsOnly").checked;
    await chrome.storage.local.set({ autoThreshold, minThreshold, attendanceFilter, saveStoryHtml, saveStoryCard, skipFaceRec, fillGapsOnly, centreLocations: centreLocationsCache });
    // Also save pending training
    if (pendingTrainingFiles.length > 0 && $trainChild.value) {
      const childId = $trainChild.value;
      const childName = $trainChild.options[$trainChild.selectedIndex]?.textContent || "";
      let saved = 0;
      for (const entry of pendingTrainingFiles) {
        try {
          const payload = entry.descriptor
            ? { type: "SAVE_TRAINING_DESCRIPTOR", childId, childName, descriptor: Array.from(entry.descriptor) }
            : { type: "PROCESS_TRAINING_IMAGE", childId, childName, imageDataUri: entry.dataUrl, faceIndex: entry.selectedFaceIndex ?? 0 };
          const res = await send(payload);
          if (res?.ok) saved++;
        } catch { /* skip */ }
      }
      if (saved > 0) { pendingTrainingFiles = []; renderTrainingPreviews(); await refreshTrainingStatus(childId); }
    }
    $btnSaveSettings.disabled = false;
    $btnSaveSettings.textContent = "💾 Save Settings";
    toast("✓ All settings saved!");
  });

  // Diagnostic logs button has been merged into the Debug card's Download Debug Log button.
  // $btnDiagLog was the duplicate removed from the Save Settings row — listener removed.

  // Debug capture mode
  $chkDebug.addEventListener("change", () => {
    const enabled = $chkDebug.checked;
    send({ type: "SET_DEBUG_CAPTURE_MODE", enabled }).then(res => {
      if (res?.ok) { $debugStatus.textContent = enabled ? "✓ Debug mode enabled" : "✓ Debug mode disabled"; setTimeout(() => $debugStatus.textContent = "", 4000); }
      else { $chkDebug.checked = !enabled; }
    });
  });
  $btnDebugLog.addEventListener("click", () => {
    send({ type: "GET_DIAGNOSTIC_LOG" }).then(res => {
      if (!res?.ok) return;
      const blob = new Blob([JSON.stringify({ capturedAt: res.capturedAt, debugCaptureMode: res.debugCaptureMode, centreLocations: res.centreLocations, apiResponses: res.log }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `storypark_debug_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      $debugStatus.textContent = `✓ Downloaded ${res.log.length} responses.`;
      setTimeout(() => $debugStatus.textContent = "", 4000);
    });
  });
  $btnClearDebug.addEventListener("click", () => {
    send({ type: "CLEAR_DIAGNOSTIC_LOG" }).then(res => {
      if (res?.ok) { $debugStatus.textContent = "✓ Cleared."; setTimeout(() => $debugStatus.textContent = "", 3000); }
    });
  });

  /* ── Full Backup Export/Import ── */

  $btnFullBackupExp.addEventListener("click", async () => {
    $btnFullBackupExp.disabled = true;
    $btnFullBackupExp.textContent = "⏳ Exporting…";
    $backupStatus.textContent = "";
    const res = await send({ type: "FULL_BACKUP_EXPORT" });
    $btnFullBackupExp.disabled = false;
    $btnFullBackupExp.textContent = "📤 Export Full Backup";
    if (!res?.ok) {
      $backupStatus.textContent = "❌ Export failed: " + (res?.error || "Unknown");
      return;
    }
    const backup = res.backup;
    // Show metadata summary
    const m = backup._meta;
    $backupMeta.style.display = "block";
    $backupMeta.innerHTML = [
      `<strong>👶 Children:</strong> ${m.childCount}`,
      `<strong>🧠 Face descriptors:</strong> ${m.totalDescriptors} (positive) + ${m.totalNegativeDescriptors} (negative)`,
      `<strong>📖 Processed stories:</strong> ${m.totalProcessedStories}`,
      `<strong>📋 Pending downloads:</strong> ${m.totalPendingDownloads}`,
      `<strong>📅 Export date:</strong> ${new Date(backup.exportDate).toLocaleString()}`,
    ].join("<br>");

    // Gzip-compress the backup (CompressionStream — native Chrome, no dependencies)
    // Fingerprints + story caches compress ~6:1, giving ~4-6MB from ~30MB raw.
    const jsonStr = JSON.stringify(backup);
    let downloadBlob;
    let downloadName = `storypark_full_backup_${new Date().toISOString().slice(0, 10)}`;
    try {
      const compressed = await new Response(
        new Blob([jsonStr]).stream().pipeThrough(new CompressionStream("gzip"))
      ).arrayBuffer();
      downloadBlob = new Blob([compressed], { type: "application/gzip" });
      downloadName += ".json.gz";
    } catch {
      // Fallback to plain JSON if CompressionStream not available
      downloadBlob = new Blob([jsonStr], { type: "application/json" });
      downloadName += ".json";
    }
    const url = URL.createObjectURL(downloadBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(url);

    // Record last backup date
    await chrome.storage.local.set({ lastBackupExport: new Date().toISOString() });
    $backupStatus.textContent = "✅ Backup exported successfully!";
    toast("💾 Full backup exported");
  });

  $btnFullBackupImp.addEventListener("click", () => $fullBackupInput.click());
  $fullBackupInput.addEventListener("change", async () => {
    const file = $fullBackupInput.files[0];
    if (!file) return;
    $fullBackupInput.value = "";

    $backupStatus.textContent = "⏳ Reading backup file…";
    try {
      // Auto-detect gzip by file extension or magic bytes (1f 8b)
      let backup;
      const isGzip = file.name.endsWith(".gz") || file.name.endsWith(".json.gz") ||
        (await file.slice(0, 2).arrayBuffer().then(b => new Uint8Array(b)).then(b => b[0] === 0x1f && b[1] === 0x8b));
      if (isGzip) {
        $backupStatus.textContent = "⏳ Decompressing backup…";
        const ab   = await file.arrayBuffer();
        const text = await new Response(
          new Blob([ab]).stream().pipeThrough(new DecompressionStream("gzip"))
        ).text();
        backup = JSON.parse(text);
      } else {
        const text = await file.text();
        backup = JSON.parse(text);
      }

      // Validate
      if (!backup || backup.type !== "storypark_smart_saver_full_backup") {
        $backupStatus.textContent = "❌ Invalid file — not a Storypark Smart Saver full backup.";
        return;
      }

      // Show what will be imported
      const m = backup._meta || {};
      const summary = [
        `Children: ${m.childCount || "?"}`,
        `Descriptors: ${m.totalDescriptors || "?"}`,
        `Stories: ${m.totalProcessedStories || "?"}`,
        `Pending: ${m.totalPendingDownloads || "?"}`,
      ].join(", ");
      const exportDate = backup.exportDate ? new Date(backup.exportDate).toLocaleString() : "unknown";
      if (!confirm(`Import backup from ${exportDate}?\n\n${summary}\n\nThis will restore all face data, scan progress, and settings.`)) {
        $backupStatus.textContent = "";
        return;
      }

      // Get merge mode from radio buttons
      const mergeMode = document.querySelector('input[name="importMode"]:checked')?.value || "merge";

      $backupStatus.textContent = "⏳ Importing…";
      const res = await send({ type: "FULL_BACKUP_IMPORT", backup, mergeMode });
      if (res?.ok) {
        const imp = res.imported;
        $backupStatus.textContent = `✅ Imported: ${imp.children} children, ${imp.descriptors} descriptors, ${imp.phases} phases, ${imp.stories} stories, ${imp.pending} pending downloads`;
        toast("✅ Full backup imported successfully!", "success", 5000);
        // Refresh all UI
        loadChildren();
        loadSettingsChildren();
        loadCentreLocations();
        refreshReviewQueue();
        loadChildPhase();
        checkForResume();
      } else {
        $backupStatus.textContent = "❌ Import failed: " + (res?.error || "Unknown");
      }
    } catch (e) {
      $backupStatus.textContent = "❌ Import failed: " + e.message;
    }
  });

  // Show last backup info
  chrome.storage.local.get(["lastBackupExport", "lastBackupImport"], ({ lastBackupExport, lastBackupImport }) => {
    const parts = [];
    if (lastBackupExport) parts.push(`Last export: ${new Date(lastBackupExport).toLocaleDateString()}`);
    if (lastBackupImport) parts.push(`Last import: ${new Date(lastBackupImport).toLocaleDateString()}`);
    if (parts.length > 0) {
      $backupStatus.textContent = parts.join(" · ");
    }
  });

  /* ── Reset Rejected Images ── */
  const $btnClearAllRejections  = document.getElementById("btnClearAllRejections");
  const $clearRejectionsStatus  = document.getElementById("clearRejectionsStatus");
  if ($btnClearAllRejections) {
    $btnClearAllRejections.addEventListener("click", async () => {
      if (!confirm("Reset ALL rejected image records?\n\nThis means photos you previously rejected will be re-evaluated on the next scan. Your face model and approval history are not affected.")) return;
      $btnClearAllRejections.disabled = true;
      $btnClearAllRejections.textContent = "⏳ Resetting…";
      const res = await send({ type: "CLEAR_ALL_REJECTIONS" });
      $btnClearAllRejections.disabled = false;
      $btnClearAllRejections.textContent = "🔄 Reset All Rejected Images";
      if (res?.ok) {
        $clearRejectionsStatus.textContent = "✅ All rejection records cleared. Run a scan to re-evaluate.";
        setTimeout(() => { $clearRejectionsStatus.textContent = ""; }, 6000);
        toast("✅ Rejected images reset — they'll be re-evaluated next scan", "success", 5000);
      } else {
        $clearRejectionsStatus.textContent = "❌ Failed: " + (res?.error || "Unknown error");
      }
    });
  }

  /* ── Linked Download Folder ── */
  const $btnLinkFolder      = document.getElementById("btnLinkFolder");
  const $btnUnlinkFolder    = document.getElementById("btnUnlinkFolder");
  const $btnReconcileFolder = document.getElementById("btnReconcileFolder");
  const $linkedFolderInfo   = document.getElementById("linkedFolderInfo");
  const $linkedFolderStatus = document.getElementById("linkedFolderStatus");

  const $btnRepairManifestUI  = document.getElementById("btnRepairManifest");
  const $btnRebuildDatabaseUI = document.getElementById("btnRebuildDatabase");
  const $enrichStoriesRowUI   = document.getElementById("enrichStoriesRow");
  const $btnRewriteMetadata   = document.getElementById("btnRewriteMetadata");

  /** Update the folder card UI based on whether a folder is currently linked. */
  async function refreshLinkedFolderUI() {
    try {
      const handle = await getLinkedFolder();
      if (handle) {
        $btnLinkFolder.textContent = "📁 Change Folder";
        $btnUnlinkFolder.style.display = "";
        $btnReconcileFolder.style.display = "";
        if ($btnRepairManifestUI)  $btnRepairManifestUI.style.display = "";
        if ($btnRebuildDatabaseUI) $btnRebuildDatabaseUI.style.display = "";
        if ($enrichStoriesRowUI)   $enrichStoriesRowUI.style.display = "";
        if ($btnRewriteMetadata)   $btnRewriteMetadata.style.display = "";
        const $repairRow = document.getElementById("repairChildRow");
        if ($repairRow) $repairRow.style.display = "flex";
        const $rwCfg = document.getElementById("rewriteMetadataConfig");
        if ($rwCfg) $rwCfg.style.display = "";
        const isRoot = handle.name === "Storypark Smart Saver";
        $linkedFolderInfo.textContent = `✅ Linked: "${handle.name}"${isRoot ? " ✓ (correct folder)" : " ⚠ (link the Storypark Smart Saver folder for best results)"}`;
        $linkedFolderInfo.style.color = isRoot ? "var(--success)" : "var(--warning)";
      } else {
        $btnLinkFolder.textContent = "📁 Link Folder";
        $btnUnlinkFolder.style.display = "none";
        $btnReconcileFolder.style.display = "none";
        if ($btnRepairManifestUI)  $btnRepairManifestUI.style.display = "none";
        if ($btnRebuildDatabaseUI) $btnRebuildDatabaseUI.style.display = "none";
        if ($enrichStoriesRowUI)   $enrichStoriesRowUI.style.display = "none";
        if ($btnRewriteMetadata)   $btnRewriteMetadata.style.display = "none";
        const $repairRowH = document.getElementById("repairChildRow");
        if ($repairRowH) $repairRowH.style.display = "none";
        const $rwCfgH = document.getElementById("rewriteMetadataConfig");
        if ($rwCfgH) $rwCfgH.style.display = "none";
        $linkedFolderInfo.textContent = 'No folder linked — click above and select your "Storypark Smart Saver" folder.';
        $linkedFolderInfo.style.color = "";
        $linkedFolderStatus.style.display = "none";
      }
    } catch {
      $linkedFolderInfo.textContent = "Error checking folder status.";
    }
  }

  refreshLinkedFolderUI();

  $btnLinkFolder.addEventListener("click", async () => {
    try {
      $btnLinkFolder.disabled = true;
      $btnLinkFolder.textContent = "⏳ Selecting…";
      const { name } = await linkFolder();
      toast(`✅ Folder linked: "${name}"`, "success");
      await refreshLinkedFolderUI();
    } catch (err) {
      if (err.name !== "AbortError") {
        toast(`❌ ${err.message}`, "error");
      }
    } finally {
      $btnLinkFolder.disabled = false;
    }
  });

  $btnUnlinkFolder.addEventListener("click", async () => {
    if (!confirm("Unlink this folder? You can always re-link it later.")) return;
    await clearLinkedFolder();
    toast("✓ Folder unlinked");
    await refreshLinkedFolderUI();
  });

  $btnReconcileFolder.addEventListener("click", async () => {
    $btnReconcileFolder.disabled = true;
    $btnReconcileFolder.textContent = "⏳ Verifying…";
    $linkedFolderStatus.style.display = "none";
    try {
      const handle = await getLinkedFolder();
      if (!handle) { toast("No folder linked", "error"); return; }
      // Fetch all downloaded story manifests directly from IndexedDB
      // (getAllDownloadedStories is imported from db.js — no message channel needed)
      const allStories = await getAllDownloadedStories().catch(() => []);
      const report = await reconcileWithCache(handle, allStories);
      $linkedFolderStatus.style.display = "block";
      const isCorrectFolder = report.linkedFolderIsRoot;
      const folderNote = isCorrectFolder
        ? `🔗 Linked: <strong>${report.linkedFolderName}</strong> ✅`
        : `🔗 Linked: <strong>${report.linkedFolderName}</strong> ⚠ — for best results, link the "Storypark Smart Saver" folder`;
      $linkedFolderStatus.innerHTML = [
        `<strong>📊 Reconciliation Report</strong>`,
        folderNote,
        `✅ <strong>${report.present.length}</strong> files verified on disk`,
        `❌ <strong>${report.missing.length}</strong> files missing (need re-download)`,
        `⚠ <strong>${report.orphaned.length}</strong> untracked media files on disk`,
        `📁 Total expected: ${report.totalExpected} · Total on disk: ${report.totalOnDisk}`,
        report.missing.length > 0 ? `💡 If files exist on disk but show as missing, try <strong>🔧 Repair Database from Disk</strong>` : "",
      ].filter(Boolean).join("<br>");
      if (report.missing.length > 0) {
        toast(`❌ ${report.missing.length} files missing — run a scan or use Repair Database`, "error", 5000);
      } else {
        toast(`✅ All ${report.present.length} files verified on disk!`, "success");
      }
    } catch (err) {
      toast(`❌ Reconciliation failed: ${err.message}`, "error");
    } finally {
      $btnReconcileFolder.disabled = false;
      $btnReconcileFolder.textContent = "🔍 Verify Files on Disk";
    }
  });

  /* ── Clean Up Folder ── */
  const $cleanupChildSel   = document.getElementById("cleanupChildSelect");
  const $btnRunCleanup     = document.getElementById("btnRunCleanup");
  const $btnUndoCleanup    = document.getElementById("btnUndoCleanup");
  const $cleanupThreshRange = document.getElementById("cleanupThresholdRange");
  const $cleanupThreshNum   = document.getElementById("cleanupThresholdNumber");

  // Sync cleanup threshold range ↔ number
  if ($cleanupThreshRange && $cleanupThreshNum) {
    $cleanupThreshRange.addEventListener("input", () => { $cleanupThreshNum.value = $cleanupThreshRange.value; });
    $cleanupThreshNum.addEventListener("input", () => {
      let v = parseInt($cleanupThreshNum.value, 10);
      if (isNaN(v)) v = 40;
      v = Math.max(0, Math.min(100, v));
      $cleanupThreshNum.value = v;
      $cleanupThreshRange.value = v;
    });
    $cleanupThreshNum.addEventListener("blur", () => {
      let v = parseInt($cleanupThreshNum.value, 10);
      if (isNaN(v) || v < 0) v = 0;
      if (v > 100) v = 100;
      $cleanupThreshNum.value = v;
      $cleanupThreshRange.value = v;
    });
  }

  // Enable Run + Offline Scan buttons when a child is selected
  const $btnOfflineScan    = document.getElementById("btnOfflineScan");
  const $offlineScanHelp   = document.getElementById("offlineScanHelp");
  if ($cleanupChildSel && $btnRunCleanup) {
    $cleanupChildSel.addEventListener("change", () => {
      const hasChild = !!$cleanupChildSel.value;
      $btnRunCleanup.disabled = !hasChild;
      if ($btnOfflineScan) {
        $btnOfflineScan.disabled = !hasChild;
        $btnOfflineScan.style.display = hasChild ? "" : "none";
      }
      if ($offlineScanHelp) {
        $offlineScanHelp.style.display = hasChild ? "block" : "none";
      }
      const $btnReEval = document.getElementById("btnReEvaluateAll");
      if ($btnReEval) $btnReEval.style.display = hasChild ? "" : "none";
    });
  }

  // Run Clean Up button
  $btnRunCleanup?.addEventListener("click", () => runCleanup());

  // Offline Smart Scan button
  $btnOfflineScan?.addEventListener("click", () => runOfflineScan());

  // Undo Clean Up button
  $btnUndoCleanup?.addEventListener("click", () => undoCleanup());

  // Re-evaluate All Photos button
  document.getElementById("btnReEvaluateAll")?.addEventListener("click", () => runReEvaluateAll());

  /* ── Repair Database from Disk ── */
  const $btnRepairManifest = document.getElementById("btnRepairManifest");
  if ($btnRepairManifest) {
    $btnRepairManifest.addEventListener("click", async () => {
      const handle = await getLinkedFolder();
      if (!handle) { toast("No folder linked", "error"); return; }

      // Resolve child selection from the inline repairChildSelect dropdown
      const $repairChildSel = document.getElementById("repairChildSelect");
      const selectedVal = $repairChildSel?.value || "__ALL__";
      const isAll = selectedVal === "__ALL__";

      // Fetch all children from API (needed for both All and single modes)
      const childrenRes = await send({ type: "GET_CHILDREN" });
      const childrenAll = childrenRes?.children || [];
      if (childrenAll.length === 0) { toast("No children found — refresh your profile first", "error"); return; }

      // Build list of children to repair
      const childrenToRepair = isAll
        ? childrenAll
        : (() => {
            const selName = $repairChildSel?.options[$repairChildSel.selectedIndex]?.textContent || "";
            const found   = childrenAll.find(c => String(c.id) === String(selectedVal));
            return [found || { id: selectedVal, name: selName }];
          })();

      $btnRepairManifest.disabled = true;
      $btnRepairManifest.textContent = isAll
        ? `⏳ Rebuilding database for ${childrenToRepair.length} children…`
        : "⏳ Rebuilding database…";
      $linkedFolderStatus.style.display = "none";

      let totalRepaired = 0, totalTracked = 0, totalStories = 0, totalErrors = 0, totalSynced = 0;
      const summaryLines = [];

      try {
        const existingManifests = await getAllDownloadedStories().catch(() => []);

        for (const child of childrenToRepair) {
          if (childrenToRepair.length > 1) {
            $btnRepairManifest.textContent = `⏳ Repairing ${child.name}…`;
          }

          try {
            const result = await repairManifestFromDisk(handle, existingManifests, child.name, child.id);

            let saved = 0;
            for (const manifest of result.updatedManifests || []) {
              try { await addDownloadedStory(manifest); saved++; } catch { /* skip */ }
            }

            totalRepaired += result.repaired  || 0;
            totalTracked  += result.alreadyTracked || 0;
            totalStories  += result.newStories || 0;
            totalErrors   += result.errors     || 0;

            if (isAll) {
              summaryLines.push(
                `👶 <strong>${child.name}</strong>: ${result.repaired} repaired, ${result.alreadyTracked} already tracked` +
                (result.newStories > 0 ? `, ${result.newStories} new stories` : "") +
                (result.errors > 0 ? `, ⚠ ${result.errors} errors` : "")
              );
            }

            // Sync processedStories so Scan Latest skips already-downloaded stories
            try {
              $btnRepairManifest.textContent = isAll
                ? `⏳ Syncing ${child.name}…`
                : "⏳ Syncing scan progress…";
              const onDiskPaths = await walkFolder(handle, "");
              const syncRes = await send({
                type: "SYNC_PROCESSED_FROM_DISK",
                childId: child.id,
                childName: child.name,
                onDiskPaths,
              });
              if (syncRes?.ok && syncRes.synced > 0) {
                totalSynced += syncRes.synced;
              }
            } catch (syncErr) {
              console.warn("[repair-manifest] Sync failed:", child.name, syncErr.message);
            }

            const repairLogMsg = `🔧 Repaired ${result.repaired} files for ${child.name}` +
              (result.alreadyTracked > 0 ? ` (${result.alreadyTracked} already tracked)` : "");
            send({ type: "LOG_TO_ACTIVITY", level: result.repaired > 0 ? "SUCCESS" : "INFO", message: repairLogMsg, meta: { childName: child.name } }).catch(() => {});
          } catch (childErr) {
            console.warn("[repair-manifest] Child failed:", child.name, childErr.message);
            if (isAll) summaryLines.push(`👶 <strong>${child.name}</strong>: ❌ ${childErr.message}`);
            totalErrors++;
          }
        }

        // Show combined results
        $linkedFolderStatus.style.display = "block";
        if (isAll) {
          $linkedFolderStatus.innerHTML = [
            `<strong>🔧 Repair Complete — All Children</strong>`,
            ...summaryLines,
            `<br>✅ Total: <strong>${totalRepaired}</strong> files added · ✓ <strong>${totalTracked}</strong> already tracked` +
              (totalStories > 0 ? ` · 📖 <strong>${totalStories}</strong> new stories` : "") +
              (totalSynced > 0  ? ` · 🔄 <strong>${totalSynced}</strong> stories synced` : "") +
              (totalErrors > 0  ? ` · ⚠ <strong>${totalErrors}</strong> errors` : ""),
            totalRepaired > 0 ? `💡 Run <strong>🔍 Verify On Disk</strong> to confirm tracking is up to date.` : "",
          ].filter(Boolean).join("<br>");
        } else {
          const child = childrenToRepair[0];
          const result = { repaired: totalRepaired, alreadyTracked: totalTracked, newStories: totalStories, errors: totalErrors };
          $linkedFolderStatus.innerHTML = [
            `<strong>🔧 Repair Complete — ${child.name}</strong>`,
            `✅ <strong>${result.repaired}</strong> files added to tracking`,
            result.newStories > 0 ? `📖 <strong>${result.newStories}</strong> new story entries recovered from disk` : "",
            `✓ <strong>${result.alreadyTracked}</strong> files already tracked`,
            result.errors > 0 ? `⚠ <strong>${result.errors}</strong> folders could not be read` : "",
            totalSynced > 0 ? `🔄 <strong>${totalSynced}</strong> stories synced — run Scan Latest for new content only` : "",
            result.repaired > 0 ? `💡 Run <strong>🔍 Verify On Disk</strong> to confirm tracking is now up to date.` : "",
          ].filter(Boolean).join("<br>");
        }

        if (totalRepaired > 0) {
          toast(`✅ Repaired ${totalRepaired} files${isAll ? " across all children" : ` for ${childrenToRepair[0].name}`}`, "success", 5000);
        } else {
          toast(`✓ Database is already up to date — no missing files found`, "success");
        }
        if (totalSynced > 0) {
          toast(`🔄 ${totalSynced} stories synced — run Scan Latest for new content only`, "success", 6000);
        }
      } catch (err) {
        toast(`❌ Repair failed: ${err.message}`, "error");
      } finally {
        $btnRepairManifest.disabled = false;
        $btnRepairManifest.textContent = "🔧 Repair Database from Disk";
      }
    });
  }

  /* ── Rebuild Database from Disk (API) — matches on-disk folders to real story IDs ── */
  const $btnRebuildDatabase = document.getElementById("btnRebuildDatabase");
  if ($btnRebuildDatabase) {
    $btnRebuildDatabase.addEventListener("click", async () => {
      const handle = await getLinkedFolder();
      if (!handle) { toast("No folder linked", "error"); return; }
      if (isRunning) { toast("A scan is already running", "error"); return; }

      const $repairChildSel = document.getElementById("repairChildSelect");
      const selectedVal = $repairChildSel?.value || "__ALL__";
      const isAll = selectedVal === "__ALL__";

      const childrenRes = await send({ type: "GET_CHILDREN" });
      const childrenAll = childrenRes?.children || [];
      if (childrenAll.length === 0) { toast("No children found — refresh profile first", "error"); return; }

      const childrenToRebuild = isAll
        ? childrenAll
        : [childrenAll.find(c => String(c.id) === String(selectedVal)) || {
            id: selectedVal,
            name: $repairChildSel?.options[$repairChildSel.selectedIndex]?.textContent || "Unknown",
          }];

      const totalFolders = childrenToRebuild.length;
      // Read enrichment option from the checkbox (defaulting to true)
      const enrichStories = document.getElementById("chkEnrichStories")?.checked !== false;

      const enrichNote = enrichStories
        ? `• Fetch full story data for each matched story (body, educator, room, routine)\n• Rebuild story.html + Story Cards with complete information\n• ⏱ ~45–60 min for 500 stories`
        : `• Quick ID-match only — story.html will show placeholder text until Deep Rescan`;

      if (!confirm(
        `Rebuild database for ${isAll ? "all children" : childrenToRebuild[0].name} from disk + Storypark API?\n\n` +
        `This will:\n` +
        `• Walk your ${handle.name} folder to find all story folders (~5 sec)\n` +
        `• Fetch your story list from Storypark API (~30 sec for 500 stories)\n` +
        `• Match on-disk folders to real story IDs by date + title\n` +
        `• Mark all matched stories as processed → next scan skips them\n` +
        `${enrichNote}\n\n` +
        `Requires you to be logged into Storypark. Continue?`
      )) return;

      setRunning(true);
      $btnRebuildDatabase.disabled = true;
      $btnRebuildDatabase.textContent = "⏳ Walking folder…";
      $linkedFolderStatus.style.display = "none";

      try {
        // Walk the linked folder once for all children
        const allFiles = await walkFolder(handle, "");
        const isSSSRoot = handle.name === "Storypark Smart Saver";
        const pathPrefix = isSSSRoot ? "" : "Storypark Smart Saver/";
        const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;
        const INVALID_CHARS = /[/\\:*?"<>|]/g;

        let totalMatched = 0, totalRecovered = 0, totalErrors = 0;
        const summaryLines = [];

        for (const child of childrenToRebuild) {
          $btnRebuildDatabase.textContent = `⏳ Rebuilding ${child.name}…`;
          const childSafe = (child.name || "Unknown").replace(INVALID_CHARS, "_").trim();
          const childStoriesPrefix = `${pathPrefix}${childSafe}/Stories/`;

          // Build diskFolders: extract story folders from walked file list for this child
          const folderFiles = new Map(); // folderName → [filenames]
          for (const filePath of allFiles) {
            if (!filePath.startsWith(childStoriesPrefix)) continue;
            const rest = filePath.slice(childStoriesPrefix.length);
            const slashIdx = rest.indexOf("/");
            if (slashIdx <= 0) continue; // skip files directly under Stories/
            const folderName = rest.slice(0, slashIdx);
            const fileName   = rest.slice(slashIdx + 1);
            if (folderName.endsWith(" Rejected Matches")) continue; // skip rejected
            if (!folderFiles.has(folderName)) folderFiles.set(folderName, []);
            folderFiles.get(folderName).push(fileName);
          }

          const diskFolders = [...folderFiles.entries()].map(([folderName, files]) => ({
            folderName,
            files: files.filter(f => MEDIA_EXT.test(f)),
          })).filter(d => d.files.length > 0 || true); // include even empty (for date matching)

          if (diskFolders.length === 0) {
            summaryLines.push(`👶 <strong>${child.name}</strong>: No story folders found`);
            continue;
          }

          // Re-assert running state before each child — SCAN_COMPLETE from
          // the previous child calls setRunning(false), which would hide the
          // progress bar. setRunning(true) here keeps it visible.
          setRunning(true);

          // Send to background for API matching + manifest rebuild
          const res = await send({
            type: "REBUILD_DATABASE_FROM_DISK",
            childId: child.id,
            childName: child.name,
            diskFolders,
            enrichStories,
          });

          if (res?.ok) {
            totalMatched   += res.matched   || 0;
            totalRecovered += res.recovered || 0;
            totalErrors    += res.errors    || 0;
            summaryLines.push(
              `👶 <strong>${child.name}</strong>: ` +
              `${res.matched} matched to API, ${res.recovered} recovered from disk` +
              (res.errors > 0 ? `, ⚠ ${res.errors} errors` : "")
            );
            send({ type: "LOG_TO_ACTIVITY", level: "SUCCESS",
              message: `🔄 Rebuilt database for ${child.name}: ${res.matched} matched, ${res.recovered} recovered`,
              meta: { childName: child.name },
            }).catch(() => {});
          } else {
            summaryLines.push(`👶 <strong>${child.name}</strong>: ❌ ${res?.error || "Unknown error"}`);
            send({ type: "LOG_TO_ACTIVITY", level: "ERROR",
              message: `❌ Rebuild failed for ${child.name}: ${res?.error || "Unknown"}`,
              meta: { childName: child.name },
            }).catch(() => {});
          }
        }

        $linkedFolderStatus.style.display = "block";
        $linkedFolderStatus.innerHTML = [
          `<strong>🔄 Rebuild Complete</strong>`,
          ...summaryLines,
          childrenToRebuild.length > 1
            ? `<br>✅ Total: <strong>${totalMatched}</strong> matched to API · 📁 <strong>${totalRecovered}</strong> recovered from disk` +
              (totalErrors > 0 ? ` · ⚠ <strong>${totalErrors}</strong> errors` : "")
            : "",
          `💡 Run <strong>Scan Latest</strong> — it will skip all already-downloaded stories.`,
          totalRecovered > 0
            ? `🔍 ${totalRecovered} folders couldn't be matched to Storypark — run a <strong>Deep Rescan</strong> to enrich them with story text, educator, and centre data.`
            : "",
        ].filter(Boolean).join("<br>");

        if (totalMatched > 0) {
          toast(`✅ Database rebuilt — ${totalMatched} stories matched, ${totalRecovered} recovered. Run Scan Latest!`, "success", 6000);
        } else {
          toast(`✓ Rebuild done — ${totalRecovered} stories recovered from disk`, "success", 5000);
        }
      } catch (err) {
        toast(`❌ Rebuild failed: ${err.message}`, "error");
      } finally {
        // SCAN_COMPLETE from background will call setRunning(false)
        $btnRebuildDatabase.disabled = false;
        $btnRebuildDatabase.textContent = "🔄 Rebuild Database from Disk (API)";
      }
    });
  }

  /* ── Fix Photo Metadata (upgraded with stop/progress/ETA/GPS check) ── */
  if ($btnRewriteMetadata) {
    $btnRewriteMetadata.addEventListener("click", async () => {
      const handle = await getLinkedFolder();
      if (!handle) { toast("No folder linked", "error"); return; }

      // ── Child selection from dropdown ──
      const $rwSelect = document.getElementById("rewriteChildSelect");
      const targetChildId = $rwSelect?.value || null; // empty = all children

      // ── Options ──
      const rwGps         = document.getElementById("chkRewriteGps")?.checked  !== false;
      const rwDate        = document.getElementById("chkRewriteDate")?.checked !== false;
      const rwIptc        = document.getElementById("chkRewriteIptc")?.checked !== false;
      const verifyMetadata = document.getElementById("chkVerifyMetadata")?.checked === true;

      // ── Build manifest map ──
      const allManifests = await getAllDownloadedStories().catch(() => []);
      const manifests    = targetChildId
        ? allManifests.filter(m => m.childId === targetChildId)
        : allManifests;

      if (manifests.length === 0) {
        toast("No stories found — run a scan first", "error");
        return;
      }

      // ── Time estimate check ──
      const approxPhotos = manifests.reduce((sum, m) => sum + (m.approvedFilenames || []).length, 0);
      if (approxPhotos > 200) {
        const estMin = Math.round(approxPhotos * 0.8 / 60);
        const proceed = confirm(
          `🏷️ Fix Photo Metadata\n\nApproximately ${approxPhotos} photos to update.\n` +
          `Estimated time: ~${estMin > 0 ? estMin + " minute" + (estMin !== 1 ? "s" : "") : "< 1 minute"}.\n\n` +
          `Keep this tab open while it runs. Continue?`
        );
        if (!proceed) return;
      }

      // ── GPS availability check ──
      if (rwGps) {
        const uniqueCentres = [...new Set(manifests.map(m => m.centreName).filter(Boolean))];
        const missingGps = [];
        for (const cName of uniqueCentres) {
          const gps = await getCentreGPS(cName).catch(() => null);
          if (!gps) missingGps.push(cName);
        }
        if (missingGps.length > 0) {
          const proceed = confirm(
            `⚠️ No GPS coordinates found for:\n• ${missingGps.join("\n• ")}\n\n` +
            `Photos from these centres won't get location data.\n\n` +
            `💡 To fix: Settings → Centre Locations → add coordinates → run again.\n\n` +
            `Continue without GPS for those centres?`
          );
          if (!proceed) return;
          await send({ type: "LOG_TO_ACTIVITY", level: "WARNING",
            message: `📍 No GPS for: ${missingGps.join(", ")} — run Fix Photo Metadata again after adding coordinates in Settings → Centre Locations`,
          }).catch(() => {});
        }
      }

      // ── UI setup ──
      $btnRewriteMetadata.disabled = true;
      $btnRewriteMetadata.textContent = "⏳ Preparing…";
      const $fixProg    = document.getElementById("metadataFixProgress");
      const $fixProgBar = document.getElementById("metadataFixProgressBar");
      const $fixProgTxt = document.getElementById("metadataFixProgressText");
      const $fixReport  = document.getElementById("metadataFixReport");
      const $stopBtn    = document.getElementById("btnStopMetadataFix");
      if ($fixProg)   $fixProg.style.display = "block";
      if ($fixReport) { $fixReport.style.display = "none"; $fixReport.innerHTML = ""; }

      // ── Stop button ──
      _metadataCancelled = false;
      const stopHandler = () => { _metadataCancelled = true; };
      $stopBtn?.addEventListener("click", stopHandler, { once: true });

      try {
        // ── Build filename → manifest lookup ──
        const fileToManifest = new Map();
        for (const m of manifests) {
          for (const fname of (m.approvedFilenames || [])) {
            fileToManifest.set(fname, m);
          }
        }

        // GPS + per-centre warning cache
        const gpsCache  = new Map();
        const warnedGps = new Set(); // warn once per centre

        let rewritten = 0, skipped = 0, errors = 0, processed = 0, metaMismatches = 0;
        const loopStart = Date.now();

        const allFiles  = await walkFolder(handle, "");
        const jpegFiles = allFiles.filter(f => /\.(jpg|jpeg)$/i.test(f));
        const total     = jpegFiles.length;
        if ($fixProgBar) $fixProgBar.max = total;

        for (const path of jpegFiles) {
          if (_metadataCancelled) break;

          processed++;
          const elapsed = Date.now() - loopStart;
          const avgMs   = processed > 0 ? elapsed / processed : 0;
          const eta     = (processed >= 3 && avgMs > 0 && (total - processed) > 0)
            ? ` · ⏱ ${_fmtEta(avgMs * (total - processed))}` : "";
          if ($fixProgBar) $fixProgBar.value = processed;
          if ($fixProgTxt) $fixProgTxt.textContent = `Photo ${processed}/${total}: ${path.split("/").pop()}${eta}`;

          // ── RAM: GC yield every 50 photos ──
          if (processed % 50 === 0) await new Promise(r => setTimeout(r, 0));

          const filename = path.split("/").pop();
          const manifest = fileToManifest.get(filename);
          if (!manifest) { skipped++; continue; }

          try {
            const dataUrl    = await readFileAsDataUrl(handle, path);
            const centreName = manifest.centreName || "";

            if (rwGps && centreName && !gpsCache.has(centreName)) {
              const gps = await getCentreGPS(centreName).catch(() => null);
              gpsCache.set(centreName, gps);
              // Warn once per centre (not per photo — too spammy)
              if (!gps && !warnedGps.has(centreName)) {
                warnedGps.add(centreName);
                await send({ type: "LOG_TO_ACTIVITY", level: "WARNING",
                  message: `📍 No GPS for "${centreName}" — location not embedded. → Settings → Centre Locations`,
                }).catch(() => {});
              }
            }
            const gpsCoords = (rwGps && centreName) ? (gpsCache.get(centreName) || null) : null;

            const exifArtist  = centreName
              ? `Storypark Smart Saver -- ${centreName}`.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 255)
              : "Storypark Smart Saver";
            // Filter out recovery placeholder text so it's never embedded in EXIF
            const rawExcerpt  = manifest.excerpt || "";
            const description = manifest.storyBody ||
              (rawExcerpt.includes("Recovered from disk") ? "" : rawExcerpt);
            const iptcCaption  = description.slice(0, 2000);
            const iptcKeywords = [manifest.childName, centreName, manifest.roomName, manifest.educatorName]
              .filter(Boolean).map(k => k.replace(/[,;]/g, " ").trim().slice(0, 64));
            const childTitle   = `${manifest.childName || ""}${manifest.childAge ? ` - ${manifest.childAge}` : ""}`;

            const result = await send({
              type: "REWRITE_EXIF_ONLY", imageDataUrl: dataUrl,
              date:         rwDate ? (manifest.storyDate || null) : null,
              description:  rwIptc ? description : "",
              exifTitle:    rwIptc ? childTitle : "",
              exifSubject:  rwIptc ? description.slice(0, 200) : "",
              exifComments: rwIptc ? description : "",
              exifArtist:   rwIptc ? exifArtist : "",
              iptcCaption:  rwIptc ? iptcCaption : "",
              iptcKeywords: rwIptc ? iptcKeywords : [],
              iptcByline:   rwIptc ? exifArtist : "",
              gpsCoords,
            });

            if (result?.ok && result.dataUrl) {
              const rwParts = path.split("/");
              let rwDir = handle;
              for (let i = 0; i < rwParts.length - 1; i++) rwDir = await rwDir.getDirectoryHandle(rwParts[i]);
              const rwFileHandle = await rwDir.getFileHandle(rwParts[rwParts.length - 1]);
              const b64 = result.dataUrl.split(",")[1];
              const bin = atob(b64);
              const buf = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
              const writable = await rwFileHandle.createWritable();
              await writable.write(new Blob([buf], { type: "image/jpeg" }));
              await writable.close();
              rewritten++;

              // ── Metadata verification: char-limit-aware EXIF accuracy check ──
              // readBack is returned by REWRITE_EXIF_ONLY (read via piexifjs after write).
              // Apply the same sanitize + slice limits used at write time before comparing.
              if (verifyMetadata && result.readBack) {
                const rb = result.readBack;
                // Artist: expected = same replace + trim + slice(0,255) as write time
                const expectedArtist = (exifArtist || "Storypark Smart Saver")
                  .replace(/[^\x20-\x7E]/g, "").trim().slice(0, 255).toLowerCase();
                const actualArtist = (rb.artist || "").toLowerCase();
                if (actualArtist && expectedArtist && actualArtist !== expectedArtist) {
                  metaMismatches++;
                  await send({ type: "LOG_TO_ACTIVITY", level: "WARNING",
                    message: `⚠ Artist mismatch in ${filename}: expected "${exifArtist.slice(0,50)}" → got "${rb.artist.slice(0,50)}"`,
                    meta: { centreName },
                  }).catch(() => {});
                }
                // GPS: expected coordinates present → verify they were embedded
                if (rwGps && gpsCoords && !rb.hasGps) {
                  metaMismatches++;
                  await send({ type: "LOG_TO_ACTIVITY", level: "WARNING",
                    message: `⚠ GPS not embedded in ${filename} (${centreName}) — coordinates were not written`,
                    meta: { centreName },
                  }).catch(() => {});
                }
              }
            } else {
              errors++;
            }
          } catch (err) {
            console.warn(`[fixMetadata] ${filename}:`, err.message);
            errors++;
          }
        }

        const stopped   = _metadataCancelled ? " (stopped)" : "";
        const finalMsg  =
          `🏷️ Metadata fixed: ${rewritten} photos${stopped}` +
          (skipped > 0 ? `, ${skipped} skipped (no story data)` : "") +
          (errors  > 0 ? `, ${errors} errors` : "") +
          (metaMismatches > 0 ? `, ${metaMismatches} metadata mismatches (see Activity Log)` : "");
        toast(finalMsg, "success", 6000);

        if ($fixReport) {
          $fixReport.style.display = "block";
          $fixReport.innerHTML =
            `✅ <strong>${rewritten}</strong> photos updated` +
            (skipped > 0 ? ` · ⏭ <strong>${skipped}</strong> skipped` : "") +
            (errors  > 0 ? ` · ❌ <strong>${errors}</strong> errors` : "") +
            (metaMismatches > 0 ? ` · ⚠ <strong>${metaMismatches}</strong> metadata mismatches (see Activity Log)` : "") +
            (_metadataCancelled ? ` · ⏹ Stopped by user` : "");
        }

        await send({ type: "LOG_TO_ACTIVITY",
          level: rewritten > 0 ? "SUCCESS" : "INFO",
          message: finalMsg,
          meta: { childName: targetChildId ? (manifests[0]?.childName || "") : undefined },
        }).catch(() => {});

      } catch (err) {
        toast(`Fix failed: ${err.message}`, "error");
      } finally {
        $btnRewriteMetadata.disabled = false;
        $btnRewriteMetadata.textContent = "🏷️ Fix Photo Metadata";
        if ($fixProg) $fixProg.style.display = "none";
        $stopBtn?.removeEventListener("click", stopHandler);
        _metadataCancelled = false;
      }
    });
  }

  /* ── 5B: Active Database info panel ── */

  /**
   * Fetch and render the Active Database info panel.
   * Calls ACTIVE_DATABASE_INFO → background → getActiveDatabaseInfo() in db.js.
   */
  async function loadActiveDatabaseInfo() {
    const $panel = document.getElementById("activeDatabasePanel");
    if (!$panel) return;
    $panel.innerHTML = '<em style="color:var(--muted);">Loading…</em>';
    try {
      const res = await send({ type: "ACTIVE_DATABASE_INFO" });
      if (!res?.ok || !res.info) {
        $panel.innerHTML = '<em style="color:var(--muted);">No folder linked — link your Storypark Smart Saver folder to see database details.</em>';
        return;
      }
      const info = res.info;
      if (!info.linkedFolderName) {
        $panel.innerHTML = '<em style="color:var(--muted);">No folder linked — link your Storypark Smart Saver folder to see database details.</em>';
        return;
      }
      const existingFiles = (info.files || []).filter(f => f.exists);
      const totalKB       = Math.round(existingFiles.reduce((s, f) => s + f.sizeBytes, 0) / 1024);

      let lastUpdatedStr = "never";
      if (info.lastUpdated) {
        const ageMs = Date.now() - new Date(info.lastUpdated).getTime();
        const ageMins = Math.floor(ageMs / 60000);
        const ageHrs  = Math.floor(ageMins / 60);
        if (ageMins < 2)   lastUpdatedStr = "just now";
        else if (ageMins < 60) lastUpdatedStr = `${ageMins} min ago`;
        else if (ageHrs < 24)  lastUpdatedStr = `${ageHrs}h ${ageMins % 60}m ago`;
        else                   lastUpdatedStr = new Date(info.lastUpdated).toLocaleDateString();
      }

      const fileLines = (info.files || []).map(f =>
        `<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="color:${f.exists ? "var(--text)" : "var(--muted)"};">${f.exists ? "✅" : "⚠️"} ${f.name}</span>
          <span style="color:var(--muted);font-size:11px;">${f.exists ? Math.round(f.sizeBytes / 1024) + " KB" : "missing"}</span>
        </div>`
      ).join("");

      $panel.innerHTML = `
        <div style="margin-bottom:8px;">
          <strong style="color:var(--text);">📂 ${info.folderPath || info.linkedFolderName + "/Database"}</strong>
        </div>
        <div style="display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap;">
          <span>🗂 <strong>${existingFiles.length}</strong> of ${(info.files || []).length} files present</span>
          <span>💾 <strong>${totalKB} KB</strong> total</span>
          <span>⏱ Updated: <strong>${lastUpdatedStr}</strong></span>
        </div>
        <div style="font-size:11px;line-height:1.8;">${fileLines}</div>
      `;
    } catch (e) {
      $panel.innerHTML = `<em style="color:var(--muted);">Could not load database info: ${e.message}</em>`;
    }
  }

  document.getElementById("btnRefreshDbInfo")?.addEventListener("click", () => loadActiveDatabaseInfo());
  document.getElementById("btnOpenDbFolderHint")?.addEventListener("click", async () => {
    const res = await send({ type: "ACTIVE_DATABASE_INFO" });
    const path = res?.info?.folderPath;
    if (path) {
      await navigator.clipboard.writeText(path).catch(() => {});
      toast(`📋 Path copied: ${path}`, "success", 4000);
    } else {
      toast("No folder linked", "error");
    }
  });

  // Auto-load when Settings tab first opens (called from initSettingsTab)
  loadActiveDatabaseInfo();

  /* ── 3D: Audit & Repair Stories panel ── */

  const $btnAudit       = document.getElementById("btnAuditStories");
  const $btnRepairAll   = document.getElementById("btnRepairAll");
  const $btnSyncProc    = document.getElementById("btnSyncProcessed");
  const $btnRebuildRej  = document.getElementById("btnRebuildRejections");
  const $auditProgress  = document.getElementById("auditProgress");
  const $auditProgBar   = document.getElementById("auditProgressBar");
  const $auditProgTxt   = document.getElementById("auditProgressText");
  const $auditReport    = document.getElementById("auditReport");

  // Stores audit results so "Repair" can act on them without re-running the audit
  let _lastAuditStories = [];

  if ($btnAudit) {
    $btnAudit.addEventListener("click", async () => {
      // Walk folder + call AUDIT_AND_REPAIR which handles rate-limiting,
      // progress bar, stop button, and re-audit — all via the scan bar.
      const handle = await getLinkedFolder().catch(() => null);
      if (!handle) { toast("Link a download folder first (Settings → Link Download Folder)", "error"); return; }
      if (isRunning) { toast("Already in progress", "error"); return; }

      $btnAudit.disabled = true;
      $btnAudit.textContent = "⏳ Walking folder…";
      if ($auditReport) $auditReport.style.display = "none";
      if ($btnRepairAll) $btnRepairAll.style.display = "none";

      try {
        // Walk disk (FSA)
        let onDiskPaths = [];
        try { onDiskPaths = await walkFolder(handle, ""); } catch (e) {
          toast("Could not read folder: " + e.message, "error"); return;
        }
        // Build rejected files map
        const rejectedFilesByChild = {};
        const isSSS = handle.name === "Storypark Smart Saver";
        const offset = isSSS ? 0 : 1;
        for (const p of onDiskPaths) {
          if (!p.includes(" Rejected Matches/Stories/")) continue;
          const parts = p.split("/");
          const childName = (parts[0 + offset] || "").replace(/ Rejected Matches$/, "");
          const folderName = parts[2 + offset] || "";
          const filename = parts[parts.length - 1] || "";
          if (!childName || !folderName || !filename) continue;
          if (!rejectedFilesByChild[childName]) rejectedFilesByChild[childName] = {};
          if (!rejectedFilesByChild[childName][folderName]) rejectedFilesByChild[childName][folderName] = [];
          rejectedFilesByChild[childName][folderName].push(filename);
        }

        // Start AUDIT_AND_REPAIR — it uses the scan bar, stop button, activity log
        setRunning(true);
        $scanLog.innerHTML = "";
        setStatus("yellow", "Auditing & repairing…");
        const res = await send({
          type: "AUDIT_AND_REPAIR",
          onDiskPaths,
          rejectedFilesByChild: Object.keys(rejectedFilesByChild).length ? rejectedFilesByChild : null,
        });
        if (!res?.ok && !res?.started) {
          setRunning(false);
          toast(res?.error || "Failed to start", "error");
        }
        // Results arrive via AUDIT_REPAIR_DONE + SCAN_COMPLETE messages
      } finally {
        $btnAudit.disabled = false;
        $btnAudit.textContent = "📊 Scan & Repair";
      }
    });
  }


  // $btnRepairAll is shown by AUDIT_REPAIR_DONE when broken stories are found.
  // It re-runs AUDIT_AND_REPAIR for partial+DB-only stories.
  if ($btnRepairAll) {
    $btnRepairAll.addEventListener("click", () => {
      // Just re-trigger the audit+repair
      $btnAudit?.click();
    });
  }


  if ($btnSyncProc) {
    $btnSyncProc.addEventListener("click", async () => {
      if (!confirm(
        "Mark every story in Database/manifests.json as processed?\n\n" +
        "This tells the next Scan Latest to only fetch NEW stories since your latest manifest entry. " +
        "Safe to run anytime — does not delete or change any files."
      )) return;
      $btnSyncProc.disabled = true;
      $btnSyncProc.textContent = "⏳ Syncing…";
      const res = await send({ type: "SYNC_PROCESSED_FROM_MANIFEST" });
      $btnSyncProc.disabled = false;
      $btnSyncProc.textContent = "🔄 Sync Scan Progress";
      if (res?.ok) {
        toast(`✅ Synced ${res.synced} stories — next Scan Latest will only fetch NEW content`, "success", 5000);
      } else {
        toast(res?.error || "Sync failed", "error");
      }
    });
  }

  if ($btnRebuildRej) {
    $btnRebuildRej.addEventListener("click", async () => {
      const handle = await getLinkedFolder().catch(() => null);
      if (!handle) { toast("Link a folder first", "error"); return; }

      $btnRebuildRej.disabled = true;
      $btnRebuildRej.textContent = "⏳ Walking folders…";
      try {
        // Walk to find Rejected Matches folders
        const allFiles = await walkFolder(handle, "");
        const rejectedFilesByChild = {};
        const isSSS = handle.name === "Storypark Smart Saver";
        const offset = isSSS ? 0 : 1;

        for (const p of allFiles) {
          if (!p.includes(" Rejected Matches/Stories/")) continue;
          const parts = p.split("/");
          const childRejPart = parts[0 + offset] || "";
          const childName    = childRejPart.replace(/ Rejected Matches$/, "");
          const folderName   = parts[2 + offset] || "";
          const filename     = parts[parts.length - 1] || "";
          if (!childName || !folderName || !filename) continue;
          if (!rejectedFilesByChild[childName]) rejectedFilesByChild[childName] = {};
          if (!rejectedFilesByChild[childName][folderName]) rejectedFilesByChild[childName][folderName] = [];
          rejectedFilesByChild[childName][folderName].push(filename);
        }

        const res = await send({ type: "REBUILD_REJECTIONS_FROM_FOLDERS", rejectedFilesByChild });
        if (res?.ok) {
          toast(`✅ Rebuilt rejections: ${res.added} entries added from Rejected Matches folders`, "success", 5000);
        } else {
          toast(res?.error || "Rebuild failed", "error");
        }
      } catch (e) {
        toast(`Rebuild failed: ${e.message}`, "error");
      } finally {
        $btnRebuildRej.disabled = false;
        $btnRebuildRej.textContent = "🔄 Rebuild Rejections";
      }
    });
  }

  /* ── 6: Generate Story Cards (settings) ── */

  document.getElementById("btnGenerateStoryCardsAll")?.addEventListener("click", async () => {
    const $btn = document.getElementById("btnGenerateStoryCardsAll");
    const $status = document.getElementById("storyCardsStatus");
    const childId = document.getElementById("storyCardsChildSel")?.value || null;
    if ($btn) { $btn.disabled = true; $btn.textContent = "⏳ Generating…"; }
    if ($status) $status.textContent = "⏳ Generating story cards…";
    const res = await send({
      type: "GENERATE_STORY_CARDS_ALL",
      childId: childId || undefined,
    });
    if ($btn) { $btn.disabled = false; $btn.textContent = "🎴 Generate Story Cards"; }
    if (res?.ok) {
      const msg = `✅ Generated ${res.generated} cards${res.skipped > 0 ? `, ${res.skipped} skipped` : ""}${res.errors > 0 ? `, ${res.errors} errors` : ""}`;
      if ($status) $status.textContent = msg;
      toast(msg, "success", 5000);
    } else {
      const msg = `❌ Failed: ${res?.error || "Unknown error"}`;
      if ($status) $status.textContent = msg;
      toast(msg, "error");
    }
  });
}


/* ================================================================== */
/*  Clean Up Folder — face-based photo cleanup                        */
/* ================================================================== */

/** State for the cleanup undo feature (safe mode only). */
let _cleanupUndoList   = []; // [{ filePath, originalManifest }]
let _cleanupUndoTimer  = null;
let _cleanupDirHandle  = null;
let _metadataCancelled = false; // set by Stop button in Fix Photo Metadata

/**
 * Walk a child's Stories folder, run face detection on each image,
 * and remove photos that don't match the child's face.
 *
 * Runs entirely in the dashboard (page context) using:
 *   - File System Access API for disk reads/writes
 *   - face.js detectFaces + matchEmbedding for face matching
 *   - db.js removeFileFromStoryManifest for IDB updates
 *   - BUILD_HTML_STRUCTURE message to background for HTML regeneration
 */
async function runCleanup() {
  const $cleanupChildSelect  = document.getElementById("cleanupChildSelect");
  const $btnRunCleanup       = document.getElementById("btnRunCleanup");
  const $btnUndoCleanup      = document.getElementById("btnUndoCleanup");
  const $cleanupProgress     = document.getElementById("cleanupProgress");
  const $cleanupProgressBar  = document.getElementById("cleanupProgressBar");
  const $cleanupProgressText = document.getElementById("cleanupProgressText");
  const $cleanupReport       = document.getElementById("cleanupReport");

  const childId   = $cleanupChildSelect.value;
  const childName = $cleanupChildSelect.options[$cleanupChildSelect.selectedIndex]?.textContent || "";
  if (!childId) { toast("Select a child first", "error"); return; }

  const handle = await getLinkedFolder();
  if (!handle) {
    toast("Link a download folder first (Settings → Link Download Folder)", "error");
    return;
  }

  // Get child's descriptors
  const rec = await getDescriptors(childId).catch(() => null);
  if (!rec?.descriptors?.length) {
    toast("No face data for this child — train the face model first (Phase 1+)", "error");
    return;
  }
  const storedDescs = rec.descriptors;

  // Load face detection models
  if (!humanAvailable) { toast("Face models not available", "error"); return; }
  try { await loadModels(); } catch (e) {
    toast(`❌ Face models failed to load: ${e.message}`, "error");
    return;
  }

  const mode           = document.querySelector('input[name="cleanupMode"]:checked')?.value || "dry-run";
  const keepThreshold  = parseInt(document.getElementById("cleanupThresholdNumber").value) || 40;

  // Confirm destructive mode
  if (mode === "destructive") {
    if (!confirm(`⚠️ DESTRUCTIVE MODE\n\nPhotos below ${keepThreshold}% face match will be PERMANENTLY DELETED.\nThis cannot be undone.\n\nContinue?`)) return;
  }

  // Set up UI using shared helpers
  setOperationRunning($btnRunCleanup, true, "🧹 Run Clean Up", "⏳ Analysing…");
  $btnUndoCleanup.style.display = "none";
  showOperationProgress($cleanupProgress, $cleanupProgressBar, $cleanupReport, null);

  const INVALID_CHARS  = /[/\\:*?"<>|]/g;
  const childSafe      = childName.replace(INVALID_CHARS, "_").trim();
  // Detect whether the SSS folder itself is linked (paths differ):
  //   SSS linked:    "Harry Hill/Stories/..."
  //   Parent linked: "Storypark Smart Saver/Harry Hill/Stories/..."
  const _sssLinked2    = handle.name === "Storypark Smart Saver";
  const storiesPrefix  = _sssLinked2 ? `${childSafe}/Stories` : `Storypark Smart Saver/${childSafe}/Stories`;
  const MEDIA_EXT      = /\.(jpg|jpeg|png|gif|webp)$/i;

  // Walk all files in the child's Stories folder
  let allFiles = [];
  try {
    allFiles = await walkFolder(handle);
  } catch (e) {
    toast(`❌ Failed to read folder: ${e.message}`, "error");
    $btnRunCleanup.disabled = false;
    $btnRunCleanup.textContent = "🧹 Run Clean Up";
    $cleanupProgress.style.display = "none";
    return;
  }

  // Filter: images only, in this child's Stories folder, exclude "Rejected Matches" folders
  const imageFiles = allFiles.filter(f =>
    f.startsWith(storiesPrefix + "/") &&
    !f.includes(" Rejected Matches/") &&
    MEDIA_EXT.test(f)
  );

  if (imageFiles.length === 0) {
    toast(`No images found for ${childName} — run a scan first`, "error");
    setOperationRunning($btnRunCleanup, false, "🧹 Run Clean Up");
    hideOperationProgress($cleanupProgress);
    return;
  }

  $cleanupProgressBar.max = imageFiles.length;

  // Load all story manifests for this child (for IDB updates)
  const allManifests = await getAllDownloadedStories().catch(() => []);
  const childManifests = allManifests.filter(m =>
    m.childId === childId || m.childName === childName
  );
  const manifestByFolder = new Map(childManifests.map(m => [m.folderName, m]));

  const kept   = [];
  const removed = [];
  const errors  = [];
  let processed = 0;

  _cleanupUndoList  = [];
  _cleanupDirHandle = handle;
  const _cleanupLoopStart = Date.now(); // ETA tracking

  for (const filePath of imageFiles) {
    processed++;
    updateProgressBar($cleanupProgressBar, $cleanupProgressText, processed, imageFiles.length, _cleanupLoopStart,
      `Checking ${processed}/${imageFiles.length}: ${filePath.split("/").pop()}`);

    try {
      // Read image from disk as data URL
      const dataUrl = await readFileAsDataUrl(handle, filePath);

      // Create Image element for face detection
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

      // Detect faces
      let faces = [];
      try { faces = await detectFaces(img); } catch { /* model not available */ }

      // Get best match score against child's stored descriptors
      let bestScore = 0;
      if (faces.length > 0 && storedDescs.length > 0) {
        for (const face of faces) {
          if (face.embedding) {
            const score = (await matchEmbedding(face.embedding, storedDescs)) ?? 0;
            if (score > bestScore) bestScore = score;
          }
        }
      }

      const isMatch = bestScore >= keepThreshold;

      if (isMatch) {
        kept.push({ filePath, score: Math.round(bestScore) });
      } else {
        // Parse path to find story manifest.
        // Path structure depends on which folder is linked:
        //   SSS linked:    [childSafe, "Stories", folderName, filename] → folderName at [2]
        //   Parent linked: [ROOT, childSafe, "Stories", folderName, filename] → folderName at [3]
        const pathParts  = filePath.split("/");
        const folderIdx  = _sssLinked2 ? 2 : 3;
        const folderName = pathParts.length >= (folderIdx + 2) ? pathParts[folderIdx] : null;
        const filename   = pathParts[pathParts.length - 1];
        const manifest   = folderName ? manifestByFolder.get(folderName) : null;

        if (mode !== "dry-run") {
          // Take a snapshot of the manifest BEFORE modifying (for undo)
          const originalManifest = manifest ? JSON.parse(JSON.stringify(manifest)) : null;

          if (mode === "safe") {
            await moveFileToRejected(handle, filePath);
          } else if (mode === "destructive") {
            await deleteFile(handle, filePath);
          }

          // Update IDB manifest — atomic rejection bookkeeping (Phase 3G):
          //   Safe mode: the file was MOVED to Rejected Matches/, so record a proper
          //     rejection in manifest.rejectedFilenames AND Database/rejections.json
          //     so re-scans never re-queue it and story.html/card omit it.
          //   Destructive mode: the file was DELETED, so just strip it from the
          //     manifest (no rejection record — it no longer exists to skip).
          if (manifest) {
            if (mode === "safe") {
              // Moves approvedFilenames → rejectedFilenames AND stamps savedAt + schemaVersion=2
              await markFilenameRejectedInManifest(manifest.childId, manifest.storyId, filename);
              // Persist to Database/rejections.json by image original URL if we have it
              const mediaEntry = (manifest.mediaUrls || []).find(mu => mu.filename === filename);
              const originalUrl = mediaEntry?.originalUrl;
              if (manifest.storyId && originalUrl) {
                await addRejection(manifest.storyId, originalUrl).catch(() => {});
              }
              // Mirror in local cache
              manifest.approvedFilenames = (manifest.approvedFilenames || []).filter(f => f !== filename);
              manifest.rejectedFilenames = Array.from(new Set([...(manifest.rejectedFilenames || []), filename]));
            } else {
              // destructive: file gone entirely → remove from manifest (no rejection record)
              await removeFileFromStoryManifest(manifest.childId, manifest.storyId, filename);
              manifest.approvedFilenames = (manifest.approvedFilenames || []).filter(f => f !== filename);
            }
          }

          if (mode === "safe" && originalManifest) {
            _cleanupUndoList.push({ filePath, originalManifest });
          }
        }

        removed.push({ filePath, score: Math.round(bestScore), faces: faces.length });
      }
    } catch (e) {
      errors.push({ filePath, error: e.message });
    }
  }

  // Regenerate HTML if any files were actually changed
  if (removed.length > 0 && mode !== "dry-run") {
    $cleanupProgressText.textContent = "Regenerating HTML pages…";
    await send({ type: "BUILD_HTML_STRUCTURE" }).catch(() => {});
  }

  // Show report
  $cleanupProgress.style.display = "none";
  $cleanupReport.style.display   = "block";
  const isDryRun = mode === "dry-run";
  // Show Undo button (safe mode only, 60 second window)
  $cleanupReport.innerHTML = [
    `<strong>📊 ${isDryRun ? "Dry-Run Preview" : "Clean Up Complete"}</strong>`,
    `✅ <strong>${kept.length}</strong> photos kept (face match ≥ ${keepThreshold}%)`,
    `${isDryRun ? "⚠ Would remove" : "🗑 Removed"}: <strong>${removed.length}</strong> photo${removed.length !== 1 ? "s" : ""} (no/low face match)`,
    errors.length > 0 ? `❌ <strong>${errors.length}</strong> files could not be processed` : "",
    !isDryRun && mode === "safe" && removed.length > 0 ? `📁 Moved to: <code>${childSafe} Rejected Matches/</code> — beside the ${childSafe}/ folder` : "",
    !isDryRun && mode === "destructive" && removed.length > 0 ? `🗑 Permanently deleted` : "",
    isDryRun && removed.length > 0 ? `💡 Switch to Safe or Destructive mode and run again to apply changes.` : "",
  ].filter(Boolean).join("<br>");

  if (mode === "safe" && _cleanupUndoList.length > 0) {
    const $timerSpan = document.getElementById("cleanupUndoTimer");
    $btnUndoCleanup.style.display = "";
    let secondsLeft = 60;
    $timerSpan.textContent = secondsLeft;
    if (_cleanupUndoTimer) clearInterval(_cleanupUndoTimer);
    _cleanupUndoTimer = setInterval(() => {
      secondsLeft--;
      $timerSpan.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        clearInterval(_cleanupUndoTimer);
        _cleanupUndoList  = [];
        _cleanupDirHandle = null;
        $btnUndoCleanup.style.display = "none";
      }
    }, 1000);
  }

  $btnRunCleanup.disabled = false;
  $btnRunCleanup.textContent = "🧹 Run Clean Up";

  const verb = isDryRun ? "would remove" : "removed";
  toast(`✅ Analysis done — ${verb} ${removed.length} photos, kept ${kept.length}`,
    removed.length > 0 && !isDryRun ? "success" : "success", 5000);
}

/**
 * Undo the last cleanup run (safe mode only).
 * Moves all files back from _rejected/ to their original locations,
 * restores the IDB manifests, and regenerates HTML.
 */
async function undoCleanup() {
  const $btnUndoCleanup = document.getElementById("btnUndoCleanup");
  if (_cleanupUndoList.length === 0 || !_cleanupDirHandle) {
    toast("Nothing to undo", "error");
    return;
  }

  $btnUndoCleanup.disabled = true;
  $btnUndoCleanup.textContent = "⏳ Restoring…";
  if (_cleanupUndoTimer) { clearInterval(_cleanupUndoTimer); _cleanupUndoTimer = null; }

  let restored = 0;
  for (const item of _cleanupUndoList) {
    try {
      // Move file back from _rejected/ to original location
      await restoreFromRejected(_cleanupDirHandle, item.filePath);
      // Restore the original IDB manifest (put() overwrites the modified one)
      if (item.originalManifest) {
        await addDownloadedStory(item.originalManifest);
      }
      restored++;
    } catch (e) {
      console.warn("[cleanup-undo] Failed to restore:", item.filePath, e.message);
    }
  }

  // Regenerate HTML to reflect restored photos
  if (restored > 0) {
    await send({ type: "BUILD_HTML_STRUCTURE" }).catch(() => {});
  }

  _cleanupUndoList  = [];
  _cleanupDirHandle = null;
  $btnUndoCleanup.style.display   = "none";
  $btnUndoCleanup.disabled        = false;
  $btnUndoCleanup.textContent     = "⤺ Undo";

  toast(`✅ Restored ${restored} photo${restored !== 1 ? "s" : ""}`, "success");
}

/* ================================================================== */
/*  Offline Smart Scan — self-improving AI on local files             */
/* ================================================================== */

/**
 * Run the same face-matching AI pipeline as the online scan, but read
 * photos from the linked local folder instead of the Storypark API.
 *
 * High confidence → appendDescriptor (AI learns immediately, no review needed)
 * Medium confidence → addToReviewQueue → user approves in Review tab → AI learns
 * Low confidence → appendNegativeDescriptor (AI learns what NOT to match)
 *
 * 100% offline — reads local files, no internet required.
 * The extension tab must stay open while the scan is running.
 */
async function runOfflineScan() {
  const $cleanupChildSelect  = document.getElementById("cleanupChildSelect");
  const $btnOfflineScan      = document.getElementById("btnOfflineScan");
  const $cleanupProgress     = document.getElementById("cleanupProgress");
  const $cleanupProgressBar  = document.getElementById("cleanupProgressBar");
  const $cleanupProgressText = document.getElementById("cleanupProgressText");
  const $cleanupReport       = document.getElementById("cleanupReport");

  const childId   = $cleanupChildSelect.value;
  const childName = $cleanupChildSelect.options[$cleanupChildSelect.selectedIndex]?.textContent || "";
  if (!childId) { toast("Select a child first", "error"); return; }

  const handle = await getLinkedFolder();
  if (!handle) {
    toast("Link a download folder first (Settings → Link Download Folder)", "error");
    return;
  }

  const rec = await getDescriptors(childId).catch(() => null);
  if (!rec?.descriptors?.length) {
    toast("No face data — go to Settings → Face Training and upload photos of your child first", "error");
    return;
  }
  const storedDescs = rec.descriptors;

  if (!humanAvailable) { toast("Face models not available", "error"); return; }
  try { await loadModels(); } catch (e) {
    toast(`❌ Face models failed to load: ${e.message}`, "error");
    return;
  }

  // Get thresholds from settings
  const stored = await chrome.storage.local.get(["autoThreshold", "minThreshold", "keepScenarioPhotos"]).catch(() => ({}));
  const autoThreshold      = stored.autoThreshold      ?? 85;
  const minThreshold       = stored.minThreshold       ?? 50;
  const keepScenarioPhotos = stored.keepScenarioPhotos ?? false;

  setOperationRunning($btnOfflineScan, true, "🔍 Offline Smart Scan", "⏳ Scanning…");
  showOperationProgress($cleanupProgress, $cleanupProgressBar, $cleanupReport, null);

  const INVALID_CHARS  = /[/\\:*?"<>|]/g;
  const childSafe      = childName.replace(INVALID_CHARS, "_").trim();
  // Path prefix depends on whether SSS folder itself is linked
  const _sssLinked3    = handle.name === "Storypark Smart Saver";
  const storiesPrefix  = _sssLinked3 ? `${childSafe}/Stories` : `Storypark Smart Saver/${childSafe}/Stories`;
  const MEDIA_EXT      = /\.(jpg|jpeg|png|gif|webp)$/i;
  const year           = new Date().getFullYear().toString();

  // Walk the child's Stories folder, skipping Rejected Matches folders
  let allFiles = [];
  try {
    allFiles = await walkFolder(handle, "", { skipRejected: true });
  } catch (e) {
    toast(`❌ Failed to read folder: ${e.message}`, "error");
    setOperationRunning($btnOfflineScan, false, "🔍 Offline Smart Scan");
    hideOperationProgress($cleanupProgress);
    return;
  }

  const imageFiles = allFiles.filter(f =>
    f.startsWith(storiesPrefix + "/") && MEDIA_EXT.test(f)
  );

  if (imageFiles.length === 0) {
    toast(`No images found for ${childName} — run a scan first to download photos`, "error");
    setOperationRunning($btnOfflineScan, false, "🔍 Offline Smart Scan");
    hideOperationProgress($cleanupProgress);
    return;
  }

  $cleanupProgressBar.max = imageFiles.length;
  let autoApproved = 0, queued = 0, rejected = 0, noFace = 0, errors = 0;
  let processed = 0;
  const _offlineScanLoopStart = Date.now(); // ETA tracking

  for (const filePath of imageFiles) {
    processed++;
    updateProgressBar($cleanupProgressBar, $cleanupProgressText, processed, imageFiles.length, _offlineScanLoopStart,
      `Scanning ${processed}/${imageFiles.length}: ${filePath.split("/").pop()}`);

    // ── RAM management: GC yield + offscreen recycle via shared helper ──
    await yieldForGC(processed, imageFiles.length, $cleanupProgressText);

    try {
      const dataUrl = await readFileAsDataUrl(handle, filePath);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

      // Face detection (local AI model)
      let faces = [];
      try { faces = await detectFaces(img); } catch { /* model error — skip */ }

      if (faces.length === 0) {
        noFace++;
        if (!keepScenarioPhotos) {
          const thumb = await _createSmallThumbnail(dataUrl);
          await addToReviewQueue({
            childId, childName,
            storyData: { storyId: `offline:${filePath}`, createdAt: null, originalUrl: null },
            savePath: filePath, description: `📷 Scenario photo — no face detected. Keep?`,
            croppedFaceDataUrl: thumb, fullPhotoDataUrl: null,
            descriptor: null, matchPct: 0, noFace: true, isOfflineFile: true, filePath,
          });
          queued++;
        }
        continue;
      } // No face in photo

      // Find best matching face
      let bestScore = 0;
      let bestDescriptor = null;
      for (const face of faces) {
        if (face.embedding) {
          const score = (await matchEmbedding(face.embedding, storedDescs)) ?? 0;
          if (score > bestScore) { bestScore = score; bestDescriptor = face.embedding; }
        }
      }

      if (bestScore >= autoThreshold) {
        // High confidence — auto-confirm, teach the model
        if (bestDescriptor) {
          await appendDescriptor(childId, childName, Array.from(bestDescriptor), year);
        }
        autoApproved++;
      } else if (bestScore >= minThreshold) {
        // Medium confidence — send to Review tab for human decision
        const thumbnail = await _createSmallThumbnail(dataUrl);
        await addToReviewQueue({
          childId, childName,
          storyData: { storyId: `offline:${filePath}`, createdAt: null, originalUrl: null },
          savePath:  filePath,
          description: `📁 Offline: ${filePath.split("/").pop()}`,
          croppedFaceDataUrl: thumbnail,
          fullPhotoDataUrl: null, // Too large to store — thumbnail is enough
          descriptor: bestDescriptor ? Array.from(bestDescriptor) : null,
          matchPct: Math.round(bestScore),
          noFace: false,
          isOfflineFile: true,  // Signals background.js to skip download step on approval
          filePath,
        });
        queued++;
      } else {
        // Low confidence — learn what NOT to match
        if (bestDescriptor) {
          await appendNegativeDescriptor(childId, Array.from(bestDescriptor));
        }
        rejected++;
      }
    } catch (e) {
      errors++;
      console.warn("[offline-scan] Error processing:", filePath, e.message);
    }
  }

  // Notify background to refresh profiles with newly learned descriptors
  if (autoApproved > 0 || rejected > 0) {
    chrome.runtime.sendMessage({ type: "REFRESH_PROFILES" }).catch(() => {});
  }

  // Notify Review tab if new items were queued
  if (queued > 0) {
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
  }

  // Try to advance phase
  send({ type: "ADVANCE_PHASE", childId }).catch(() => {});

  hideOperationProgress($cleanupProgress);
  $cleanupReport.style.display    = "block";
  $cleanupReport.innerHTML = [
    `<strong>📊 Offline Smart Scan Complete</strong>`,
    `✅ <strong>${autoApproved}</strong> photos auto-confirmed (≥ ${autoThreshold}% — AI learned!)`,
    `👀 <strong>${queued}</strong> uncertain matches sent to Review tab (${minThreshold}–${autoThreshold}%)`,
    `❌ <strong>${rejected}</strong> non-matches learned as negative examples`,
    noFace > 0 ? `📷 ${noFace} photos had no face detected (skipped)` : "",
    errors > 0 ? `⚠ ${errors} files could not be read` : "",
    queued > 0 ? `💡 Go to the 👀 Review tab — ${queued} photos need your decision.` : "",
  ].filter(Boolean).join("<br>");

  setOperationRunning($btnOfflineScan, false, "🔍 Offline Smart Scan");
  toast(`✅ Offline scan done — ${autoApproved} confirmed, ${queued} to review`, "success", 5000);
}

/* ================================================================== */
/*  Re-evaluate All Photos                                             */
/* ================================================================== */

/**
 * Re-run face matching on all downloaded photos (Stories + Rejected Matches)
 * using the current (improved) face model.  Photos that score above minThreshold
 * are sent to the Review tab so the user can rescue them or confirm them.
 * Photos from Rejected Matches that score better are labelled for rescue.
 */
let _reEvalAllRunning = false;
async function runReEvaluateAll() {
  if (_reEvalAllRunning) { toast("Re-evaluation already running", "error"); return; }
  const $cleanupChildSel   = document.getElementById("cleanupChildSelect");
  const $cleanupProgress   = document.getElementById("cleanupProgress");
  const $cleanupProgressBar  = document.getElementById("cleanupProgressBar");
  const $cleanupProgressText = document.getElementById("cleanupProgressText");
  const $cleanupReport     = document.getElementById("cleanupReport");
  const $btnReEvalAll      = document.getElementById("btnReEvaluateAll");

  const childId   = $cleanupChildSel?.value;
  const childName = $cleanupChildSel?.options[$cleanupChildSel.selectedIndex]?.textContent || "";
  if (!childId) { toast("Select a child first", "error"); return; }

  const handle = await getLinkedFolder();
  if (!handle) { toast("Link a download folder first", "error"); return; }

  const rec = await getDescriptors(childId).catch(() => null);
  if (!rec?.descriptors?.length) {
    toast("No face data — train the model first (Settings → Face Training)", "error"); return;
  }
  const storedDescs = rec.descriptors;

  if (!humanAvailable) { toast("Face models not available", "error"); return; }
  try { await loadModels(); } catch (e) { toast(`❌ Face models failed: ${e.message}`, "error"); return; }

  const stg = await chrome.storage.local.get(["autoThreshold", "minThreshold"]).catch(() => ({}));
  const autoThreshold = stg.autoThreshold ?? 85;
  const minThreshold  = stg.minThreshold  ?? 50;

  _reEvalAllRunning = true;
  setOperationRunning($btnReEvalAll, true, "🔄 Re-evaluate All");
  showOperationProgress($cleanupProgress, $cleanupProgressBar, $cleanupReport, null);

  const INVALID_CHARS  = /[/\\:*?"<>|]/g;
  const childSafe      = childName.replace(INVALID_CHARS, "_").trim();
  // Path prefix depends on whether SSS folder itself is linked
  const _sssLinked4    = handle.name === "Storypark Smart Saver";
  const storiesPrefix  = _sssLinked4 ? `${childSafe}/Stories` : `Storypark Smart Saver/${childSafe}/Stories`;
  const rejectedPrefix = _sssLinked4 ? `${childSafe} Rejected Matches/Stories` : `Storypark Smart Saver/${childSafe} Rejected Matches/Stories`;
  const MEDIA_EXT      = /\.(jpg|jpeg|png|gif|webp)$/i;

  let allFiles = [];
  try { allFiles = await walkFolder(handle, "", {}); }
  catch (e) { toast(`❌ Could not read folder: ${e.message}`, "error"); _reEvalAllRunning = false; setOperationRunning($btnReEvalAll, false, "🔄 Re-evaluate All"); hideOperationProgress($cleanupProgress); return; }

  const imageFiles = allFiles.filter(f =>
    (f.startsWith(storiesPrefix + "/") || f.startsWith(rejectedPrefix + "/")) && MEDIA_EXT.test(f)
  );
  if (imageFiles.length === 0) {
    toast(`No photos found for ${childName}`, "error");
    _reEvalAllRunning = false; setOperationRunning($btnReEvalAll, false, "🔄 Re-evaluate All"); hideOperationProgress($cleanupProgress); return;
  }
  if ($cleanupProgressBar) $cleanupProgressBar.max = imageFiles.length;

  let rescored = 0, errors = 0, processed = 0;
  const loopStart = Date.now();

  for (const filePath of imageFiles) {
    processed++;
    updateProgressBar($cleanupProgressBar, $cleanupProgressText, processed, imageFiles.length, loopStart,
      `Checking ${processed}/${imageFiles.length}: ${filePath.split("/").pop()}`);
    // ── RAM management: GC yield + offscreen recycle via shared helper ──
    await yieldForGC(processed, imageFiles.length, $cleanupProgressText);

    try {
      const dataUrl = await readFileAsDataUrl(handle, filePath);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      let faces = [];
      try { faces = await detectFaces(img); } catch { /* skip */ }
      if (faces.length === 0) continue;

      let bestScore = 0, bestDescriptor = null;
      for (const face of faces) {
        if (face.embedding) {
          const score = (await matchEmbedding(face.embedding, storedDescs)) ?? 0;
          if (score > bestScore) { bestScore = score; bestDescriptor = face.embedding; }
        }
      }
      if (bestScore < minThreshold) continue; // still below threshold — skip

      const isFromRejected = filePath.includes(" Rejected Matches/");
      const thumbnail = await _createSmallThumbnail(dataUrl);
      await addToReviewQueue({
        childId, childName,
        storyData: { storyId: `re-eval:${filePath}`, createdAt: null, originalUrl: null },
        savePath: filePath,
        description: isFromRejected
          ? `⤴ Rescued! Now ${Math.round(bestScore)}% — approve to move back to Stories`
          : `🔄 Re-evaluated: ${Math.round(bestScore)}% match — approve to keep`,
        croppedFaceDataUrl: thumbnail, fullPhotoDataUrl: null,
        descriptor: bestDescriptor ? Array.from(bestDescriptor) : null,
        matchPct: Math.round(bestScore), noFace: false, isOfflineFile: true, filePath,
        isFromRejected,
        originalFilePath: isFromRejected
          ? filePath.split("/").map((p, i) => i === 1 ? p.replace(/ Rejected Matches$/, "") : p).join("/")
          : filePath,
      });
      rescored++;
    } catch (e) { errors++; }
  }

  _reEvalAllRunning = false;
  setOperationRunning($btnReEvalAll, false, "🔄 Re-evaluate All");
  hideOperationProgress($cleanupProgress);
  if ($cleanupReport) {
    $cleanupReport.style.display = "block";
    $cleanupReport.innerHTML =
      `<strong>📊 Re-evaluate Complete</strong><br>` +
      `👀 <strong>${rescored}</strong> photos sent to Review tab` +
      (errors > 0 ? ` · ❌ <strong>${errors}</strong> errors` : "") +
      `<br><p class="help" style="margin-top:6px;">Go to the 👀 Review tab to keep or skip each photo.</p>`;
  }
  if (rescored > 0) {
    chrome.runtime.sendMessage({ type: "REVIEW_QUEUE_UPDATED" }).catch(() => {});
    toast(`🔄 Re-evaluation done — ${rescored} photos sent to Review`, "success", 5000);
    await send({ type: "LOG_TO_ACTIVITY", level: "SUCCESS",
      message: `🔄 Re-evaluated ${imageFiles.length} photos for ${childName}: ${rescored} sent to Review${errors > 0 ? `, ${errors} errors` : ""}`,
      meta: { childName },
    }).catch(() => {});
  } else {
    toast(`🔄 Re-evaluation done — no new matches found`, "success", 4000);
  }
}

/* ================================================================== */
/*  Real-time messages from background                                 */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG") scanLog(msg.message);
  if (msg.type === "LOG_ENTRY") {
    appendActivityEntry(msg.entry);
    const datePart = msg.entry.storyDate ? `${msg.entry.storyDate} ` : "";
    const ts = new Date(msg.entry.timestamp).toLocaleTimeString(undefined, { hour12: false });
    scanLog(`[${datePart}${ts}] [${msg.entry.level}] ${msg.entry.message}`);
    // Persistent error banner: show ERROR-level entries in a sticky banner under the log
    // until the user explicitly dismisses it (no auto-dismiss).
    if (msg.entry.level === "ERROR") {
      const $errBanner = document.getElementById("lastErrorBanner");
      const $errText   = document.getElementById("lastErrorText");
      if ($errBanner && $errText) {
        $errText.textContent = `🛑 ${msg.entry.message}`;
        $errBanner.style.display = "flex";
      }
    }
  }
  if (msg.type === "REVIEW_QUEUE_UPDATED") {
    // During active scans, only update the badge count (lightweight) to avoid
    // the full grid re-render that clears and rebuilds the entire review page.
    // The grid is fully refreshed when:
    //   - User switches to Review tab (switchTab)
    //   - User clicks "↻ Refresh" manually
    //   - Scan completes (SCAN_COMPLETE)
    //   - User approves/rejects an item (handleReviewApprove/Reject)
    if (isRunning) {
      // Lightweight badge + status update: fetch count without re-rendering grid
      send({ type: "GET_REVIEW_QUEUE" }).then(res => {
        if (!res?.ok) return;
        const freshQueue = res.queue || [];
        const count = freshQueue.length;
        if (count > 0) {
          $reviewBadge.style.display = "";
          $reviewBadge.textContent = count;
          // Track how many new items arrived since last full render
          const delta = count - reviewQueue.length;
          if (delta > 0) _pendingNewCount += delta;
          // Auto-append new cards if user is on Review tab
          if (activeTab === "review") {
            const newItems = freshQueue.filter(i => !reviewQueue.some(q => q.id === i.id));
            if (newItems.length > 0) {
              reviewQueue.push(...newItems);
              appendCards(newItems);
            }
          }
        } else {
          $reviewBadge.style.display = "none";
        }
        updateReviewStatus();
      });
    } else {
      // Not scanning: debounced smart merge — coalesce rapid REVIEW_QUEUE_UPDATED bursts
      // Skip entirely if we're in the middle of a local approve/reject action
      if (_localActionInProgress) return;
      clearTimeout(_queueUpdateDebounceTimer);
      _queueUpdateDebounceTimer = setTimeout(() => {
        // Double-check the flag hasn't been set during the debounce window
        if (_localActionInProgress) return;
        // Smart merge: fetch fresh queue and diff against local state
        send({ type: "GET_REVIEW_QUEUE" }).then(res => {
          if (!res?.ok) return;
          mergeReviewQueue(res.queue || []);
          loadChildPhase();
        });
      }, 1500);
    }
  }
  if (msg.type === "PROGRESS") {
    $progressBar.style.display = "block";
    $progressText.style.display = "block";
    $progressBar.value = msg.current;
    $progressBar.max = msg.total;
    const childPart      = msg.childName ? `Scanning ${msg.childName} — ` : "";
    const datePart       = msg.date ? ` (${msg.date})` : "";
    const etaPart        = msg.eta ? ` · ⏱ ${msg.eta}` : "";
    const childCountPart = (msg.childCount > 1 && msg.childIndex)
      ? ` · Child ${msg.childIndex}/${msg.childCount}` : "";
    const progressStr = `${childPart}story ${msg.current} of ${msg.total}${datePart}${childCountPart}${etaPart}`;
    $progressText.textContent = progressStr;
    // Mirror progress to global stop banner
    const $gText = document.getElementById("globalScanText");
    const $gBar  = document.getElementById("globalScanBar");
    if ($gText) $gText.textContent = `📥 ${progressStr}`;
    if ($gBar)  { $gBar.value = msg.current; $gBar.max = msg.total; }
  }
  if (msg.type === "BATCH_PROGRESS") {
    const pct = Math.round((msg.done / msg.total) * 100);
    $progressBar.value = msg.done;
    $progressBar.max = msg.total;
    $progressBar.style.display = "block";
    $progressText.style.display = "block";
    const batchEtaPart = msg.eta ? ` · ⏱ ${msg.eta}` : "";
    $progressText.textContent = `📥 Batch: ${msg.downloaded} downloaded${msg.failed > 0 ? `, ${msg.failed} failed` : ""} (${msg.done}/${msg.total} — ${pct}%)${batchEtaPart}`;
  }
  if (msg.type === "AUDIT_REPAIR_DONE") {
    // Update the audit report panel with post-repair summary
    const s = msg.summary || {};
    const $ar = document.getElementById("auditReport");
    const $rp = document.getElementById("btnRepairAll");
    if ($ar) {
      const stillBroken = (s.partialPhotos || 0) + (s.dbOnly || 0);
      $ar.style.display = "block";
      $ar.innerHTML = [
        `<strong>📊 Post-Repair — ${s.complete + s.partialPhotos + s.dbOnly + s.partialAssets || 0} stories</strong>`,
        s.repaired > 0 ? `✅ <strong>${s.repaired}</strong> files restored` : "",
        s.failed > 0 ? `❌ <strong>${s.failed}</strong> failed` : "",
        s.skipped > 0 ? `⚠ <strong>${s.skipped}</strong> need fresh scan (expired URLs)` : "",
        `📊 Now: ${s.complete || 0} complete · ${s.partialPhotos || 0} partial · ${s.dbOnly || 0} DB-only · ${s.partialAssets || 0} HTML/Card only`,
        s.totalMissing > 0 ? `⚠ <strong>${s.totalMissing}</strong> files still missing` : "🎉 All files are on disk!",
        stillBroken > 0 ? `<br>💡 <strong>${stillBroken}</strong> stories still need fixing — run a fresh <strong>Scan All Stories</strong> to fetch new CDN URLs.` : "",
      ].filter(Boolean).join("<br>");
    }
    if ($rp) $rp.style.display = "none"; // hide after repair completes
    return;
  }
  if (msg.type === "VIDEO_DOWNLOAD_PROGRESS") {
    // v2.4 (7D): Videos stream into the offscreen doc as a Blob; the offscreen
    // broadcasts this event every ~2 s while bytes are being received.
    // Surface the progress via the scan log only (not the big status bar, which
    // is still owned by BATCH_PROGRESS / PROGRESS). Format: "⬇ video.mp4: 45% of 120 MB"
    const name = (msg.savePath || msg.videoUrl || "video").split("/").pop();
    const pct  = msg.percent != null ? `${msg.percent}%` : "…";
    const size = msg.totalBytes ? ` of ${(msg.totalBytes / 1048576).toFixed(0)} MB` : "";
    scanLog(`⬇ video ${name}: ${pct}${size} (${msg.mb ?? 0} MB received)`);
  }

  if (msg.type === "SCAN_COMPLETE") {
    setRunning(false);
    loadChildPhase();
    // Reset pending count & auto-resolved counter, then do full refresh
    _pendingNewCount = 0;
    _totalAutoResolved = 0;
    _reviewPageStart = 0;
    refreshReviewQueue();
  }
  if (msg.type === "PHASE_ADVANCED") {
    loadChildPhase();
    const EMOJIS = { 2: "✅", 3: "📊", 4: "" };
    const LABELS = { 2: "Validation", 3: "Confident", 4: "Production — downloads unlocked!" };
    const p = msg.phase?.phase || 2;
    toast(`${EMOJIS[p] || "📊"} Phase ${p}: ${LABELS[p] || "Unknown"}`, "success", 5000);
  }
});

/* ================================================================== */
/*  Tutorial panel (replaces old onboarding overlay)                   */
/* ================================================================== */

const $tutorialPanel = document.getElementById("tutorialPanel");
const $scanLayout    = document.getElementById("scanLayout");

chrome.storage.local.get("tutorialDismissed", ({ tutorialDismissed }) => {
  if (tutorialDismissed) {
    $tutorialPanel.style.display = "none";
    $scanLayout.classList.add("tutorial-hidden");
  }
});

const $btnShowGuide = document.getElementById("btnShowGuide");

document.getElementById("btnDismissTutorial").addEventListener("click", () => {
  chrome.storage.local.set({ tutorialDismissed: true });
  $tutorialPanel.style.display = "none";
  $scanLayout.classList.add("tutorial-hidden");
  if ($btnShowGuide) $btnShowGuide.style.display = "inline-flex";
});

if ($btnShowGuide) {
  chrome.storage.local.get("tutorialDismissed", ({ tutorialDismissed }) => {
    $btnShowGuide.style.display = tutorialDismissed ? "inline-flex" : "none";
  });
  $btnShowGuide.addEventListener("click", () => {
    chrome.storage.local.set({ tutorialDismissed: false });
    $tutorialPanel.style.display = "";
    $scanLayout.classList.remove("tutorial-hidden");
    $btnShowGuide.style.display = "none";
  });
}

/* ================================================================== */
/*  Init                                                               */
/* ================================================================== */

loadChildren();
refreshReviewQueue();
loadActivityLog();
setTimeout(loadChildPhase, 500);
setTimeout(checkForResume, 600);

// ── User Guide + Changelog — load from external markdown files ──
// initGuideTabs wires the [📖 Guide] / [📋 What's New] tab buttons.
// loadUserGuide/loadChangelog fetch userguide.md + changelog.md and render them.
initGuideTabs();
loadUserGuide();
loadChangelog();

// ── Download All Media toggle (Scan tab) ──
// Load initial state from storage and keep in sync with Settings checkbox
chrome.storage.local.get("skipFaceRec", ({ skipFaceRec: sfr = false }) => {
  const $chkMain = document.getElementById("chkSkipFaceRecMain");
  const $warnMain = document.getElementById("downloadAllMediaWarning");
  if ($chkMain) $chkMain.checked = sfr === true;
  if ($warnMain) $warnMain.style.display = sfr ? "block" : "none";
});

document.getElementById("chkSkipFaceRecMain")?.addEventListener("change", (e) => {
  const enabled = e.target.checked;
  const $warnMain = document.getElementById("downloadAllMediaWarning");
  if ($warnMain) $warnMain.style.display = enabled ? "block" : "none";
  // Save setting immediately
  chrome.storage.local.set({ skipFaceRec: enabled });
  // Sync with Settings tab checkbox
  const $chkSettings = document.getElementById("chkSkipFaceRec");
  const $chkSettingsWarn = document.getElementById("skipFaceWarning");
  if ($chkSettings) $chkSettings.checked = enabled;
  if ($chkSettingsWarn) $chkSettingsWarn.style.display = enabled ? "block" : "none";
  // Feedback
  if (enabled) {
    toast("📥 Download All Media enabled — next scan will download everything", "success", 4000);
  }
});

// ── Scan Date Range selector — From/To calendar pickers ──
(function initScanDateRange() {
  const $modeAll    = document.getElementById("scanDateModeAll");
  const $modeCustom = document.getElementById("scanDateModeCustom");
  const $fromDate   = document.getElementById("scanFromDate");
  const $toDate     = document.getElementById("scanToDate");
  const $note       = document.getElementById("scanDateRangeNote");
  if (!$modeAll || !$fromDate) return;

  /** Format YYYY-MM-DD → DD/MM/YYYY for display in the note text. */
  function fmtDisplay(ymd) {
    if (!ymd) return "";
    const [y, m, d] = ymd.split("-");
    return `${d}/${m}/${y}`;
  }

  /** Update the enabled state of the date inputs and the note text. */
  function applyMode(mode) {
    const isCustom = mode === "custom";
    $fromDate.disabled = !isCustom;
    $toDate.disabled   = !isCustom;
    $fromDate.style.opacity = isCustom ? "1" : "0.5";
    $toDate.style.opacity   = isCustom ? "1" : "0.5";
    updateNote(mode);
  }

  function updateNote(mode) {
    if (!$note) return;
    if (mode !== "custom") {
      $note.innerHTML = `⚠️ <strong>All time</strong> — may take 6+ hours. Keep this tab open and don't let your computer sleep.`;
      return;
    }
    const from = $fromDate.value;
    const to   = $toDate.value;
    if (from && to) {
      $note.innerHTML = `📅 Scanning stories from <strong>${fmtDisplay(from)}</strong> → <strong>${fmtDisplay(to)}</strong>.`;
    } else if (from) {
      $note.innerHTML = `📅 Scanning stories from <strong>${fmtDisplay(from)}</strong> → <strong>today</strong>.`;
    } else {
      $note.innerHTML = `💡 Pick a <strong>From</strong> date (and optionally a <strong>To</strong> date) to scan a specific period.`;
    }
  }

  function save() {
    const mode = $modeCustom.checked ? "custom" : "all";
    const from = (mode === "custom" && $fromDate.value) ? $fromDate.value : null;
    const to   = (mode === "custom" && $toDate.value)   ? $toDate.value   : null;
    chrome.storage.local.set({ scanDateMode: mode, scanCutoffFromDate: from, scanCutoffToDate: to });
    updateNote(mode);
  }

  // Restore saved state on load
  chrome.storage.local.get(["scanDateMode", "scanCutoffFromDate", "scanCutoffToDate"], (data) => {
    const mode = data.scanDateMode || "all";
    if (mode === "custom") $modeCustom.checked = true;
    else                   $modeAll.checked    = true;
    if (data.scanCutoffFromDate) $fromDate.value = data.scanCutoffFromDate;
    if (data.scanCutoffToDate)   $toDate.value   = data.scanCutoffToDate;
    applyMode(mode);
  });

  $modeAll.addEventListener("change",    () => { applyMode("all");    save(); });
  $modeCustom.addEventListener("change", () => { applyMode("custom"); save(); });
  $fromDate.addEventListener("change",   () => save());
  $toDate.addEventListener("change",     () => save());
})();

// "Open Settings → Centre Locations" link
document.getElementById("linkToSettingsGps")?.addEventListener("click", (e) => {
  e.preventDefault();
  switchTab("settings");
  // Give the settings tab a moment to render, then scroll to Centre Locations
  setTimeout(() => {
    document.getElementById("centreList")?.closest(".card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 150);
});

// Restore scan state
send({ type: "GET_SCAN_STATUS" }).then(res => {
  if (!res?.ok) return;
  if (res.isScanning) {
    setRunning(true);
    $progressBar.style.display = "block";
    $progressText.style.display = "block";
    if (res.cancelRequested) {
      $progressText.textContent = "Cancelling…";
      $btnStop.style.display = "none";
      setStatus("yellow", "Cancelling…");
    } else {
      $progressText.textContent = "Scan in progress…";
      setStatus("yellow", "Scan in progress…");
    }
  }
});
