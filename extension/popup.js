/**
 * popup.js – Popup UI for Storypark Smart Saver.
 *
 * Tab 1 (Save Photos): child selector, Download Latest / Full History Scan buttons,
 *                       stop scan, progress bar, status indicator, live progress log.
 * Tab 2 (Pending Matches): HITL review queue from IndexedDB.
 * Tab 3 (Activity Log): scrollable terminal showing the persistent log.
 */

/* ================================================================== */
/*  Element refs                                                       */
/* ================================================================== */

const tabButtons       = document.querySelectorAll(".tab");
const tabPanels        = document.querySelectorAll(".tab-panel");

const childSelect      = document.getElementById("childSelect");
const btnRefresh       = document.getElementById("btnRefresh");
const btnExtractLatest = document.getElementById("btnExtractLatest");
const btnDeepRescan    = document.getElementById("btnDeepRescan");
const btnTestConnection= document.getElementById("btnTestConnection");
const btnStopScan      = document.getElementById("btnStopScan");
const statusDot        = document.getElementById("statusDot");
const statusText       = document.getElementById("statusText");
const logBox           = document.getElementById("logBox");
const progressBar      = document.getElementById("progressBar");
const progressText     = document.getElementById("progressText");
const btnOpenStorypark = document.getElementById("btnOpenStorypark");

const reviewBadge      = document.getElementById("reviewBadge");
const reviewItems      = document.getElementById("reviewItems");
const reviewEmpty      = document.getElementById("reviewEmpty");
const btnUndoMatch     = document.getElementById("btnUndoMatch");

const activityLogBox   = document.getElementById("activityLogBox");
const btnClearLog      = document.getElementById("btnClearLog");

const openOptions      = document.getElementById("openOptions");

const onboardingOverlay     = document.getElementById("onboardingOverlay");
const btnDismissOnboarding  = document.getElementById("btnDismissOnboarding");

/* ================================================================== */
/*  Open Storypark – handled natively via <a href> in the HTML       */
/* ================================================================== */

/* ================================================================== */
/*  Toast helper                                                       */
/* ================================================================== */

const toastEl = document.getElementById("toast");
let toastTimer = null;

function showToast(message, type /* "success" | "error" */, durationMs = 3000) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className   = `show ${type}`;
  toastTimer = setTimeout(() => {
    toastEl.className = type; // remove "show" to fade out
  }, durationMs);
}

/* ================================================================== */
/*  Test Connection button                                             */
/* ================================================================== */

btnTestConnection.addEventListener("click", () => {
  btnTestConnection.disabled = true;
  btnTestConnection.textContent = "⏳ Testing…";
  chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }, (res) => {
    btnTestConnection.disabled = false;
    btnTestConnection.textContent = "🔌 Test Connection";
    if (chrome.runtime.lastError) {
      showToast("⚠ Extension error: " + chrome.runtime.lastError.message, "error");
      return;
    }
    if (res?.ok) {
      showToast("✅ Connected", "success");
    } else {
      showToast("❌ Please log in to Storypark", "error");
    }
  });
});

/* ================================================================== */
/*  First-run onboarding                                               */
/* ================================================================== */

chrome.storage.local.get("hasSeenOnboarding", ({ hasSeenOnboarding }) => {
  if (!hasSeenOnboarding) {
    onboardingOverlay.style.display = "flex";
  }
});

btnDismissOnboarding.addEventListener("click", () => {
  chrome.storage.local.set({ hasSeenOnboarding: true });
  onboardingOverlay.style.display = "none";
});

/* ================================================================== */
/*  Tab switching                                                      */
/* ================================================================== */

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    tabPanels.forEach((p)  => p.classList.remove("active"));
    btn.classList.add("active");
    const panelId = "tab" + btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1);
    document.getElementById(panelId).classList.add("active");
  });
});

/* ================================================================== */
/*  Log helpers                                                        */
/* ================================================================== */

function appendLog(message) {
  // Remove the placeholder "Waiting…" paragraph on first real entry
  if (logBox.firstElementChild?.textContent === "Waiting for action…") {
    logBox.innerHTML = "";
  }
  const p = document.createElement("p");
  p.textContent = message;
  logBox.appendChild(p);
  logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() {
  logBox.innerHTML = "";
}

/* ================================================================== */
/*  Activity Log (persistent, terminal-style)                         */
/* ================================================================== */

const LEVEL_COLORS = { INFO: "level-INFO", SUCCESS: "level-SUCCESS", WARNING: "level-WARNING", ERROR: "level-ERROR" };

/**
 * Render a single log entry object into the activity log terminal.
 * @param {{timestamp: string, level: string, message: string}} entry
 */
function appendActivityEntry(entry) {
  // Remove placeholder on first real entry
  if (
    activityLogBox.children.length === 1 &&
    activityLogBox.firstElementChild?.textContent === "No activity yet."
  ) {
    activityLogBox.innerHTML = "";
  }
  const p = document.createElement("p");
  const ts = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false });
  p.className   = LEVEL_COLORS[entry.level] || "level-INFO";
  p.textContent = `[${ts}] [${entry.level}] ${entry.message}`;
  activityLogBox.appendChild(p);
  activityLogBox.scrollTop = activityLogBox.scrollHeight;
}

function renderActivityLog(entries) {
  activityLogBox.innerHTML = "";
  if (!entries || entries.length === 0) {
    const p = document.createElement("p");
    p.className   = "level-INFO";
    p.textContent = "No activity yet.";
    activityLogBox.appendChild(p);
    return;
  }
  for (const entry of entries) {
    appendActivityEntry(entry);
  }
}

function loadActivityLog() {
  chrome.runtime.sendMessage({ type: "GET_ACTIVITY_LOG" }, (res) => {
    if (res?.ok) renderActivityLog(res.activityLog);
  });
}

btnClearLog.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_ACTIVITY_LOG" }, () => {
    renderActivityLog([]);
  });
});

/* ================================================================== */
/*  Status indicator                                                   */
/* ================================================================== */

function setStatus(color, text) {
  statusDot.className  = "dot" + (color ? ` ${color}` : "");
  statusText.textContent = text;
}

/* ================================================================== */
/*  Children dropdown                                                  */
/* ================================================================== */

function populateChildren(children) {
  childSelect.innerHTML = "";
  if (!children || children.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No children found — open Storypark first";
    childSelect.appendChild(opt);
    // Just disable the scan buttons — don't call setRunning(true) which would
    // show the Stop button and permanently hide the extract buttons.
    btnExtractLatest.disabled = true;
    btnDeepRescan.disabled    = true;
    return;
  }
  for (const child of children) {
    const opt = document.createElement("option");
    opt.value = child.id;
    opt.textContent = child.name;
    childSelect.appendChild(opt);
  }
  setRunning(false);
}

// Re-enable scan buttons when the user selects a valid child.
childSelect.addEventListener("change", () => {
  if (!isRunning && childSelect.value) {
    btnExtractLatest.disabled = false;
    btnDeepRescan.disabled    = false;
  }
});

function loadChildren() {
  chrome.runtime.sendMessage({ type: "GET_CHILDREN" }, (res) => {
    if (res?.ok) populateChildren(res.children);
  });
}

btnRefresh.addEventListener("click", () => {
  childSelect.innerHTML = "<option>Refreshing…</option>";
  btnExtractLatest.disabled = true;
  btnDeepRescan.disabled    = true;
  chrome.runtime.sendMessage({ type: "REFRESH_PROFILE" }, (res) => {
    if (chrome.runtime.lastError) {
      appendLog("⚠ Refresh failed: " + chrome.runtime.lastError.message);
      childSelect.innerHTML =
        '<option value="">Failed — open Storypark in a tab and try again</option>';
      return;
    }
    if (res?.ok) {
      populateChildren(res.children);
    } else {
      childSelect.innerHTML =
        '<option value="">Failed — open Storypark in a tab and try again</option>';
    }
  });
});

/* ================================================================== */
/*  Extraction                                                         */
/* ================================================================== */

let isRunning = false;

function setRunning(running) {
  isRunning                 = running;
  btnExtractLatest.disabled = running;
  btnDeepRescan.disabled    = running;
  childSelect.disabled      = running;
  btnRefresh.disabled       = running;

  // When scanning, hide action buttons and show stop; otherwise reverse
  btnExtractLatest.style.display = running ? "none" : "";
  btnDeepRescan.style.display    = running ? "none" : "";
  btnStopScan.style.display      = running ? "block" : "none";

  if (!running) {
    progressBar.style.display    = "none";
    progressText.style.display   = "none";
  }
}

function triggerExtraction(type) {
  if (isRunning) return;

  const childId   = childSelect.value;
  const childName = childSelect.options[childSelect.selectedIndex]?.text || "";

  if (!childId) {
    appendLog("Please select a child first.");
    return;
  }

  setRunning(true);
  clearLog();
  progressBar.value           = 0;
  progressBar.max             = 100;
  progressBar.style.display   = "block";
  progressText.style.display  = "block";
  progressText.textContent    = "Starting…";
  setStatus(
    "yellow",
    type === "EXTRACT_LATEST" ? "Downloading latest…" : "Full history scan…"
  );
  appendLog(
    type === "EXTRACT_LATEST"
      ? "Starting incremental download…"
      : "Starting full history scan…"
  );

  chrome.runtime.sendMessage({ type, childId, childName }, (res) => {
    setRunning(false);
    if (chrome.runtime.lastError) {
      setStatus("red", "Error");
      appendLog("⚠ " + chrome.runtime.lastError.message);
      return;
    }
    if (res?.ok) {
      setStatus("green", "Done");
      const s = res.stats;
      appendLog(
        `✓ Complete — Downloaded: ${s.approved}, Review: ${s.queued}, Rejected: ${s.rejected}`
      );
      if (s.queued > 0) loadReviewQueue();
    } else {
      setStatus("red", "Error");
      appendLog("✗ Error: " + (res?.error || "Unknown error"));
    }
  });
}

btnExtractLatest.addEventListener("click", () => triggerExtraction("EXTRACT_LATEST"));
btnDeepRescan.addEventListener("click",    () => triggerExtraction("DEEP_RESCAN"));

/* ================================================================== */
/*  Stop Scan                                                          */
/* ================================================================== */

btnStopScan.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_SCAN" });
  btnStopScan.style.display = "none";
  appendLog("⏹ Cancellation requested…");
});

/* ================================================================== */
/*  Real-time messages from background                                 */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG")                appendLog(msg.message);
  if (msg.type === "LOG_ENTRY")          appendActivityEntry(msg.entry);
  if (msg.type === "REVIEW_QUEUE_UPDATED") loadReviewQueue();

  if (msg.type === "PROGRESS") {
    progressBar.style.display    = "block";
    progressText.style.display   = "block";
    progressBar.value  = msg.current;
    progressBar.max    = msg.total;
    progressText.textContent =
      `Processing story ${msg.current} of ${msg.total}` +
      (msg.date ? ` (${msg.date})` : "");
  }

  if (msg.type === "SCAN_COMPLETE") {
    setRunning(false);
  }
});

/* ================================================================== */
/*  Review queue                                                       */
/* ================================================================== */

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function buildReviewItemEl(item) {
  const el = document.createElement("div");
  el.className = "review-item";

  // Face thumbnail
  const thumb = document.createElement("img");
  thumb.className = "review-thumb";
  thumb.alt       = "Cropped face";
  if (item.croppedFaceDataUrl) {
    thumb.src = item.croppedFaceDataUrl;
  }

  // Metadata
  const meta = document.createElement("div");
  meta.className = "review-meta";

  const nameEl = document.createElement("div");
  nameEl.className   = "child-name";
  nameEl.textContent = item.matchedChildren?.length
    ? `Is this ${item.matchedChildren.join(" or ")}?`
    : "Unknown child — is this your child?";

  const pctEl = document.createElement("div");
  pctEl.className   = "match-pct";
  pctEl.textContent = `Match: ${item.matchPct ?? 0}%`;

  const dateEl = document.createElement("div");
  dateEl.className   = "post-date";
  dateEl.textContent = formatDate(item.storyData?.createdAt);

  meta.appendChild(nameEl);
  meta.appendChild(pctEl);
  meta.appendChild(dateEl);

  // Multi-face selector: if the item has multiple cropped faces,
  // show thumbnails so the user can pick which face is their child.
  if (item.allFaces && item.allFaces.length > 1) {
    const faceSel = document.createElement("div");
    faceSel.className = "review-face-selector";
    item.allFaces.forEach((face, fi) => {
      const fBtn = document.createElement("img");
      fBtn.className = "review-face-btn" + (fi === (item.selectedFaceIndex || 0) ? " selected" : "");
      fBtn.src = face.croppedDataUrl;
      fBtn.alt = `Face ${fi + 1}`;
      fBtn.title = `Face ${fi + 1} — ${face.matchPct ?? "?"}%`;
      fBtn.addEventListener("click", () => {
        // Update the selected face
        faceSel.querySelectorAll(".review-face-btn").forEach((b) => b.classList.remove("selected"));
        fBtn.classList.add("selected");
        thumb.src = face.croppedDataUrl;
        pctEl.textContent = `Match: ${face.matchPct ?? 0}%`;
        item.selectedFaceIndex = fi;
      });
      faceSel.appendChild(fBtn);
    });
    meta.appendChild(faceSel);
  }

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "review-actions";

  const btnApprove = document.createElement("button");
  btnApprove.className   = "btn-approve";
  btnApprove.title       = "Yes – download this photo";
  btnApprove.textContent = "✅";

  const btnReject = document.createElement("button");
  btnReject.className   = "btn-reject";
  btnReject.title       = "No – discard this photo";
  btnReject.textContent = "❌";

  btnApprove.addEventListener("click", () =>
    handleApprove(item, el, btnApprove, btnReject)
  );
  btnReject.addEventListener("click", () =>
    handleReject(item, el, btnApprove, btnReject)
  );

  actions.appendChild(btnApprove);
  actions.appendChild(btnReject);

  el.appendChild(thumb);
  el.appendChild(meta);
  el.appendChild(actions);
  return el;
}

function renderReviewQueue(queue) {
  reviewItems.innerHTML = "";

  if (queue.length === 0) {
    reviewEmpty.style.display = "block";
    reviewBadge.style.display = "none";
    btnUndoMatch.style.display = "none";
    return;
  }

  reviewEmpty.style.display  = "none";
  reviewBadge.style.display  = "";
  reviewBadge.textContent    = queue.length;

  for (const item of queue) {
    reviewItems.appendChild(buildReviewItemEl(item));
  }
}

function loadReviewQueue() {
  chrome.runtime.sendMessage({ type: "GET_REVIEW_QUEUE" }, (res) => {
    if (res?.ok) renderReviewQueue(res.queue);
  });
}

function refreshBadge() {
  const remaining         = reviewItems.querySelectorAll(".review-item").length;
  reviewBadge.textContent = remaining || "";
  reviewBadge.style.display = remaining ? "" : "none";
  if (remaining === 0) {
    reviewEmpty.style.display = "block";
    btnUndoMatch.style.display = "none";
  }
}

function handleApprove(item, rowEl, btnApprove, btnReject) {
  btnApprove.disabled = true;
  btnReject.disabled  = true;
  btnApprove.textContent = "⏳";

  const selectedFaceIndex = item.selectedFaceIndex ?? 0;

  chrome.runtime.sendMessage({ type: "REVIEW_APPROVE", id: item.id, selectedFaceIndex }, (res) => {
    if (res?.ok) {
      rowEl.remove();
      refreshBadge();
      appendLog("✓ Approved and downloaded photo.");
      // Show undo button
      btnUndoMatch.style.display = "block";
    } else {
      btnApprove.disabled    = false;
      btnReject.disabled     = false;
      btnApprove.textContent = "✅";
      appendLog("✗ Approve failed: " + (res?.error || "Unknown error"));
    }
  });
}

function handleReject(item, rowEl, btnApprove, btnReject) {
  btnApprove.disabled = true;
  btnReject.disabled  = true;

  chrome.runtime.sendMessage({ type: "REVIEW_REJECT", id: item.id }, (res) => {
    if (res?.ok) {
      rowEl.remove();
      refreshBadge();
      // Show undo button
      btnUndoMatch.style.display = "block";
    } else {
      btnApprove.disabled = false;
      btnReject.disabled  = false;
    }
  });
}

/* ================================================================== */
/*  Undo Last Match                                                    */
/* ================================================================== */

btnUndoMatch.addEventListener("click", () => {
  btnUndoMatch.disabled = true;
  chrome.runtime.sendMessage({ type: "UNDO_LAST_REVIEW" }, (res) => {
    btnUndoMatch.disabled = false;
    if (res?.ok) {
      appendLog("⤺ Last review action undone.");
      loadReviewQueue();
      btnUndoMatch.style.display = "none";
    } else {
      appendLog("✗ Undo failed: " + (res?.error || "Nothing to undo"));
    }
  });
});

/* ================================================================== */
/*  Footer – open options                                              */
/* ================================================================== */

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

/* ================================================================== */
/*  Init                                                               */
/* ================================================================== */

loadChildren();
loadReviewQueue();
loadActivityLog();

// Restore scan UI state in case the popup was closed and re-opened while a
// scan is running in the background.
chrome.runtime.sendMessage({ type: "GET_SCAN_STATUS" }, (res) => {
  if (chrome.runtime.lastError || !res?.ok) return;
  if (res.isScanning) {
    setRunning(true);
    progressBar.style.display   = "block";
    progressText.style.display  = "block";
    if (res.cancelRequested) {
      progressText.textContent  = "Cancelling…";
      btnStopScan.style.display = "none";
      setStatus("yellow", "Cancelling scan…");
    } else {
      progressText.textContent = "Scan in progress…";
      setStatus("yellow", "Scan in progress…");
    }
  }
});
