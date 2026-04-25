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
import { initToolsTab, loadActivityLog } from "./dashboard-tools.js";

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

const navBtns = document.querySelectorAll(".nav-btn");
let activeTab = "sync";

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
    download: "tabDownload",
    post: "tabPost",
    settings: "tabSettings"
  };
  
  const targetPanelId = panelMap[tabName];
  console.log("Target panel ID:", targetPanelId);
  
  if (!targetPanelId) {
    console.error("No panel ID found for tab:", tabName);
    return;
  }
  
  // Hide all panels, show target panel
  Object.values(panelMap).forEach(panelId => {
    const panel = document.getElementById(panelId);
    if (panel) {
      const isActive = panel.id === targetPanelId;
      panel.classList.toggle("active", isActive);
      console.log(`Panel ${panelId}: ${isActive ? 'SHOW' : 'HIDE'}`);
    } else {
      console.warn(`Panel not found: ${panelId}`);
    }
  });

  // Lazy-load data when switching to certain tabs
  if (tabName === "download") {
    // Download Engine tab contains review functionality
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
}

navBtns.forEach(btn => {
  console.log("Attaching click listener to button:", btn.dataset.tab, btn);
  btn.addEventListener("click", (e) => {
    console.log("Sidebar button clicked:", e.target, "data-tab:", btn.dataset.tab);
    switchTab(btn.dataset.tab);
  });
});

console.log("Dashboard.js loaded. Found", navBtns.length, "navigation buttons");

// Handle hash-based deep links (e.g. dashboard.html#settings)
if (location.hash) {
  const tab = location.hash.replace("#", "");
  if (["sync", "download", "post", "settings"].includes(tab)) {
    switchTab(tab);
  }
}

/* ================================================================== */
/*  Global message listener (from background.js)                      */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "LOG_ENTRY") {
    // Scan log display (handled by scan module via window._scanLog if needed)
    // Activity log is handled separately in tools module
    const $scanLogBox = document.getElementById("scanLogBox");
    if ($scanLogBox && activeTab === "sync") {
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

// Settings tab is lazy-loaded on first visit (via switchTab)
// Initial tab is sync (already active in HTML)
