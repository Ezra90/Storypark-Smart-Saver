/**
 * popup.js – Popup UI logic for the Storypark Photo Sync extension.
 *
 * Handles:
 *  - Google connection status indicator
 *  - "Connect to Google" / "Disconnect" toggle
 *  - "Sync Now" button → sends SYNC_NOW to background
 *  - Live progress log fed by runtime messages
 *  - Review Queue (HITL) – shows photos pending manual approval / rejection
 */

const btnConnect   = document.getElementById("btnConnect");
const btnSync      = document.getElementById("btnSync");
const statusDot    = document.getElementById("statusDot");
const statusText   = document.getElementById("statusText");
const logBox       = document.getElementById("logBox");
const openOptions  = document.getElementById("openOptions");
const reviewSection = document.getElementById("reviewSection");
const reviewBadge  = document.getElementById("reviewBadge");
const reviewItems  = document.getElementById("reviewItems");
const reviewEmpty  = document.getElementById("reviewEmpty");

let isConnected = false;
let isSyncing   = false;

/* ------------------------------------------------------------------ */
/*  Log display                                                        */
/* ------------------------------------------------------------------ */

function appendLog(message) {
  const p = document.createElement("p");
  p.textContent = message;
  logBox.appendChild(p);
  logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() {
  logBox.innerHTML = "";
}

// Listen for real-time log messages from background / content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG") {
    appendLog(msg.message);
  } else if (msg.type === "REVIEW_QUEUE_UPDATED") {
    loadReviewQueue();
  }
});

// Load persisted log on popup open
chrome.storage.local.get("syncLog", ({ syncLog = [] }) => {
  clearLog();
  const recent = syncLog.slice(-30);
  if (recent.length === 0) {
    appendLog("No activity yet.");
  } else {
    recent.forEach((line) => appendLog(line));
  }
});

/* ------------------------------------------------------------------ */
/*  Google connection                                                  */
/* ------------------------------------------------------------------ */

function setConnected(connected) {
  isConnected = connected;
  if (connected) {
    statusDot.className = "dot green";
    statusText.textContent = "Connected to Google Photos";
    btnConnect.textContent = "Disconnect Google";
    btnSync.disabled = isSyncing;
  } else {
    statusDot.className = "dot red";
    statusText.textContent = "Not connected";
    btnConnect.textContent = "Connect to Google";
    btnSync.disabled = true;
  }
}

chrome.runtime.sendMessage({ type: "GOOGLE_STATUS" }, (res) => {
  setConnected(res?.connected ?? false);
});

btnConnect.addEventListener("click", () => {
  if (isConnected) {
    chrome.runtime.sendMessage({ type: "GOOGLE_DISCONNECT" }, () => {
      setConnected(false);
      appendLog("Disconnected from Google.");
    });
  } else {
    btnConnect.disabled = true;
    btnConnect.textContent = "Connecting…";
    chrome.runtime.sendMessage({ type: "GOOGLE_CONNECT" }, (res) => {
      btnConnect.disabled = false;
      if (res?.ok) {
        setConnected(true);
        appendLog("✓ Connected to Google Photos.");
      } else {
        setConnected(false);
        appendLog("✗ Connection failed: " + (res?.error || "Unknown error"));
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Sync                                                               */
/* ------------------------------------------------------------------ */

btnSync.addEventListener("click", () => {
  if (isSyncing) return;
  isSyncing = true;
  btnSync.disabled = true;
  btnSync.textContent = "⏳ Syncing…";
  statusDot.className = "dot yellow";
  statusText.textContent = "Sync in progress…";
  clearLog();
  appendLog("Starting sync…");

  chrome.runtime.sendMessage({ type: "SYNC_NOW" }, (res) => {
    isSyncing = false;
    btnSync.disabled = false;
    btnSync.textContent = "🔄 Sync Now";

    if (res?.ok) {
      const s = res.summary;
      statusDot.className = "dot green";
      statusText.textContent = "Sync complete";
      let msg =
        `✓ Done! Scraped: ${s.scraped}, Uploaded: ${s.uploaded}`;
      if (s.reviewQueued > 0) msg += `, Review queue: ${s.reviewQueued}`;
      if (s.quotaHit) msg += " (quota reached)";
      appendLog(msg);
      // Refresh review queue if new items were queued
      if (s.reviewQueued > 0) loadReviewQueue();
    } else {
      statusDot.className = "dot red";
      statusText.textContent = "Sync failed";
      appendLog("✗ Error: " + (res?.error || "Unknown error"));
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Review Queue (HITL)                                                */
/* ------------------------------------------------------------------ */

function formatDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildReviewItem(item) {
  const el = document.createElement("div");
  el.className = "review-item";
  el.dataset.id = item.id;

  const thumb = document.createElement("img");
  thumb.className = "review-thumb";
  thumb.alt = "Photo";
  // Load thumbnail from the scraped image URL
  thumb.src = item.imageUrl;
  thumb.onerror = () => { thumb.style.background = "#333"; };

  const meta = document.createElement("div");
  meta.className = "review-meta";

  const childName = document.createElement("div");
  childName.className = "child-name";
  childName.textContent = item.matchedChildren?.length
    ? item.matchedChildren.join(", ")
    : "Unknown";

  const matchPct = document.createElement("div");
  matchPct.className = "match-pct";
  matchPct.textContent = `Match: ${item.matchPct ?? 0}%`;

  const postDate = document.createElement("div");
  postDate.className = "post-date";
  postDate.textContent = formatDate(item.postDate);

  meta.appendChild(childName);
  meta.appendChild(matchPct);
  meta.appendChild(postDate);

  const actions = document.createElement("div");
  actions.className = "review-actions";

  const btnApprove = document.createElement("button");
  btnApprove.className = "btn-approve";
  btnApprove.title = "Approve – upload to Google Photos";
  btnApprove.textContent = "✅";
  btnApprove.addEventListener("click", () => handleApprove(item.id, el, btnApprove, btnReject));

  const btnReject = document.createElement("button");
  btnReject.className = "btn-reject";
  btnReject.title = "Reject – discard this photo";
  btnReject.textContent = "❌";
  btnReject.addEventListener("click", () => handleReject(item.id, el, btnApprove, btnReject));

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
    reviewSection.style.display = "none";
    return;
  }
  reviewSection.style.display = "block";
  reviewBadge.textContent = queue.length;
  reviewEmpty.style.display = queue.length === 0 ? "block" : "none";
  for (const item of queue) {
    reviewItems.appendChild(buildReviewItem(item));
  }
}

function loadReviewQueue() {
  chrome.runtime.sendMessage({ type: "GET_REVIEW_QUEUE" }, (res) => {
    if (res?.ok) renderReviewQueue(res.queue);
  });
}

function handleApprove(id, rowEl, btnApprove, btnReject) {
  btnApprove.disabled = true;
  btnReject.disabled = true;
  btnApprove.textContent = "⏳";
  chrome.runtime.sendMessage({ type: "REVIEW_APPROVE", id }, (res) => {
    if (res?.ok) {
      rowEl.remove();
      const remaining = reviewItems.querySelectorAll(".review-item").length;
      reviewBadge.textContent = remaining;
      if (remaining === 0) reviewSection.style.display = "none";
      appendLog(`✓ Approved and uploaded photo.`);
    } else {
      btnApprove.disabled = false;
      btnReject.disabled = false;
      btnApprove.textContent = "✅";
      appendLog("✗ Approve failed: " + (res?.error || "Unknown error"));
    }
  });
}

function handleReject(id, rowEl, btnApprove, btnReject) {
  btnApprove.disabled = true;
  btnReject.disabled = true;
  chrome.runtime.sendMessage({ type: "REVIEW_REJECT", id }, (res) => {
    if (res?.ok) {
      rowEl.remove();
      const remaining = reviewItems.querySelectorAll(".review-item").length;
      reviewBadge.textContent = remaining;
      if (remaining === 0) reviewSection.style.display = "none";
    } else {
      btnApprove.disabled = false;
      btnReject.disabled = false;
      appendLog("✗ Reject failed: " + (res?.error || "Unknown error"));
    }
  });
}

// Load review queue on popup open
loadReviewQueue();

/* ------------------------------------------------------------------ */
/*  Settings link                                                      */
/* ------------------------------------------------------------------ */

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
