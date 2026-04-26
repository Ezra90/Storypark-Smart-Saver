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

import { linkFolder, getLinkedFolder, clearLinkedFolder, reconcileWithCache, syncDiskToDatabase, walkFolder } from "./lib/disk-sync.js";
import { deleteActivityLogFromDisk, flushActivityLogToDisk, ACTIVITY_LOG_FILENAME } from "./lib/log-manager.js";
import { getAllDownloadedStories, addDownloadedStory, recordFileMovement } from "./lib/db.js";

let _activityLogFollowing = true;

export function initToolsTab(helpers) {
  const { send, toast } = helpers;
  const _pushFloatingProgress = (label, current, total, eta = "") => {
    if (window._scanUpdateProgress) {
      window._scanUpdateProgress({
        childName: label,
        current: Math.max(0, Number(current) || 0),
        total: Math.max(1, Number(total) || 1),
        date: "",
        eta,
      });
    }
  };
  const _finishFloatingProgress = () => {
    if (window._scanComplete) window._scanComplete();
  };

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
  const $btnPostStop = document.getElementById("btnPostStop");
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
  const $renamerChildSelect = document.getElementById("renamerChildSelect");
  const $renamerTemplate = document.getElementById("renamerTemplate");
  const $btnPreviewRename = document.getElementById("btnPreviewRename");
  const $btnApplyRename = document.getElementById("btnApplyRename");
  const $renamerPreview = document.getElementById("renamerPreview");
  const $renamerProgress = document.getElementById("renamerProgress");
  const $renamerProgressText = document.getElementById("renamerProgressText");
  const $renamerProgressBar = document.getElementById("renamerProgressBar");
  const $renamerReport = document.getElementById("renamerReport");
  const $namingConventionsCard = document.getElementById("namingConventionsCard");
  const $renamerCard = document.getElementById("renamerCard");

  function insertAtCursor($input, text) {
    if (!$input || text == null || text === "") return;
    const el = $input;
    const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
    const v = el.value;
    el.value = `${v.slice(0, start)}${text}${v.slice(end)}`;
    el.focus();
    const pos = start + String(text).length;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* ignore */
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  $namingConventionsCard?.addEventListener("click", (e) => {
    const chip = e.target.closest(".naming-template-chip");
    if (!chip || !$namingConventionsCard.contains(chip)) return;
    const target = chip.getAttribute("data-token-target");
    const token = chip.textContent.trim();
    const inp = target === "file" ? $fileTemplate : $folderTemplate;
    insertAtCursor(inp, token);
  });

  $renamerCard?.addEventListener("click", (e) => {
    const chip = e.target.closest(".renamer-token-chip");
    if (!chip || !$renamerCard.contains(chip)) return;
    const ins = chip.getAttribute("data-renamer-insert");
    if (ins) insertAtCursor($renamerTemplate, ins);
  });

  // Link folder
  $btnLinkFolder?.addEventListener("click", async () => {
    try {
      const handle = await linkFolder();
      if (handle) {
        updateFolderStatus();
        toast("✓ Storypark working directory set", "success");
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        toast(`❌ ${e.message}`, "error");
      }
    }
  });

  $btnVerifyDirectory?.addEventListener("click", async () => {
    const handle = await getLinkedFolder();
    if (!handle) {
      toast("Set a working directory first", "error");
      return;
    }
    _pushFloatingProgress("Verifying Directory (metadata scan)", 0, 1);
    await send({ type: "LOG_TO_ACTIVITY", level: "INFO", message: "Sync: Verify Directory started." }).catch(() => {});

    $btnVerifyDirectory.disabled = true;
    $btnVerifyDirectory.textContent = "⏳ Syncing…";
    
    let verified = 0;
    try {
      const result = await syncDiskToDatabase(handle, (processed, total, title) => {
        $btnVerifyDirectory.textContent = `⏳ ${processed} verified…`;
        _pushFloatingProgress("Verifying Directory (metadata scan)", processed, total || processed || 1);
        console.log(`[Verify] ${processed}: ${title}`);
      });
      
      verified = result.verified;
      if (verified > 0) {
        await send({ type: "LOG_TO_ACTIVITY", level: "SUCCESS", message: `Sync: Verify Directory complete (${verified} metadata folders verified).` }).catch(() => {});
        toast(`✓ ${verified} stories verified from metadata folders`, "success");
      } else {
        // Fallback for older/restored installs that don't contain metadata.json
        // in story folders: run the same disk-vs-manifest reconciliation pass.
        const stories = await getAllDownloadedStories();
        _pushFloatingProgress("Verifying Files on Disk (reconcile fallback)", 0, 1);
        const report = await reconcileWithCache(handle, stories);
        _pushFloatingProgress("Verifying Files on Disk (reconcile fallback)", 1, 1);
        await send({
          type: "LOG_TO_ACTIVITY",
          level: report.missing.length > 0 ? "WARNING" : "INFO",
          message: `Sync: Verify Directory fallback (no metadata folders) -> present ${report.present.length}, missing ${report.missing.length}, orphaned ${report.orphaned.length}.`,
        }).catch(() => {});
        toast(
          `ℹ No metadata.json folders found. Fallback ran Verify Files on Disk: ${report.present.length} present, ${report.missing.length} missing, ${report.orphaned.length} orphaned.`,
          report.missing.length > 0 ? "error" : "success",
          9000
        );
      }
      updateDbInfo();
    } catch (e) {
      await send({ type: "LOG_TO_ACTIVITY", level: "ERROR", message: `Sync: Verify Directory failed (${e.message || "Unknown error"}).` }).catch(() => {});
      toast(`❌ ${e.message}`, "error");
    } finally {
      _finishFloatingProgress();
    }
    
    $btnVerifyDirectory.disabled = false;
    $btnVerifyDirectory.textContent = "✅ Verify Directory";
  });

  $btnUnlinkFolder?.addEventListener("click", async () => {
    if (!confirm("⚠ Clear the working directory? You can set it again later.")) return;
    await clearLinkedFolder();
    updateFolderStatus();
    toast("✓ Working directory cleared", "success");
  });

  $btnReconcileFolder?.addEventListener("click", async () => {
    $btnReconcileFolder.disabled = true;
    $btnReconcileFolder.textContent = "⏳ Reconciling…";
    _pushFloatingProgress("Verifying Files on Disk (reconcile pass)", 0, 1);
    await send({ type: "LOG_TO_ACTIVITY", level: "INFO", message: "Sync: Verify Files on Disk started." }).catch(() => {});
    try {
      const handle = await getLinkedFolder();
      if (!handle) throw new Error("Set a working directory first");
      const stories = await getAllDownloadedStories();
      const report = await reconcileWithCache(handle, stories);
      _pushFloatingProgress("Verifying Files on Disk (reconcile pass)", 1, 1);
      await send({
        type: "LOG_TO_ACTIVITY",
        level: report.missing.length > 0 ? "WARNING" : "SUCCESS",
        message: `Sync: Verify Files on Disk complete -> present ${report.present.length}, missing ${report.missing.length}, orphaned ${report.orphaned.length}.`,
      }).catch(() => {});
      toast(
        `✓ Verified: ${report.present.length} present, ${report.missing.length} missing, ${report.orphaned.length} orphaned`,
        report.missing.length > 0 ? "error" : "success",
        5000
      );
      updateDbInfo();
    } catch (e) {
      await send({ type: "LOG_TO_ACTIVITY", level: "ERROR", message: `Sync: Verify Files on Disk failed (${e.message || "Unknown error"}).` }).catch(() => {});
      toast(`❌ ${e.message}`, "error");
    } finally {
      _finishFloatingProgress();
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
      if ($syncStatusText) $syncStatusText.textContent = "Set";
      if ($btnLinkFolder) $btnLinkFolder.style.display = "none";
      if ($btnVerifyDirectory) $btnVerifyDirectory.disabled = false;
      if ($btnUnlinkFolder) $btnUnlinkFolder.style.display = "";
      if ($btnReconcileFolder) $btnReconcileFolder.style.display = "";
      if ($btnInitFaceFilter) $btnInitFaceFilter.disabled = false;
      if ($btnEmbedExif) $btnEmbedExif.disabled = false;
      if ($btnGenerateArtifacts) $btnGenerateArtifacts.disabled = false;
      if ($btnApplyTemplate) $btnApplyTemplate.disabled = false;
      if ($linkedFolderInfo) {
        $linkedFolderInfo.textContent =
          "Set the parent folder that contains the 'Storypark Smart Saver' directory. If you move this folder (for example Desktop -> Downloads), re-link once and tracking resumes from Database files.";
      }
      updateDbInfo();
    } else {
      if ($syncFolderPath) {
        $syncFolderPath.textContent = "No working directory set. Click Set Working Directory to get started.";
        $syncFolderPath.classList.remove("linked");
      }
      if ($syncStatusDot) $syncStatusDot.className = "dot";
      if ($syncStatusText) $syncStatusText.textContent = "Not set";
      if ($btnLinkFolder) $btnLinkFolder.style.display = "";
      if ($btnVerifyDirectory) $btnVerifyDirectory.disabled = true;
      if ($btnUnlinkFolder) $btnUnlinkFolder.style.display = "none";
      if ($btnReconcileFolder) $btnReconcileFolder.style.display = "none";
      if ($btnInitFaceFilter) $btnInitFaceFilter.disabled = true;
      if ($btnEmbedExif) $btnEmbedExif.disabled = true;
      if ($btnGenerateArtifacts) $btnGenerateArtifacts.disabled = true;
      if ($btnApplyTemplate) $btnApplyTemplate.disabled = true;
      if ($linkedFolderInfo) {
        $linkedFolderInfo.textContent =
          "Choose the parent folder where 'Storypark Smart Saver' lives. This lets the app read/write Database files and compare media on disk.";
      }
      if ($activeDatabasePanel) {
        $activeDatabasePanel.innerHTML = '<em>Set a Storypark working directory to see database info…</em>';
      }
    }
  }

  async function updateDbInfo() {
    const { lastSelectedChildId = "__ALL__" } = await chrome.storage.local.get("lastSelectedChildId");
    const childId = lastSelectedChildId && lastSelectedChildId !== "__ALL__" ? lastSelectedChildId : "__ALL__";
    const res = await send({ type: "GET_DB_INFO", childId });
    if (!res?.ok) return;
    const info = res.info || res;

    if ($telTotalStories) $telTotalStories.textContent = info.totalStories ?? "—";
    if ($telMediaCount) $telMediaCount.textContent = info.imageCount ?? info.mediaCount ?? "—";
    if ($telFaceApproved) $telFaceApproved.textContent = info.mediaCount ?? "—";
    if ($telPending) $telPending.textContent = info.pending ?? "—";

    if ($activeDatabasePanel) {
      const handle = await getLinkedFolder();
      const folderName = handle?.name || "Unknown";
      const byChildRows = Array.isArray(info.byChild) && info.byChild.length > 0
        ? info.byChild
            .map((c) => {
              const dedupe = c.daycareDedupeNote ? ` <span style="opacity:0.85">(${c.daycareDedupeNote})</span>` : "";
              return (
                `• ${c.childName || c.childId}: ${c.stories || 0} stories · ${c.images || 0} images · ${c.videos || 0} videos · ${c.media || 0} media · ${c.pending || 0} pending · ${c.daycareLabel || "No daycare data yet"}${dedupe}` +
                ` · missing vs API: ${c.missingVsApi || 0} file(s) [images ${c.missingImagesVsApi || 0}, videos ${c.missingVideosVsApi || 0}] across ${c.storiesNeedingRestore || 0} stor${(c.storiesNeedingRestore || 0) === 1 ? "y" : "ies"}`
              );
            })
            .join("<br>")
        : "No child stats yet";
      $activeDatabasePanel.innerHTML = `
        <div style="margin-bottom:8px;"><strong>📂 Working Directory:</strong> ${folderName}</div>
        <div style="margin-bottom:8px;"><strong>👶 Scope:</strong> ${info.childId && info.childId !== "__ALL__" ? "Selected child" : "All children"}</div>
        <div style="margin-bottom:8px;"><strong>📊 Total Stories:</strong> ${info.totalStories ?? 0}</div>
        <div style="margin-bottom:8px;"><strong>🖼️ Total Images (no cards/html):</strong> ${info.imageCount ?? 0}</div>
        <div style="margin-bottom:8px;"><strong>🎥 Total Videos:</strong> ${info.videoCount ?? 0}</div>
        <div style="margin-bottom:8px;"><strong>📸 Total Media (no html/cards):</strong> ${info.mediaCount ?? 0}</div>
        <div style="margin-bottom:8px;"><strong>🧩 Missing vs API expected:</strong> ${info.missingVsApi ?? 0} file(s) [images ${info.missingImagesVsApi ?? 0}, videos ${info.missingVideosVsApi ?? 0}] across ${info.storiesNeedingRestore ?? 0} stor${(info.storiesNeedingRestore ?? 0) === 1 ? "y" : "ies"}</div>
        <div style="margin-bottom:8px;"><strong>👀 Pending Facial Match Review:</strong> ${info.pending ?? 0}</div>
        <div><strong>Per Child:</strong><br>${byChildRows}</div>
      `;
    }
  }

  $btnRefreshDbInfo?.addEventListener("click", () => updateDbInfo());

  $btnOpenDbFolderHint?.addEventListener("click", async () => {
    const handle = await getLinkedFolder();
    if (!handle) {
      toast("No working directory set", "error");
      return;
    }
    const path = `${handle.name}/Database/`;
    navigator.clipboard.writeText(path);
    toast(`✓ Copied: ${path}`, "success");
  });

  // Post-Processing buttons
  $btnInitFaceFilter?.addEventListener("click", async () => {
    await send({ type: "LOG_TO_ACTIVITY", level: "INFO", message: "Post-Processing: Initialize Face Filter started." }).catch(() => {});
    const { lastSelectedChildId = "__ALL__" } = await chrome.storage.local.get("lastSelectedChildId");
    const childId = lastSelectedChildId && lastSelectedChildId !== "__ALL__" ? lastSelectedChildId : "";
    if (!childId) {
      toast("Select a child first for Face Filter", "error");
      return;
    }
    $btnInitFaceFilter.disabled = true;
    $btnInitFaceFilter.textContent = "⏳ Running…";
    if ($btnPostStop) $btnPostStop.style.display = "inline-flex";
    if ($initFaceFilterStatus) $initFaceFilterStatus.textContent = "Starting offline face filter…";

    const res = await send({ type: "INIT_FACE_FILTER", childId });

    $btnInitFaceFilter.disabled = false;
    $btnInitFaceFilter.textContent = "🧠 Initialize Face Filter";
    if ($btnPostStop) $btnPostStop.style.display = "none";

    if (res?.ok) {
      if ($initFaceFilterStatus) $initFaceFilterStatus.textContent = `✅ Processed ${res.processed} photos`;
      await send({ type: "LOG_TO_ACTIVITY", level: "SUCCESS", message: `Post-Processing: Face Filter complete (${res.processed || 0} processed).` }).catch(() => {});
      toast("✓ Face filter complete", "success");
    } else {
      if ($initFaceFilterStatus) $initFaceFilterStatus.textContent = "❌ " + (res?.error || "Failed");
      await send({ type: "LOG_TO_ACTIVITY", level: "ERROR", message: `Post-Processing: Face Filter failed (${res?.error || "Unknown error"}).` }).catch(() => {});
      toast("❌ Face filter failed", "error");
    }
  });

  $btnEmbedExif?.addEventListener("click", async () => {
    await send({ type: "LOG_TO_ACTIVITY", level: "INFO", message: "Post-Processing: Embed EXIF started." }).catch(() => {});
    $btnEmbedExif.disabled = true;
    $btnEmbedExif.textContent = "⏳ Embedding…";
    if ($btnPostStop) $btnPostStop.style.display = "inline-flex";
    if ($embedExifStatus) $embedExifStatus.textContent = "Writing EXIF metadata…";

    const res = await send({ type: "EMBED_EXIF_ALL" });

    $btnEmbedExif.disabled = false;
    $btnEmbedExif.textContent = "🏷️ Embed EXIF";
    if ($btnPostStop) $btnPostStop.style.display = "none";

    if (res?.ok) {
      if ($embedExifStatus) $embedExifStatus.textContent = `✅ Updated ${res.updated} files`;
      await send({ type: "LOG_TO_ACTIVITY", level: "SUCCESS", message: `Post-Processing: Embed EXIF complete (${res.updated || 0} updated).` }).catch(() => {});
      toast("✓ EXIF metadata embedded", "success");
    } else {
      if ($embedExifStatus) $embedExifStatus.textContent = "❌ " + (res?.error || "Failed");
      await send({ type: "LOG_TO_ACTIVITY", level: "ERROR", message: `Post-Processing: Embed EXIF failed (${res?.error || "Unknown error"}).` }).catch(() => {});
      toast("❌ EXIF embed failed", "error");
    }
  });

  $btnGenerateArtifacts?.addEventListener("click", async () => {
    await send({ type: "LOG_TO_ACTIVITY", level: "INFO", message: "Post-Processing: Generate HTML / Cards started." }).catch(() => {});
    $btnGenerateArtifacts.disabled = true;
    $btnGenerateArtifacts.textContent = "⏳ Generating…";
    if ($btnPostStop) $btnPostStop.style.display = "inline-flex";
    if ($generateArtifactsStatus) $generateArtifactsStatus.textContent = "Building HTML pages and Story Cards…";

    const res = await send({ type: "REBUILD_HTML_ALL" });

    $btnGenerateArtifacts.disabled = false;
    $btnGenerateArtifacts.textContent = "🗂️ Generate HTML / Cards";
    if ($btnPostStop) $btnPostStop.style.display = "none";

    if (res?.ok) {
      if ($generateArtifactsStatus) $generateArtifactsStatus.textContent = `✅ Generated ${res.count} story pages`;
      await send({ type: "LOG_TO_ACTIVITY", level: "SUCCESS", message: `Post-Processing: Generate HTML / Cards complete (${res.count || 0} stories).` }).catch(() => {});
      toast("✓ Artifacts generated", "success");
    } else {
      if ($generateArtifactsStatus) $generateArtifactsStatus.textContent = "❌ " + (res?.error || "Failed");
      await send({ type: "LOG_TO_ACTIVITY", level: "ERROR", message: `Post-Processing: Generate HTML / Cards failed (${res?.error || "Unknown error"}).` }).catch(() => {});
      toast("❌ Generation failed", "error");
    }
  });

  $btnPostStop?.addEventListener("click", async () => {
    await send({ type: "CANCEL_SCAN" }).catch(() => {});
    await send({ type: "LOG_TO_ACTIVITY", level: "WARNING", message: "Post-Processing: stop requested by user." }).catch(() => {});
    if ($initFaceFilterStatus && $initFaceFilterStatus.textContent.includes("⏳")) $initFaceFilterStatus.textContent = "⏸ Stop requested…";
    if ($embedExifStatus && $embedExifStatus.textContent.includes("⏳")) $embedExifStatus.textContent = "⏸ Stop requested…";
    if ($generateArtifactsStatus && $generateArtifactsStatus.textContent.includes("⏳")) $generateArtifactsStatus.textContent = "⏸ Stop requested…";
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
    const entries = res.entries || res.activityLog || [];
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
      const handle = await getLinkedFolder();
      if (!handle) {
        toast("Set your working directory first", "error");
        return;
      }
      await deleteActivityLogFromDisk(handle);
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
    send({ type: "LOG_TO_ACTIVITY", level: "INFO", message: "Starting filename template apply (analyse + rename)." }).catch(() => {});

    const res = await send({ type: "APPLY_NAMING_TEMPLATE", folderTemplate, fileTemplate });

    $btnApplyTemplate.disabled = false;
    $btnApplyTemplate.textContent = "🔄 Retroactively Apply Template to Existing Files";

    if (res?.ok) {
      if ($applyTemplateStatus) $applyTemplateStatus.textContent = `✅ Renamed ${res.renamed} files`;
      send({ type: "LOG_TO_ACTIVITY", level: "SUCCESS", message: `Filename template apply complete: ${res.renamed} files renamed.` }).catch(() => {});
      toast(`✓ Template applied — ${res.renamed} files renamed`, "success");
    } else {
      if ($applyTemplateStatus) $applyTemplateStatus.textContent = "❌ " + (res?.error || "Failed");
      send({ type: "LOG_TO_ACTIVITY", level: "ERROR", message: `Filename template apply failed: ${res?.error || "Unknown error"}` }).catch(() => {});
      toast("❌ Template application failed", "error");
    }
  });

  // -----------------------------
  // Mass file renamer (preview/apply)
  // -----------------------------
  function _safeName(v) {
    return String(v || "").replace(/[/\\:*?"<>|]/g, "_").trim();
  }

  function _isStoryMediaFilename(name) {
    const n = String(name || "").toLowerCase();
    if (!n) return false;
    if (n === "story.html" || n === "story_card.jpg" || n === "story_card.jpeg") return false;
    return /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?|mp4|mov|m4v|avi|webm|mkv)$/i.test(n);
  }

  function _renderRenameTemplate(tmpl, data) {
    const centre = _safeName(data.centreName || "");
    const educator = _safeName(data.educatorName || "");
    const child = _safeName(data.childName || "");
    const room = _safeName(data.roomName || "");
    const storyDate = data.storyDate || "";
    const storyTitle = _safeName(data.storyTitle || "");
    const map = {
      "{OriginalName}": data.originalName || "",
      "{OriginalBase}": data.originalBase || "",
      "{CentreName}": centre,
      "{EducatorName}": educator,
      "{StoryTitle}": storyTitle,
      "{StoryDate}": storyDate,
      "{ChildName}": child,
      "{Educator}": educator,
      "{Daycare}": centre,
      "{Centre}": centre,
      "{Title}": storyTitle,
      "{Date}": storyDate,
      "{Room}": room,
      "{Class}": room,
      "{Child}": child,
      "{Ext}": data.ext || "",
    };
    let out = String(tmpl || "{StoryDate}_{ChildName}_{Room}_{OriginalName}");
    const pairs = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
    for (const [k, v] of pairs) out = out.split(k).join(v);
    out = out.replace(/__+/g, "_").replace(/\s+/g, " ").trim();
    return _safeName(out) || data.originalName;
  }

  async function _resolveDir(root, relPath) {
    const parts = String(relPath || "").split("/").filter(Boolean);
    let cur = root;
    for (const p of parts) {
      cur = await cur.getDirectoryHandle(p);
    }
    return cur;
  }

  async function _renameFileInDir(dirHandle, oldName, newName) {
    if (oldName === newName) return true;
    const oldFh = await dirHandle.getFileHandle(oldName);
    const file = await oldFh.getFile();
    const newFh = await dirHandle.getFileHandle(newName, { create: true });
    const w = await newFh.createWritable();
    await w.write(await file.arrayBuffer());
    await w.close();
    await dirHandle.removeEntry(oldName);
    return true;
  }

  async function _buildRenamePlan(childId, template) {
    const all = await getAllDownloadedStories();
    const manifests = all.filter((m) => String(m.childId) === String(childId));
    const plan = [];
    for (const m of manifests) {
      const files = Array.isArray(m.approvedFilenames) ? m.approvedFilenames : [];
      const used = new Set(files);
      for (const oldName of files) {
        const dot = oldName.lastIndexOf(".");
        const base = dot > 0 ? oldName.slice(0, dot) : oldName;
        const ext = dot > 0 ? oldName.slice(dot + 1) : "";
        let newName = _renderRenameTemplate(template, {
          storyDate: m.storyDate || "",
          storyTitle: m.storyTitle || m.title || "",
          childName: m.childName || "",
          roomName: m.roomName || "",
          centreName: m.centreName || "",
          educatorName: m.educatorName || "",
          originalName: oldName,
          originalBase: base,
          ext,
        });
        if (ext && !newName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
          newName = `${newName}.${ext}`;
        }
        let candidate = newName;
        let n = 2;
        while (candidate !== oldName && used.has(candidate)) {
          const b = candidate.replace(/\.[^.]+$/, "");
          const e = candidate.includes(".") ? candidate.slice(candidate.lastIndexOf(".")) : "";
          candidate = `${b}_${n}${e}`;
          n++;
        }
        newName = candidate;
        used.add(newName);
        if (newName !== oldName) {
          plan.push({ manifest: m, oldName, newName });
        }
      }
    }
    return plan;
  }

  async function _loadRenamerChildren() {
    if (!$renamerChildSelect) return;
    const res = await send({ type: "GET_CHILDREN" });
    const children = res?.children || [];
    $renamerChildSelect.innerHTML = '<option value="">— select a child —</option>';
    for (const c of children) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      $renamerChildSelect.appendChild(o);
    }
  }

  $renamerChildSelect?.addEventListener("change", () => {
    const ok = Boolean($renamerChildSelect.value && $renamerTemplate?.value);
    if ($btnPreviewRename) $btnPreviewRename.disabled = !ok;
    if ($btnApplyRename) $btnApplyRename.disabled = true;
  });

  $renamerTemplate?.addEventListener("input", () => {
    const ok = Boolean($renamerChildSelect?.value && $renamerTemplate?.value);
    if ($btnPreviewRename) $btnPreviewRename.disabled = !ok;
    if ($btnApplyRename) $btnApplyRename.disabled = true;
  });

  $btnPreviewRename?.addEventListener("click", async () => {
    const childId = $renamerChildSelect?.value;
    if (!childId) return;
    const template = $renamerTemplate?.value || "{StoryDate}_{ChildName}_{Room}_{OriginalName}";
    const plan = await _buildRenamePlan(childId, template);
    if ($renamerPreview) {
      const first = plan.slice(0, 30).map((p) => `${p.oldName} → ${p.newName}`).join("\n");
      $renamerPreview.textContent = plan.length
        ? `${plan.length} file rename(s) ready.\n\n${first}${plan.length > 30 ? "\n…more…" : ""}`
        : "No filename changes needed. Everything already matches this template.";
    }
    if ($btnApplyRename) $btnApplyRename.disabled = plan.length === 0;
  });

  $btnApplyRename?.addEventListener("click", async () => {
    const childId = $renamerChildSelect?.value;
    if (!childId) return;
    const root = await getLinkedFolder();
    if (!root) {
      toast("Link your folder first", "error");
      return;
    }
    const template = $renamerTemplate?.value || "{StoryDate}_{ChildName}_{Room}_{OriginalName}";
    const plan = await _buildRenamePlan(childId, template);
    if (plan.length === 0) {
      toast("No filename changes needed", "success");
      return;
    }
    if ($renamerProgress) $renamerProgress.style.display = "block";
    if ($renamerReport) { $renamerReport.style.display = "block"; $renamerReport.textContent = ""; }
    await send({ type: "LOG_TO_ACTIVITY", level: "INFO", message: `Filename rename started (${plan.length} files).` }).catch(() => {});

    let done = 0, failed = 0;
    const touchedManifests = [];
    const byManifest = new Map();
    for (const p of plan) {
      const k = `${p.manifest.childId}_${p.manifest.storyId}`;
      if (!byManifest.has(k)) byManifest.set(k, { manifest: p.manifest, items: [] });
      byManifest.get(k).items.push(p);
    }

    for (const { manifest, items } of byManifest.values()) {
      const childSafe = _safeName(manifest.childName || "Unknown");
      const relStoryDir = `${childSafe}/Stories/${manifest.folderName}`;
      let dir;
      try {
        dir = await _resolveDir(root, relStoryDir);
      } catch {
        failed += items.length;
        continue;
      }
      const updated = { ...manifest };
      const renameMap = new Map();
      for (const it of items) {
        try {
          await _renameFileInDir(dir, it.oldName, it.newName);
          renameMap.set(it.oldName, it.newName);
          done++;
          await recordFileMovement({
            type: "rename",
            childId: manifest.childId,
            storyId: manifest.storyId,
            filename: it.newName,
            fromPath: `${relStoryDir}/${it.oldName}`,
            toPath: `${relStoryDir}/${it.newName}`,
            source: "mass_renamer",
          }).catch(() => {});
        } catch {
          failed++;
        }
        if ($renamerProgressBar) {
          $renamerProgressBar.max = plan.length;
          $renamerProgressBar.value = done + failed;
        }
        if ($renamerProgressText) $renamerProgressText.textContent = `${done + failed}/${plan.length} processed…`;
        chrome.runtime.sendMessage({
          type: "PROGRESS",
          current: done + failed,
          total: plan.length,
          childName: "Renaming files",
          date: manifest.storyDate || "",
          eta: "",
        }).catch(() => {});
      }
      const _mapArray = (arr) => (Array.isArray(arr) ? arr.map((f) => renameMap.get(f) || f) : []);
      updated.approvedFilenames = _mapArray(updated.approvedFilenames);
      updated.queuedFilenames = _mapArray(updated.queuedFilenames);
      updated.rejectedFilenames = _mapArray(updated.rejectedFilenames);
      if (updated.thumbnailFilename) updated.thumbnailFilename = renameMap.get(updated.thumbnailFilename) || updated.thumbnailFilename;
      if (Array.isArray(updated.mediaUrls)) {
        updated.mediaUrls = updated.mediaUrls.map((mu) => ({ ...mu, filename: renameMap.get(mu.filename) || mu.filename }));
      }
      await addDownloadedStory(updated).catch(() => {});
      touchedManifests.push(updated);
    }

    // Dry-run verification: immediately check renamed stories for missing refs/count drift/orphans.
    const allDiskPaths = await walkFolder(root).catch(() => []);
    const diskSet = new Set(allDiskPaths);
    const verify = {
      storiesChecked: touchedManifests.length,
      passed: 0,
      failed: 0,
      missingRefs: 0,
      mismatched: 0,
      orphaned: 0,
      details: [],
    };
    for (const m of touchedManifests) {
      const childSafe = _safeName(m.childName || "Unknown");
      const base = `${childSafe}/Stories/${m.folderName}`;
      const expected = (Array.isArray(m.approvedFilenames) ? m.approvedFilenames : []).filter(_isStoryMediaFilename);
      const folderFiles = allDiskPaths
        .filter((p) => p.startsWith(`${base}/`))
        .map((p) => p.slice(base.length + 1))
        .filter(_isStoryMediaFilename);
      const folderFileSet = new Set(folderFiles);
      const missing = expected.filter((f) => !diskSet.has(`${base}/${f}`));
      const orphaned = folderFiles.filter((f) => !expected.includes(f));
      const mismatched = expected.length !== folderFiles.length;

      verify.missingRefs += missing.length;
      verify.orphaned += orphaned.length;
      if (mismatched) verify.mismatched++;
      if (missing.length === 0 && orphaned.length === 0 && !mismatched) {
        verify.passed++;
      } else {
        verify.failed++;
      }
      if (missing.length > 0 || orphaned.length > 0 || mismatched) {
        verify.details.push({
          childName: m.childName || "",
          storyId: m.storyId || "",
          folderName: m.folderName || "",
          missingCount: missing.length,
          orphanedCount: orphaned.length,
          mismatched,
        });
      }
    }

    if ($renamerReport) {
      const detailLines = verify.details
        .slice(0, 20)
        .map((d) => `• ${d.childName} / story ${d.storyId}: missing ${d.missingCount}, orphaned ${d.orphanedCount}${d.mismatched ? ", count mismatch" : ""}`)
        .join("\n");
      $renamerReport.textContent =
        `Rename complete.\nRenamed: ${done}\nFailed: ${failed}\n\n` +
        `Dry-run verification (renamed stories):\n` +
        `Checked: ${verify.storiesChecked}\nPassed: ${verify.passed}\nFailed: ${verify.failed}\n` +
        `Missing refs: ${verify.missingRefs}\nOrphaned files: ${verify.orphaned}\nCount mismatches: ${verify.mismatched}\n` +
        `${detailLines ? `\n${detailLines}\n` : ""}\n` +
        `Next step (manual): run "Generate HTML / Cards" from Post-Processing so story.html and Story Card links match the new filenames.`;
    }
    await send({
      type: "LOG_TO_ACTIVITY",
      level: failed ? "WARNING" : "SUCCESS",
      message:
        `Filename rename completed. Renamed ${done}, failed ${failed}. ` +
        `Dry-run check: ${verify.passed}/${verify.storiesChecked} passed, ` +
        `${verify.failed} failed, missing refs ${verify.missingRefs}, orphaned ${verify.orphaned}, count mismatches ${verify.mismatched}. ` +
        `Please run "Generate HTML / Cards" manually from Post-Processing to refresh story pages and cards.`,
    }).catch(() => {});
    toast(failed ? `Renamed ${done}, failed ${failed}` : `✓ Renamed ${done} files`, failed ? "error" : "success");
  });

  // Export for central dashboard
  window._loadActivityLog = loadActivityLog;
  window._updateFolderStatus = updateFolderStatus;
  window._updateDbInfo = updateDbInfo;

  // Initial load
  updateFolderStatus();
  updateDbInfo();
  loadActivityLog();
  _loadRenamerChildren();
}

export function loadActivityLog() {
  if (window._loadActivityLog) {
    window._loadActivityLog();
  }
}
