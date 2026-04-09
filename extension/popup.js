/**
 * popup.js – Popup UI logic for the Storypark Photo Sync extension.
 *
 * Handles:
 *  - Google connection status indicator
 *  - "Connect to Google" / "Disconnect" toggle
 *  - "Sync Now" button → sends SYNC_NOW to background
 *  - Live progress log fed by runtime messages
 */

const btnConnect = document.getElementById("btnConnect");
const btnSync = document.getElementById("btnSync");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const logBox = document.getElementById("logBox");
const openOptions = document.getElementById("openOptions");

let isConnected = false;
let isSyncing = false;

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
  }
});

// Load persisted log on popup open
chrome.storage.local.get("syncLog", ({ syncLog = [] }) => {
  clearLog();
  const recent = syncLog.slice(-30); // show last 30 entries
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

// Check on popup open
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
      appendLog(
        `✓ Done! Scraped: ${s.scraped}, Uploaded: ${s.uploaded}` +
          (s.quotaHit ? " (quota reached)" : "")
      );
    } else {
      statusDot.className = "dot red";
      statusText.textContent = "Sync failed";
      appendLog("✗ Error: " + (res?.error || "Unknown error"));
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Settings link                                                      */
/* ------------------------------------------------------------------ */

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
