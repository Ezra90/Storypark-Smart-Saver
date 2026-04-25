/**
 * dashboard-tools.js — Tools Tab UI Module
 * 
 * ┌─ WHAT THIS FILE OWNS ─┐
 * │ • Link/Unlink folder (File System Access API)              │
 * │ • Sync & Status tab UI (storage target, telemetry, DB info)│
 * │ • Post-Processing tab buttons (face filter, EXIF, artifacts)│
 * │ • Activity log display                                     │
 * │ • Naming conventions (folder/file templates)               │
 * └─────────────────────────────────────────────────────────────┘
 */

import { linkFolder, getLinkedFolder, clearLinkedFolder, reconcileWithCache } from "./lib/disk-sync.js";
import { deleteActivityLogFromDisk, flushActivityLogToDisk, ACTIVITY_LOG_FILENAME } from "./lib/log-manager.js";

let _activityLogFollowing = true;

export function initToolsTab(helpers) {
  const { send, toast } = helpers;

  // Sync & Status tab elements
  const $btnLinkFolder = document.getElementById("btnLinkFolder");
  const $btnVerifyDirectory = document.getElementById("btnVerifyDirectory");
  const $btnUnlinkFolder = document.getElementById("btnUnlinkFolder");
  const $btnReconcileFolder = document.getElementById("btnReconcileFolder");
  const $syncFolderPath = document.getElementById("syncFolderPath");
  const $syncStatusDot = document.getElementById("syncStatusDot");
  const $syncStatusText = document.getElementById("syncStatusText");
  const $linkedFolderStatus = document.getElementById("linkedFolderStatus");
  const $linkedFolderInfo = document.getElementById("linkedFolderInfo");
  const $activeDatabasePanel = document.getElementById("activeDatabasePanel");

  const $telTotalStories = document.getElementById("telTotalStories");
  const $telMediaCount = document.getElementById("telMediaCount");
  const $telFaceApproved = document.getElementById("telFaceApproved");
  const $telPending = document.getElementById("telPending");
  const $btnRefreshDbInfo = document.getElementById("btnRefreshDbInfo");
  const $btnOpenDbFolderHint = document.getElementById("btnOpenDbFolderHint");

  // Post-Processing tab elements
  const $btnInitFaceFilter = document.getElementById("btnInitFaceFilter");
  const $initFaceFilterStatus = document.getElementById("initFaceFilterStatus");
  const $btnEmbedExif = document.getElementById("btnEmbedExif");
  const $embedExifStatus = document.getElementById("embedExifStatus");
  const $btnGenerateArtifacts = document.getElementById("btnGenerateArtifacts");
  const $generateArtifactsStatus = document.getElementById("generateArtifactsStatus");

  // Activity Log tab elements
  const $activityLogBox = document.getElementById("activityLogBox");
  const $btnClearLog = document.getElementById("btnClearLog");
  const $btnDeleteLogFile = document.getElementById("btnDeleteLogFile");
  const $btnExportLog = document.getElementById("btnExportLog");
  const $btnFollowActivityLog = document.getElementById("btnFollowActivityLog");
  const $logFilePath = document.getElementById("logFilePath");
  const $logTabInfo = document.getElementById("logTabInfo");

  // Naming conventions (Settings tab)
  const $folderTemplate = document.getElementById("folderTemplate");
  const $fileTemplate = document.getElementById("fileTemplate");
  const $btnApplyTemplate = document.getElementById("btnApplyTemplate");
  const $applyTemplateStatus = document.getElementById("applyTemplateStatus");

  // Link folder
  $btnLinkFolder?.addEventListener("click", async () => {
    try {
      const handle = await linkFolder();
      if (handle) {
        updateFolderStatus();
        toast("✓ Folder linked", "success");
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        toast(`❌ ${e.message}`, "error");
      }
    }
  });

  $btnVerifyDirectory?.addEventListener("click", async () => {
    $btnVerifyDirectory.disabled = true;
    $btnVerifyDirectory.textContent = "⏳ Verifying…";
    try {
      await reconcileWithCache();
      toast("✓ Directory verified", "success");
    } catch (e) {
      toast(`❌ ${e.message}`, "error");
    }
    $btnVerifyDirectory.disabled = false;
    $btnVerifyDirectory.textContent = "✅ Verify Directory";
  });

  $btnUnlinkFolder?.addEventListener("click", async () => {
    if (!confirm("⚠ Unlink the download folder? You can re-link it later.")) return;
    await clearLinkedFolder();
    updateFolderStatus();
    toast("✓ Folder unlinked", "success");
  });

  $btnReconcileFolder?.addEventListener("click", async () => {
    $btnReconcileFolder.disabled = true;
    $btnReconcileFolder.textContent = "⏳ Reconciling…";
    try {
      await reconcileWithCache();
      toast("✓ Files verified", "success");
      updateDbInfo();
    } catch (e) {
      toast(`❌ ${e.message}`, "error");
    }
    $btnReconcileFolder.disabled = false;
    $btnReconcileFolder.textContent = "🔍 Verify Files on Disk";
  });

  async function updateFolderStatus() {
    const handle = await getLinkedFolder();
    if (handle) {
      if ($syncFolderPath) {
        $syncFolderPath.textContent = handle.name;
        $syncFolderPath.classList.add("linked");
      }
      if ($syncStatusDot) $syncStatusDot.className = "dot green";
      if ($syncStatusText) $syncStatusText.textContent = "Linked";
      if ($btnLinkFolder) $btnLinkFolder.style.display = "none";
      if ($btnVerifyDirectory) $btnVerifyDirectory.disabled = false;
      if ($btnUnlinkFolder) $btnUnlinkFolder.style.display = "";
      if ($btnReconcileFolder) $btnReconcileFolder.style.display = "";
      if ($btnInitFaceFilter) $btnInitFaceFilter.disabled = false;
      if ($btnEmbedExif) $btnEmbedExif.disabled = false;
      if ($btnGenerateArtifacts) $btnGenerateArtifacts.disabled = false;
      if ($btnApplyTemplate) $btnApplyTemplate.disabled = false;
      updateDbInfo();
    } else {
      if ($syncFolderPath) {
        $syncFolderPath.textContent = "No folder linked. Click Link Folder to get started.";
        $syncFolderPath.classList.remove("linked");
      }
      if ($syncStatusDot) $syncStatusDot.className = "dot";
      if ($syncStatusText) $syncStatusText.textContent = "Not linked";
      if ($btnLinkFolder) $btnLinkFolder.style.display = "";
      if ($btnVerifyDirectory) $btnVerifyDirectory.disabled = true;
      if ($btnUnlinkFolder) $btnUnlinkFolder.style.display = "none";
      if ($btnReconcileFolder) $btnReconcileFolder.style.display = "none";
      if ($btnInitFaceFilter) $btnInitFaceFilter.disabled = true;
      if ($btnEmbedExif) $btnEmbedExif.disabled = true;
      if ($btnGenerateArtifacts) $btnGenerateArtifacts.disabled = true;
      if ($btnApplyTemplate) $btnApplyTemplate.disabled = true;
      if ($activeDatabasePanel) {
        $activeDatabasePanel.innerHTML = '<em>Link a folder to see database info…</em>';
      }
    }
  }

  async function updateDbInfo() {
    const res = await send({ type: "GET_DB_INFO" });
    if (!res?.ok) return;

    if ($telTotalStories) $telTotalStories.textContent = res.totalStories ?? "—";
    if ($telMediaCount) $telMediaCount.textContent = res.mediaCount ?? "—";
    if ($telFaceApproved) $telFaceApproved.textContent = res.faceApproved ?? "—";
    if ($telPending) $telPending.textContent = res.pending ?? "—";

    if ($activeDatabasePanel) {
      const handle = await getLinkedFolder();
      const folderName = handle?.name || "Unknown";
      $activeDatabasePanel.innerHTML = `
        <div style="margin-bottom:8px;"><strong>📂 Linked Folder:</strong> ${folderName}</div>
        <div style="margin-bottom:8px;"><strong>📊 Total Stories:</strong> ${res.totalStories ?? 0}</div>
        <div style="margin-bottom:8px;"><strong>📸 Media Files:</strong> ${res.mediaCount ?? 0}</div>
        <div style="margin-bottom:8px;"><strong>✅ Face Approved:</strong> ${res.faceApproved ?? 0}</div>
        <div><strong>👀 Pending Review:</strong> ${res.pending ?? 0}</div>
      `;
    }
  }

  $btnRefreshDbInfo?.addEventListener("click", () => updateDbInfo());

  $btnOpenDbFolderHint?.addEventListener("click", async () => {
    const handle = await getLinkedFolder();
    if (!handle) {
      toast("No folder linked", "error");
      return;
    }
    const path = `${handle.name}/Database/`;
    navigator.clipboard.writeText(path);
    toast(`✓ Copied: ${path}`, "success");
  });

  // Post-Processing buttons
  $btnInitFaceFilter?.addEventListener("click", async () => {
    $btnInitFaceFilter.disabled = true;
    $btnInitFaceFilter.textContent = "⏳ Running…";
    if ($initFaceFilterStatus) $initFaceFilterStatus.textContent = "Starting offline face filter…";

    const res = await send({ type: "INIT_FACE_FILTER" });

    $btnInitFaceFilter.disabled = false;
    $btnInitFaceFilter.textContent = "🧠 Initialize Face Filter";

    if (res?.ok) {
      if ($initFaceFilterStatus) $initFaceFilterStatus.textContent = `✅ Processed ${res.processed} photos`;
      toast("✓ Face filter complete", "success");
    } else {
      if ($initFaceFilterStatus) $initFaceFilterStatus.textContent = "❌ " + (res?.error || "Failed");
      toast("❌ Face filter failed", "error");
    }
  });

  $btnEmbedExif?.addEventListener("click", async () => {
    $btnEmbedExif.disabled = true;
    $btnEmbedExif.textContent = "⏳ Embedding…";
    if ($embedExifStatus) $embedExifStatus.textContent = "Writing EXIF metadata…";

    const res = await send({ type: "EMBED_EXIF_ALL" });

    $btnEmbedExif.disabled = false;
    $btnEmbedExif.textContent = "🏷️ Embed EXIF";

    if (res?.ok) {
      if ($embedExifStatus) $embedExifStatus.textContent = `✅ Updated ${res.updated} files`;
      toast("✓ EXIF metadata embedded", "success");
    } else {
      if ($embedExifStatus) $embedExifStatus.textContent = "❌ " + (res?.error || "Failed");
      toast("❌ EXIF embed failed", "error");
    }
  });

  $btnGenerateArtifacts?.addEventListener("click", async () => {
    $btnGenerateArtifacts.disabled = true;
    $btnGenerateArtifacts.textContent = "⏳ Generating…";
    if ($generateArtifactsStatus) $generateArtifactsStatus.textContent = "Building HTML pages and Story Cards…";

    const res = await send({ type: "REBUILD_HTML_ALL" });

    $btnGenerateArtifacts.disabled = false;
    $btnGenerateArtifacts.textContent = "🗂️ Generate HTML / Cards";

    if (res?.ok) {
      if ($generateArtifactsStatus) $generateArtifactsStatus.textContent = `✅ Generated ${res.count} story pages`;
      toast("✓ Artifacts generated", "success");
    } else {
      if ($generateArtifactsStatus) $generateArtifactsStatus.textContent = "❌ " + (res?.error || "Failed");
      toast("❌ Generation failed", "error");
    }
  });

  // Activity log
  function _isAtBottom(el) {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 15;
  }

  $activityLogBox?.addEventListener("scroll", () => {
    _activityLogFollowing = _isAtBottom($activityLogBox);
    if ($btnFollowActivityLog) {
      $btnFollowActivityLog.style.display = _activityLogFollowing ? "none" : "flex";
    }
  });

  $btnFollowActivityLog?.addEventListener("click", () => {
    _activityLogFollowing = true;
    if ($activityLogBox) $activityLogBox.scrollTop = $activityLogBox.scrollHeight;
    if ($btnFollowActivityLog) $btnFollowActivityLog.style.display = "none";
  });

  async function loadActivityLog() {
    const res = await send({ type: "GET_ACTIVITY_LOG" });
    if (!res?.ok || !$activityLogBox) return;

    $activityLogBox.innerHTML = "";
    const entries = res.entries || [];
    if (entries.length === 0) {
      const p = document.createElement("p");
      p.className = "level-INFO";
      p.textContent = "No activity yet.";
      $activityLogBox.appendChild(p);
      return;
    }

    for (const entry of entries.slice(-200)) {
      const p = document.createElement("p");
      p.className = `level-${entry.level || "INFO"}`;
      const time = new Date(entry.timestamp).toLocaleTimeString();
      p.textContent = `[${time}] ${entry.message}`;
      $activityLogBox.appendChild(p);
    }

    if (_activityLogFollowing) {
      $activityLogBox.scrollTop = $activityLogBox.scrollHeight;
    }

    if ($logFilePath && $logTabInfo) {
      const handle = await getLinkedFolder();
      if (handle) {
        $logFilePath.textContent = `${handle.name}/Database/${ACTIVITY_LOG_FILENAME}`;
        $logTabInfo.style.display = "block";
      }
    }
  }

  $btnClearLog?.addEventListener("click", async () => {
    const res = await send({ type: "CLEAR_ACTIVITY_LOG" });
    if (res?.ok) {
      toast("✓ In-app log cleared", "success");
      loadActivityLog();
    } else {
      toast("❌ Failed to clear log", "error");
    }
  });

  $btnDeleteLogFile?.addEventListener("click", async () => {
    if (!confirm("⚠ Delete the activity log file from disk? This cannot be undone.")) return;
    try {
      await deleteActivityLogFromDisk();
      toast("✓ Log file deleted", "success");
      loadActivityLog();
    } catch (e) {
      toast(`❌ ${e.message}`, "error");
    }
  });

  $btnExportLog?.addEventListener("click", async () => {
    const res = await send({ type: "GET_ACTIVITY_LOG" });
    if (!res?.ok || !res.entries || res.entries.length === 0) {
      toast("No log data to export", "error");
      return;
    }

    const blob = new Blob([JSON.stringify(res.entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `activity_log_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✓ Exported ${res.entries.length} entries`, "success");
  });

  // Naming conventions
  chrome.storage.local.get(["folderTemplate", "fileTemplate"], (data) => {
    if ($folderTemplate) $folderTemplate.value = data.folderTemplate || "[ChildName]/Stories/[Date] - [Title]";
    if ($fileTemplate) $fileTemplate.value = data.fileTemplate || "[Date]_[ChildName]_[Class]_[OriginalName]";
  });

  $btnApplyTemplate?.addEventListener("click", async () => {
    const folderTemplate = $folderTemplate?.value || "";
    const fileTemplate = $fileTemplate?.value || "";

    if (!folderTemplate || !fileTemplate) {
      toast("Both templates are required", "error");
      return;
    }

    chrome.storage.local.set({ folderTemplate, fileTemplate });

    $btnApplyTemplate.disabled = true;
    $btnApplyTemplate.textContent = "⏳ Applying…";
    if ($applyTemplateStatus) $applyTemplateStatus.textContent = "Renaming files…";

    const res = await send({ type: "APPLY_NAMING_TEMPLATE", folderTemplate, fileTemplate });

    $btnApplyTemplate.disabled = false;
    $btnApplyTemplate.textContent = "🔄 Retroactively Apply Template to Existing Files";

    if (res?.ok) {
      if ($applyTemplateStatus) $applyTemplateStatus.textContent = `✅ Renamed ${res.renamed} files`;
      toast(`✓ Template applied — ${res.renamed} files renamed`, "success");
    } else {
      if ($applyTemplateStatus) $applyTemplateStatus.textContent = "❌ " + (res?.error || "Failed");
      toast("❌ Template application failed", "error");
    }
  });

  // Export for central dashboard
  window._loadActivityLog = loadActivityLog;
  window._updateFolderStatus = updateFolderStatus;

  // Initial load
  updateFolderStatus();
  updateDbInfo();
}

export function loadActivityLog() {
  if (window._loadActivityLog) {
    window._loadActivityLog();
  }
}
