/**
 * dashboard.js — Central Dashboard Shell
 * 
 * ┌─ WHAT THIS FILE OWNS ─┐
 * │ • Tab navigation coordination                              │
 * │ • Shared helper functions (toast, send, formatDate)        │
 * │ • Global message listener (PROGRESS, LOG_ENTRY, etc.)      │
 * │ • Module initialization and lifecycle                      │
 * └─────────────────────────────────────────────────────────────┘
 */

import { initScanTab } from "./dashboard-scan.js";
import { initReviewTab } from "./dashboard-review.js";
import { initSettingsTab, loadSettingsChildren } from "./dashboard-settings.js";
import { initToolsTab } from "./dashboard-tools.js";
import { getLinkedFolder } from "./lib/disk-sync.js";

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

/** Format milliseconds as "~Xh Ym" / "~Ym" / "< 1m" for ETA displays. */
function _fmtEta(ms) {
  if (!ms || ms <= 0 || !isFinite(ms)) return "";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return "< 1m";
  const h = Math.floor(s / 3600), m2 = Math.floor((s % 3600) / 60);
  return h > 0 ? (m2 > 0 ? `~${h}h ${m2}m` : `~${h}h`) : `~${m2}m`;
}

/**
 * Update a progress bar + label with an automatically-calculated ETA.
 * Call once per loop iteration instead of duplicating 5 lines in every loop.
 */
function updateProgressBar($bar, $text, processed, total, loopStart, label) {
  if ($bar) $bar.value = processed;
  if ($text) {
    const elapsed = Date.now() - loopStart;
    const avgMs = processed > 1 ? elapsed / (processed - 1) : 0;
    const eta = (processed >= 4 && avgMs > 0 && (total - processed) > 0)
      ? ` · ⏱ ${_fmtEta(avgMs * (total - processed))}` : "";
    $text.textContent = `${label}${eta}`;
  }
}

/**
 * Yield for GC every 10 iterations + recycle the offscreen AI document every 50.
 * Call inside any face-detection loop to prevent OOM on large photo libraries.
 */
async function yieldForGC(processed, total, $text) {
  if (processed % 10 === 0) await new Promise(r => setTimeout(r, 0));
  if (processed % 50 === 0 && processed < total) {
    if ($text) $text.textContent = `♻️ Refreshing AI memory… (${processed}/${total})`;
    await chrome.runtime.sendMessage({ type: "RECYCLE_OFFSCREEN" }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
  }
}

/**
 * Shared refreshReviewQueue function that all modules can call.
 * Delegates to the Review tab module's implementation.
 */
async function refreshReviewQueue() {
  if (window._refreshReviewQueue) {
    await window._refreshReviewQueue();
  }
}

// Package helpers for modules
const helpers = {
  send,
  toast,
  formatDate,
  updateProgressBar,
  yieldForGC,
  refreshReviewQueue,
};

/* ================================================================== */
/*  Tab navigation                                                     */
/* ================================================================== */

const navBtns = document.querySelectorAll(".sidebar-nav .nav-btn");
let activeTab = "sync";

const $qsStep1 = document.getElementById("qsStep1");
const $qsStep2 = document.getElementById("qsStep2");
const $qsStep3 = document.getElementById("qsStep3");
const $qsStep4 = document.getElementById("qsStep4");
const $qsStep5 = document.getElementById("qsStep5");
const $qsState1 = document.getElementById("qsState1");
const $qsState2 = document.getElementById("qsState2");
const $qsState3 = document.getElementById("qsState3");
const $qsState4 = document.getElementById("qsState4");
const $qsState5 = document.getElementById("qsState5");
const $qsFirstTimeBanner = document.getElementById("qsFirstTimeBanner");
const $qsCheckAutoSave = document.getElementById("qsCheckAutoSave");
const $qsCheckSleep = document.getElementById("qsCheckSleep");
const $qsCheckLogin = document.getElementById("qsCheckLogin");
const $btnOpenChromeDownloadsSettings = document.getElementById("btnOpenChromeDownloadsSettings");
const $startupHealthBanner = document.getElementById("startupHealthBanner");
const $startupHealthTitle = document.getElementById("startupHealthTitle");
const $startupHealthBody = document.getElementById("startupHealthBody");
const $startupHealthMeta = document.getElementById("startupHealthMeta");
const $startupHealthPrimary = document.getElementById("startupHealthPrimary");
const $startupHealthSecondary = document.getElementById("startupHealthSecondary");
const $startupHealthDismiss = document.getElementById("startupHealthDismiss");
let _quickStartRunningStep = null;
const STARTUP_HEALTH_DISMISS_KEY = "sspStartupHealthDismissSig";

function _setQuickStepState($btn, $state, done, doneText, pendingText = "Not started") {
  if (!$btn || !$state) return;
  $btn.classList.toggle("is-done", !!done);
  $btn.parentElement?.classList.toggle("is-done", !!done);
  $state.textContent = done ? doneText : pendingText;
}

function _setQuickStepRunning(stepNumber, running) {
  const map = {
    1: { btn: $qsStep1, state: $qsState1 },
    2: { btn: $qsStep2, state: $qsState2 },
    3: { btn: $qsStep3, state: $qsState3 },
    4: { btn: $qsStep4, state: $qsState4 },
    5: { btn: $qsStep5, state: $qsState5 },
  };
  const target = map[stepNumber];
  if (!target?.btn || !target?.state) return;
  target.btn.parentElement?.classList.toggle("is-running", !!running);
  if (running) target.state.textContent = "Running…";
}

async function refreshQuickStartStates() {
  try {
    const db = await send({ type: "ACTIVE_DATABASE_INFO" });
    const sync = await send({ type: "GET_STORYPARK_SYNC_STATUS" });
    const syncHealth = await send({ type: "GET_STORYPARK_SYNC_HEALTH" });
    const info = db?.ok ? (db.info || {}) : {};
    // Prefer a live page-context folder handle check so startup health doesn't
    // get stuck on "Set working directory" when DB telemetry lags.
    const liveHandle = await getLinkedFolder().catch(() => null);
    const linked = !!(liveHandle || info.linkedFolderName);
    const totalStories = Number(info.totalStories || 0);
    const missing = Number(info.storiesNeedingRestore || 0);
    const synced = !!sync?.state?.lastSuccessAt;
    const firstTime = !linked && !synced && totalStories === 0;
    if ($qsFirstTimeBanner) $qsFirstTimeBanner.style.display = firstTime ? "block" : "none";

    const syncInProgress = !!sync?.state?.inProgress;
    _setQuickStepState($qsStep1, $qsState1, linked, "Done");
    if ($qsStep1) {
      $qsStep1.disabled = linked;
      $qsStep1.textContent = linked ? "Directory Set" : "Run Step 1";
      $qsStep1.style.display = linked ? "none" : "";
    }
    _setQuickStepState($qsStep2, $qsState2, synced, synced ? `Done · ${new Date(sync.state.lastSuccessAt).toLocaleDateString()}` : "Not synced yet");
    _setQuickStepState($qsStep3, $qsState3, totalStories > 0, totalStories > 0 ? `Done · ${totalStories} stories saved` : "No saved stories yet");
    _setQuickStepState($qsStep4, $qsState4, totalStories > 0 && missing === 0, totalStories > 0 ? (missing === 0 ? "Done · Nothing missing" : `${missing} stories need restore`) : "Run after first download");

    const hasDb = totalStories > 0 || Number(info.mediaCount || 0) > 0 || Number(info.imageCount || 0) > 0;
    let reviewPending = 0;
    try {
      const rq = await send({ type: "GET_REVIEW_QUEUE" });
      if (rq?.ok && Array.isArray(rq.queue)) reviewPending = rq.queue.length;
    } catch {
      /* ignore */
    }
    const step5Done = hasDb && reviewPending === 0;
    const step5PendingText = !hasDb
      ? "After first download"
      : reviewPending > 0
        ? `${reviewPending} photo(s) in queue`
        : "Open when ready";
    _setQuickStepState($qsStep5, $qsState5, step5Done, "Done · Queue clear", step5PendingText);

    [$qsStep1, $qsStep2, $qsStep3, $qsStep4, $qsStep5].forEach(($btn) => $btn?.parentElement?.classList.remove("is-running"));
    if (syncInProgress) _setQuickStepRunning(2, true);
    if (_quickStartRunningStep && !syncInProgress) _setQuickStepRunning(_quickStartRunningStep, true);

    if ($startupHealthBanner) {
      const health = syncHealth?.health || {};
      const checkpoint = sync?.state?.checkpoint || null;
      const lastSuccessAt = sync?.state?.lastSuccessAt ? new Date(sync.state.lastSuccessAt).toLocaleString() : "Never";
      const drift = Number(info.missingVsApi || 0);
      const storiesNeedRestore = Number(info.storiesNeedingRestore || 0);
      const lastProgressMs = Number(health.lastProgressAgeMs || 0);
      const maybeStalled = !!syncInProgress && lastProgressMs > (15 * 60 * 1000);

      let state = "healthy";
      if (!linked) state = "noWorkingDirectory";
      else if (!hasDb) state = "workingDirectoryNoDb";
      else if (maybeStalled) state = "stalled";
      else if (syncInProgress) state = "syncInProgress";
      else if (drift > 0 || storiesNeedRestore > 0) state = "driftDetected";

      const healthBannerSig = `${state}|${drift}|${storiesNeedRestore}|${linked ? 1 : 0}|${hasDb ? 1 : 0}`;
      const dismissedSig = sessionStorage.getItem(STARTUP_HEALTH_DISMISS_KEY) || "";
      const dismissedForSameSig = dismissedSig === healthBannerSig && state !== "stalled";
      const showIfNotDismissed = state !== "healthy" && (!dismissedForSameSig || state === "stalled");
      $startupHealthBanner.style.display = showIfNotDismissed ? "block" : "none";
      if (showIfNotDismissed) {
        $startupHealthBanner.dataset.dismissSig = healthBannerSig;

        $startupHealthPrimary.style.display = "none";
        $startupHealthSecondary.style.display = "none";
        $startupHealthDismiss.style.display = "none";
        $startupHealthMeta.textContent = "";

        if (state === "noWorkingDirectory") {
        $startupHealthTitle.textContent = "Set Storypark working directory";
        $startupHealthBody.textContent = "Choose your Storypark root folder first. It includes both Database and downloaded media.";
        $startupHealthPrimary.textContent = "Set working directory";
        $startupHealthPrimary.style.display = "";
        $startupHealthDismiss.style.display = "";
      } else if (state === "workingDirectoryNoDb") {
        $startupHealthTitle.textContent = "No local database yet";
        $startupHealthBody.textContent = "Working directory is set, but no local Storypark data exists yet.";
        $startupHealthPrimary.textContent = "Sync from Storypark";
        $startupHealthPrimary.style.display = "";
        $startupHealthDismiss.style.display = "";
      } else if (state === "stalled") {
        $startupHealthTitle.textContent = "Sync may be stalled";
        $startupHealthBody.textContent = "Sync is marked in-progress but no progress has been recorded recently.";
        $startupHealthPrimary.textContent = "Resume checkpoint";
        $startupHealthSecondary.textContent = "Review details";
        $startupHealthPrimary.style.display = "";
        $startupHealthSecondary.style.display = "";
        $startupHealthDismiss.style.display = "";
        $startupHealthMeta.textContent = checkpoint
          ? `Checkpoint: ${checkpoint.childName || checkpoint.childId || "?"} · page ${checkpoint.childPage || 0}`
          : `Last successful sync: ${lastSuccessAt}`;
      } else if (state === "syncInProgress") {
        $startupHealthTitle.textContent = "Sync in progress";
        $startupHealthBody.textContent = "Storypark metadata is currently syncing. You can keep using the dashboard.";
        $startupHealthSecondary.textContent = "Review details";
        $startupHealthSecondary.style.display = "";
        $startupHealthMeta.textContent = checkpoint
          ? `Checkpoint: ${checkpoint.childName || checkpoint.childId || "?"} · page ${checkpoint.childPage || 0}`
          : `Last successful sync: ${lastSuccessAt}`;
      } else if (state === "driftDetected") {
        $startupHealthTitle.textContent = "Library may be out of date";
        $startupHealthBody.textContent = `Found ${drift} missing file(s) across ${storiesNeedRestore} stor${storiesNeedRestore === 1 ? "y" : "ies"} compared with Storypark.`;
        $startupHealthPrimary.textContent = "Sync from Storypark";
        $startupHealthSecondary.textContent = "Review details";
        $startupHealthPrimary.style.display = "";
        $startupHealthSecondary.style.display = "";
        $startupHealthDismiss.style.display = "";
        $startupHealthMeta.textContent = `Last successful sync: ${lastSuccessAt}`;
        }
      }
    }
  } catch {
    // Non-fatal for first-load states.
  }
}

async function loadQuickSetupChecklist() {
  const data = await chrome.storage.local.get([
    "qsCheckAutoSave",
    "qsCheckSleep",
    "qsCheckLogin",
  ]);
  if ($qsCheckAutoSave) $qsCheckAutoSave.checked = !!data.qsCheckAutoSave;
  if ($qsCheckSleep) $qsCheckSleep.checked = !!data.qsCheckSleep;
  if ($qsCheckLogin) $qsCheckLogin.checked = !!data.qsCheckLogin;
}

function wireQuickSetupChecklist() {
  $qsCheckAutoSave?.addEventListener("change", () => {
    chrome.storage.local.set({ qsCheckAutoSave: !!$qsCheckAutoSave.checked });
  });
  $qsCheckSleep?.addEventListener("change", () => {
    chrome.storage.local.set({ qsCheckSleep: !!$qsCheckSleep.checked });
  });
  $qsCheckLogin?.addEventListener("change", () => {
    chrome.storage.local.set({ qsCheckLogin: !!$qsCheckLogin.checked });
  });
  $btnOpenChromeDownloadsSettings?.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://settings/downloads" });
  });
}

function switchTab(tabName) {
  console.log("switchTab called with:", tabName);
  activeTab = tabName;
  
  // Update navigation button active states
  navBtns.forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  
  // Map tab names to panel IDs and toggle visibility
  const panelMap = {
    sync: "tabSync",
    review: "tabReview",
    download: "tabDownload",
    post: "tabPost",
    settings: "tabSettings",
  };

  const targetPanelId = panelMap[tabName];
  console.log("Target panel ID:", targetPanelId);

  if (!targetPanelId) {
    console.error("No panel ID found for tab:", tabName);
    return;
  }

  const uniquePanelIds = [...new Set(Object.values(panelMap))];
  uniquePanelIds.forEach((panelId) => {
    const panel = document.getElementById(panelId);
    if (panel) {
      const isActive = panel.id === targetPanelId;
      panel.classList.toggle("active", isActive);
      console.log(`Panel ${panelId}: ${isActive ? "SHOW" : "HIDE"}`);
    } else {
      console.warn(`Panel not found: ${panelId}`);
    }
  });

  // Lazy-load data when switching to certain tabs
  if (tabName === "download" || tabName === "review") {
    // Download/Review tabs contain review functionality
    if (window._refreshReviewQueue) {
      window._refreshReviewQueue();
    }
    // Auto re-evaluate queue when user returns
    if (window._triggerReEvaluation) {
      window._triggerReEvaluation();
    }
  }

  if (tabName === "settings") {
    initSettingsTab(helpers);
    loadSettingsChildren();
  }

  if (tabName === "sync" || tabName === "post") {
    // These tabs use the tools tab module for folder status
    if (window._updateFolderStatus) {
      window._updateFolderStatus();
    }
  }

  const $keyboardHints = document.getElementById("keyboardHints");
  if ($keyboardHints) {
    $keyboardHints.style.display = tabName === "review" ? "block" : "none";
  }

  refreshQuickStartStates();
}

navBtns.forEach(btn => {
  console.log("Attaching click listener to button:", btn.dataset.tab, btn);
  btn.addEventListener("click", (e) => {
    console.log("Sidebar button clicked:", e.target, "data-tab:", btn.dataset.tab);
    switchTab(btn.dataset.tab);
  });
});

$qsStep1?.addEventListener("click", () => {
  _quickStartRunningStep = 1;
  switchTab("sync");
  document.getElementById("btnLinkFolder")?.click();
  setTimeout(() => { _quickStartRunningStep = null; refreshQuickStartStates(); }, 1500);
});

$qsStep2?.addEventListener("click", () => {
  _quickStartRunningStep = 2;
  switchTab("settings");
  document.getElementById("btnSyncStoryparkInfo")?.click();
  refreshQuickStartStates();
});

$qsStep3?.addEventListener("click", () => {
  _quickStartRunningStep = 3;
  switchTab("download");
  document.getElementById("btnScanMissing")?.click();
  refreshQuickStartStates();
});

$qsStep4?.addEventListener("click", () => {
  _quickStartRunningStep = 4;
  switchTab("sync");
  document.getElementById("btnReconcileFolder")?.click();
  refreshQuickStartStates();
});

$qsStep5?.addEventListener("click", () => {
  switchTab("review");
  if (window._refreshReviewQueue) {
    window._refreshReviewQueue();
  }
  refreshQuickStartStates();
});

console.log("Dashboard.js loaded. Found", navBtns.length, "navigation buttons");

// Handle hash-based deep links (e.g. dashboard.html#settings)
if (location.hash) {
  const tab = location.hash.replace("#", "");
  if (["sync", "review", "download", "post", "settings"].includes(tab)) {
    switchTab(tab);
  }
}

$startupHealthPrimary?.addEventListener("click", () => {
  if ($startupHealthPrimary.textContent === "Set working directory") {
    document.getElementById("btnLinkFolder")?.click();
    return;
  }
  if ($startupHealthPrimary.textContent === "Resume checkpoint") {
    switchTab("settings");
    document.getElementById("btnResumeStoryparkSync")?.click();
    return;
  }
  switchTab("settings");
  document.getElementById("btnSyncStoryparkInfo")?.click();
});

$startupHealthSecondary?.addEventListener("click", () => {
  switchTab("settings");
  document.getElementById("btnRefreshSyncHealth")?.click();
});

$startupHealthDismiss?.addEventListener("click", () => {
  const sig = $startupHealthBanner?.dataset?.dismissSig || "";
  if (sig) sessionStorage.setItem(STARTUP_HEALTH_DISMISS_KEY, sig);
  if ($startupHealthBanner) $startupHealthBanner.style.display = "none";
});

/* ================================================================== */
/*  Global message listener (from background.js)                      */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "LOG_ENTRY") {
    // Scan log display (handled by scan module via window._scanLog if needed)
    // Activity log is handled separately in tools module
    const $scanLogBox = document.getElementById("scanLogBox");
    if ($scanLogBox && activeTab === "download") {
      if ($scanLogBox.firstElementChild?.textContent === "Waiting for action…") {
        $scanLogBox.innerHTML = "";
      }
      const p = document.createElement("p");
      p.className = `level-${msg.entry.level || "INFO"}`;
      p.textContent = msg.entry.message;
      $scanLogBox.appendChild(p);
      $scanLogBox.scrollTop = $scanLogBox.scrollHeight;
    }

    // Activity log display (if log tab is active)
    const $activityLogBox = document.getElementById("activityLogBox");
    if ($activityLogBox) {
      const p = document.createElement("p");
      p.className = `level-${msg.entry.level || "INFO"}`;
      const time = new Date(msg.entry.timestamp).toLocaleTimeString();
      p.textContent = `[${time}] ${msg.entry.message}`;
      $activityLogBox.appendChild(p);
      $activityLogBox.scrollTop = $activityLogBox.scrollHeight;
    }

    // Floating/global banner expandable log panel.
    if (window._appendGlobalScanLog) {
      window._appendGlobalScanLog(msg.entry);
    }
  }

  if (msg.type === "PROGRESS") {
    // Delegate to scan module
    if (window._scanUpdateProgress) {
      window._scanUpdateProgress(msg);
    }
  }

  if (msg.type === "BATCH_PROGRESS") {
    // Batch download progress (from Review tab)
    const $batchProgress = document.getElementById("batchProgress");
    const $batchProgressBar = document.getElementById("batchProgressBar");
    const $batchProgressText = document.getElementById("batchProgressText");
    if ($batchProgress) $batchProgress.style.display = "block";
    if ($batchProgressBar) {
      $batchProgressBar.value = msg.downloaded;
      $batchProgressBar.max = msg.total;
    }
    if ($batchProgressText) {
      const pct = Math.round((msg.downloaded / msg.total) * 100);
      const etaPart = msg.eta ? ` · ⏱ ${msg.eta}` : "";
      $batchProgressText.textContent = `📥 Batch: ${msg.downloaded} downloaded (${pct}%)${etaPart}`;
    }
  }

  if (msg.type === "BATCH_COMPLETE") {
    const $batchProgress = document.getElementById("batchProgress");
    const $batchProgressText = document.getElementById("batchProgressText");
    if ($batchProgress) {
      setTimeout(() => { $batchProgress.style.display = "none"; }, 3000);
    }
    if ($batchProgressText) {
      $batchProgressText.textContent = `✅ Batch complete — ${msg.downloaded} files downloaded`;
    }
  }

  if (msg.type === "REVIEW_QUEUE_UPDATED") {
    // Delegate to review module
    if (window._reviewQueueUpdated) {
      window._reviewQueueUpdated();
    }
  }

  if (msg.type === "SCAN_COMPLETE") {
    // Delegate to scan module
    if (window._scanComplete) {
      window._scanComplete();
    }
    // Also refresh review queue
    refreshReviewQueue();
    _quickStartRunningStep = null;
    refreshQuickStartStates();
  }

  if (msg.type === "PHASE_ADVANCED") {
    // Refresh phase badge in scan tab
    const $childSelect = document.getElementById("childSelect");
    if ($childSelect && $childSelect.value) {
      // Trigger phase reload - scan module handles this via window
      const event = new Event("change");
      $childSelect.dispatchEvent(event);
    }
  }

  sendResponse({ ok: true });
  return true;
});

/* ================================================================== */
/*  Initialize all modules on page load                               */
/* ================================================================== */

// Initialize all tabs
initScanTab(helpers);
initReviewTab(helpers);
initToolsTab(helpers);
refreshQuickStartStates();
loadQuickSetupChecklist();
wireQuickSetupChecklist();

// Settings tab is lazy-loaded on first visit (via switchTab)
// Initial tab is sync (already active in HTML)
