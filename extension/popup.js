/**
 * popup.js – Popup UI for Storypark Smart Saver.
 *
 * Tab 1 (Extract): child selector, Extract Latest / Deep Rescan buttons,
 *                  status indicator, live progress log.
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
const statusDot        = document.getElementById("statusDot");
const statusText       = document.getElementById("statusText");
const logBox           = document.getElementById("logBox");

const reviewBadge      = document.getElementById("reviewBadge");
const reviewItems      = document.getElementById("reviewItems");
const reviewEmpty      = document.getElementById("reviewEmpty");

const activityLogBox   = document.getElementById("activityLogBox");
const btnClearLog      = document.getElementById("btnClearLog");

const openOptions      = document.getElementById("openOptions");

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
    // Disable extract buttons: no valid child to scan
    setRunning(true);
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
  setStatus(
    "yellow",
    type === "EXTRACT_LATEST" ? "Extracting latest…" : "Deep scanning…"
  );
  appendLog(
    type === "EXTRACT_LATEST"
      ? "Starting incremental extraction…"
      : "Starting deep rescan…"
  );

  chrome.runtime.sendMessage({ type, childId, childName }, (res) => {
    setRunning(false);
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
/*  Real-time messages from background                                 */
/* ================================================================== */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG")                appendLog(msg.message);
  if (msg.type === "LOG_ENTRY")          appendActivityEntry(msg.entry);
  if (msg.type === "REVIEW_QUEUE_UPDATED") loadReviewQueue();
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
    handleApprove(item.id, el, btnApprove, btnReject)
  );
  btnReject.addEventListener("click", () =>
    handleReject(item.id, el, btnApprove, btnReject)
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
  if (remaining === 0) reviewEmpty.style.display = "block";
}

function handleApprove(id, rowEl, btnApprove, btnReject) {
  btnApprove.disabled = true;
  btnReject.disabled  = true;
  btnApprove.textContent = "⏳";

  chrome.runtime.sendMessage({ type: "REVIEW_APPROVE", id }, (res) => {
    if (res?.ok) {
      rowEl.remove();
      refreshBadge();
      appendLog("✓ Approved and downloaded photo.");
    } else {
      btnApprove.disabled    = false;
      btnReject.disabled     = false;
      btnApprove.textContent = "✅";
      appendLog("✗ Approve failed: " + (res?.error || "Unknown error"));
    }
  });
}

function handleReject(id, rowEl, btnApprove, btnReject) {
  btnApprove.disabled = true;
  btnReject.disabled  = true;

  chrome.runtime.sendMessage({ type: "REVIEW_REJECT", id }, (res) => {
    if (res?.ok) {
      rowEl.remove();
      refreshBadge();
    } else {
      btnApprove.disabled = false;
      btnReject.disabled  = false;
    }
  });
}

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
