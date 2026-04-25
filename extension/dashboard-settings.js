/**
 * dashboard-settings.js — Settings Tab UI Module
 * 
 * ┌─ WHAT THIS FILE OWNS ─┐
 * │ • Face training (upload photos)                            │
 * │ • Auto/Min threshold sliders                               │
 * │ • Centre locations (GPS)                                   │
 * │ • Download settings checkboxes                             │
 * │ • Children list display                                    │
 * │ • Debug capture mode                                       │
 * │ • Export/Import profile                                    │
 * └─────────────────────────────────────────────────────────────┘
 */

import { loadModels, detectFaces } from "./lib/face.js";
import { sanitizeName } from "./lib/metadata-helpers.js";
import { getDescriptors, setDescriptors, MAX_DESCRIPTORS_PER_CHILD } from "./lib/db.js";

const humanAvailable = typeof Human !== "undefined";

let _settingsInited = false;

export function initSettingsTab(helpers) {
  if (_settingsInited) return;
  _settingsInited = true;

  const { send, toast } = helpers;

  // DOM references
  const $trainingChildSel = document.getElementById("trainingChildSelect");
  const $trainingFileInput = document.getElementById("trainingFileInput");
  const $trainingPreviews = document.getElementById("trainingPreviews");
  const $trainingStatus = document.getElementById("trainingStatus");
  const $trainingProgress = document.getElementById("trainingProgress");
  const $btnSaveTraining = document.getElementById("btnSaveTraining");
  const $btnResetFaceData = document.getElementById("btnResetFaceData");
  const $btnExportProfile = document.getElementById("btnExportProfile");
  const $btnImportProfile = document.getElementById("btnImportProfile");
  const $importProfileInput = document.getElementById("importProfileInput");
  const $phaseIndicator = document.getElementById("phaseIndicator");

  const $autoThresholdRange = document.getElementById("autoThresholdRange");
  const $autoThresholdNumber = document.getElementById("autoThresholdNumber");
  const $minThresholdRange = document.getElementById("minThresholdRange");
  const $minThresholdNumber = document.getElementById("minThresholdNumber");
  const $btnSaveSettings = document.getElementById("btnSaveSettings");

  const $centreList = document.getElementById("centreList");
  const $btnAddCentre = document.getElementById("btnAddCentre");
  const $btnDiscoverCentres = document.getElementById("btnDiscoverCentres");
  const $btnSaveLocations = document.getElementById("btnSaveLocations");

  const $childrenListSettings = document.getElementById("childrenListSettings");
  const $btnRefreshChildren = document.getElementById("btnRefreshChildren");

  const $chkSkipFaceRec = document.getElementById("chkSkipFaceRec");
  const $chkAttendanceFilter = document.getElementById("chkAttendanceFilter");
  const $chkFillGapsOnly = document.getElementById("chkFillGapsOnly");
  const $chkSaveStoryHtml = document.getElementById("chkSaveStoryHtml");
  const $chkSaveStoryCard = document.getElementById("chkSaveStoryCard");
  const $chkKeepScenarioPhotos = document.getElementById("chkKeepScenarioPhotos");
  const $chkDownloadVideos = document.getElementById("chkDownloadVideos");
  const $skipFaceWarning = document.getElementById("skipFaceWarning");

  const $chkDebugCaptureMode = document.getElementById("chkDebugCaptureMode");
  const $btnDownloadDebugLog = document.getElementById("btnDownloadDebugLog");
  const $btnClearDebugLog = document.getElementById("btnClearDebugLog");
  const $debugLogStatus = document.getElementById("debugLogStatus");

  const $humanWarning = document.getElementById("humanWarning");
  const $btnGenerateStoryCardsAll = document.getElementById("btnGenerateStoryCardsAll");
  const $storyCardsStatus = document.getElementById("storyCardsStatus");
  const $btnClearAllRejections = document.getElementById("btnClearAllRejections");
  const $clearRejectionsStatus = document.getElementById("clearRejectionsStatus");

  // Show warning if face AI not available
  if (!humanAvailable && $humanWarning) {
    $humanWarning.style.display = "block";
  }

  // Threshold sliders sync
  $autoThresholdRange?.addEventListener("input", () => {
    if ($autoThresholdNumber) $autoThresholdNumber.value = $autoThresholdRange.value;
  });
  $autoThresholdNumber?.addEventListener("input", () => {
    if ($autoThresholdRange) $autoThresholdRange.value = $autoThresholdNumber.value;
  });
  $minThresholdRange?.addEventListener("input", () => {
    if ($minThresholdNumber) $minThresholdNumber.value = $minThresholdRange.value;
  });
  $minThresholdNumber?.addEventListener("input", () => {
    if ($minThresholdRange) $minThresholdRange.value = $minThresholdNumber.value;
  });

  // Load threshold values
  chrome.storage.local.get(["autoThreshold", "minThreshold"], (data) => {
    if ($autoThresholdRange) $autoThresholdRange.value = data.autoThreshold ?? 85;
    if ($autoThresholdNumber) $autoThresholdNumber.value = data.autoThreshold ?? 85;
    if ($minThresholdRange) $minThresholdRange.value = data.minThreshold ?? 50;
    if ($minThresholdNumber) $minThresholdNumber.value = data.minThreshold ?? 50;
  });

  // Save thresholds + locations
  $btnSaveSettings?.addEventListener("click", () => {
    const autoThreshold = parseInt($autoThresholdNumber?.value || "85");
    const minThreshold = parseInt($minThresholdNumber?.value || "50");
    chrome.storage.local.set({ autoThreshold, minThreshold });
    saveCentreLocations();
    toast("✓ Settings saved", "success");
  });

  // Download settings checkboxes - auto-save on change
  const checkboxes = [
    $chkSkipFaceRec, $chkAttendanceFilter, $chkFillGapsOnly,
    $chkSaveStoryHtml, $chkSaveStoryCard, $chkKeepScenarioPhotos, $chkDownloadVideos
  ];
  
  chrome.storage.local.get([
    "skipFaceRecognition", "attendanceFilter", "fillGapsOnly",
    "saveStoryHtml", "saveStoryCard", "keepScenarioPhotos", "downloadVideos"
  ], (data) => {
    if ($chkSkipFaceRec) $chkSkipFaceRec.checked = data.skipFaceRecognition ?? false;
    if ($chkAttendanceFilter) $chkAttendanceFilter.checked = data.attendanceFilter ?? false;
    if ($chkFillGapsOnly) $chkFillGapsOnly.checked = data.fillGapsOnly ?? false;
    if ($chkSaveStoryHtml) $chkSaveStoryHtml.checked = data.saveStoryHtml ?? true;
    if ($chkSaveStoryCard) $chkSaveStoryCard.checked = data.saveStoryCard ?? true;
    if ($chkKeepScenarioPhotos) $chkKeepScenarioPhotos.checked = data.keepScenarioPhotos ?? false;
    if ($chkDownloadVideos) $chkDownloadVideos.checked = data.downloadVideos ?? false;
    updateSkipFaceWarning();
  });

  function updateSkipFaceWarning() {
    if ($skipFaceWarning) {
      $skipFaceWarning.style.display = $chkSkipFaceRec?.checked ? "block" : "none";
    }
  }

  $chkSkipFaceRec?.addEventListener("change", () => {
    chrome.storage.local.set({ skipFaceRecognition: $chkSkipFaceRec.checked });
    updateSkipFaceWarning();
  });
  $chkAttendanceFilter?.addEventListener("change", () => {
    chrome.storage.local.set({ attendanceFilter: $chkAttendanceFilter.checked });
  });
  $chkFillGapsOnly?.addEventListener("change", () => {
    chrome.storage.local.set({ fillGapsOnly: $chkFillGapsOnly.checked });
  });
  $chkSaveStoryHtml?.addEventListener("change", () => {
    chrome.storage.local.set({ saveStoryHtml: $chkSaveStoryHtml.checked });
  });
  $chkSaveStoryCard?.addEventListener("change", () => {
    chrome.storage.local.set({ saveStoryCard: $chkSaveStoryCard.checked });
  });
  $chkKeepScenarioPhotos?.addEventListener("change", () => {
    chrome.storage.local.set({ keepScenarioPhotos: $chkKeepScenarioPhotos.checked });
  });
  $chkDownloadVideos?.addEventListener("change", () => {
    chrome.storage.local.set({ downloadVideos: $chkDownloadVideos.checked });
  });

  // Centre locations
  let centreData = [];

  function renderCentres() {
    if (!$centreList) return;
    $centreList.innerHTML = "";
    for (let i = 0; i < centreData.length; i++) {
      const c = centreData[i];
      const row = document.createElement("div");
      row.className = "centre-row";
      row.innerHTML = `
        <div class="centre-field centre-name-field">
          <label>Centre Name</label>
          <input type="text" value="${c.name || ""}" data-idx="${i}" data-field="name">
        </div>
        <div class="centre-field centre-maps-field">
          <label>Google Maps URL</label>
          <input type="text" value="${c.mapsUrl || ""}" placeholder="https://maps.google.com/..." data-idx="${i}" data-field="mapsUrl">
        </div>
        <button class="btn-remove-centre" data-idx="${i}">✕</button>
      `;
      $centreList.appendChild(row);
    }
    $centreList.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("input", (e) => {
        const idx = parseInt(e.target.dataset.idx);
        const field = e.target.dataset.field;
        centreData[idx][field] = e.target.value;
      });
    });
    $centreList.querySelectorAll(".btn-remove-centre").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.target.dataset.idx);
        centreData.splice(idx, 1);
        renderCentres();
      });
    });
  }

  function loadCentreLocations() {
    chrome.storage.local.get("centreLocations", (data) => {
      centreData = data.centreLocations || [];
      renderCentres();
    });
  }

  function saveCentreLocations() {
    chrome.storage.local.set({ centreLocations: centreData });
  }

  $btnAddCentre?.addEventListener("click", () => {
    centreData.push({ name: "", mapsUrl: "" });
    renderCentres();
  });

  $btnDiscoverCentres?.addEventListener("click", async () => {
    if ($btnDiscoverCentres) {
      $btnDiscoverCentres.disabled = true;
      $btnDiscoverCentres.textContent = "⏳ Discovering…";
    }
    const res = await send({ type: "DISCOVER_CENTRES" });
    if ($btnDiscoverCentres) {
      $btnDiscoverCentres.disabled = false;
      $btnDiscoverCentres.textContent = "🔍 Discover from Storypark";
    }
    if (res?.ok) {
      centreData = res.centres || [];
      renderCentres();
      toast(`✓ Found ${centreData.length} centres`, "success");
    } else {
      toast("❌ Discovery failed", "error");
    }
  });

  $btnSaveLocations?.addEventListener("click", () => {
    saveCentreLocations();
    toast("✓ Locations saved", "success");
  });

  // Face training
  let pendingFiles = [];

  async function updatePhaseIndicator() {
    if (!$trainingChildSel || !$phaseIndicator) return;
    const childId = $trainingChildSel.value;
    if (!childId) {
      $phaseIndicator.style.display = "none";
      return;
    }
    const res = await send({ type: "GET_CHILD_PHASE", childId });
    if (res?.ok) {
      const p = res.phase;
      $phaseIndicator.style.display = "block";
      $phaseIndicator.className = `phase-indicator phase-${p.phase}`;
      const labels = {
        1: `🔍 Phase 1: Discovery (${p.verifiedCount}/10)`,
        2: `✅ Phase 2: Validation (${p.verifiedCount}/50)`,
        3: `📊 Phase 3: Confident (${p.verifiedCount}/100)`,
        4: `🚀 Phase 4: Production (${p.verifiedCount}+ verified)`
      };
      $phaseIndicator.textContent = labels[p.phase] || "";
    }
  }

  $trainingChildSel?.addEventListener("change", async () => {
    const childId = $trainingChildSel.value;
    if (!childId) {
      if ($trainingStatus) $trainingStatus.textContent = "";
      if ($trainingPreviews) $trainingPreviews.innerHTML = "";
      if ($btnSaveTraining) $btnSaveTraining.disabled = true;
      pendingFiles = [];
      updatePhaseIndicator();
      return;
    }
    const rec = await getDescriptors(childId);
    const count = rec?.descriptors?.length || 0;
    if ($trainingStatus) {
      $trainingStatus.textContent = `📚 ${count} face descriptor${count !== 1 ? "s" : ""} saved (max ${MAX_DESCRIPTORS_PER_CHILD})`;
    }
    updatePhaseIndicator();
  });

  $trainingFileInput?.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (!humanAvailable) {
      toast("Face models not available", "error");
      return;
    }
    try {
      await loadModels();
    } catch (err) {
      toast(`❌ Face models failed to load: ${err.message}`, "error");
      return;
    }

    if ($trainingProgress) $trainingProgress.textContent = `⏳ Processing ${files.length} file${files.length !== 1 ? "s" : ""}…`;
    if ($btnSaveTraining) $btnSaveTraining.disabled = true;

    for (const file of files) {
      try {
        const dataUrl = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });

        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = dataUrl;
        });

        const faces = await detectFaces(img);
        if (faces.length === 0) {
          toast(`⚠ No face found in ${file.name}`, "error", 3000);
          continue;
        }

        const face = faces[0];
        if (!face.embedding) {
          toast(`⚠ Could not extract face from ${file.name}`, "error", 3000);
          continue;
        }

        pendingFiles.push({ descriptor: Array.from(face.embedding), filename: file.name });

        const wrapper = document.createElement("div");
        wrapper.className = "training-card-wrapper";
        wrapper.style.cssText = "position:relative;display:inline-block;";
        const imgEl = document.createElement("img");
        imgEl.src = dataUrl;
        imgEl.style.cssText = "width:120px;height:120px;object-fit:cover;border-radius:8px;border:2px solid var(--success);";
        wrapper.appendChild(imgEl);
        const btnRm = document.createElement("button");
        btnRm.className = "btn-remove-training";
        btnRm.textContent = "✕";
        btnRm.addEventListener("click", () => {
          const idx = pendingFiles.findIndex(f => f.filename === file.name);
          if (idx !== -1) pendingFiles.splice(idx, 1);
          wrapper.remove();
          if ($btnSaveTraining) $btnSaveTraining.disabled = pendingFiles.length === 0;
        });
        wrapper.appendChild(btnRm);
        $trainingPreviews?.appendChild(wrapper);
      } catch (err) {
        toast(`❌ Error processing ${file.name}: ${err.message}`, "error", 3000);
      }
    }

    if ($trainingProgress) $trainingProgress.textContent = `✓ ${pendingFiles.length} face${pendingFiles.length !== 1 ? "s" : ""} extracted — click Save to store`;
    if ($btnSaveTraining) $btnSaveTraining.disabled = pendingFiles.length === 0;
    e.target.value = "";
  });

  $btnSaveTraining?.addEventListener("click", async () => {
    const childId = $trainingChildSel?.value;
    const childName = $trainingChildSel?.options[$trainingChildSel.selectedIndex]?.text || "";
    if (!childId || pendingFiles.length === 0) return;

    $btnSaveTraining.disabled = true;
    $btnSaveTraining.textContent = "⏳ Saving…";

    const year = new Date().getFullYear().toString();
    for (const f of pendingFiles) {
      await send({ type: "APPEND_DESCRIPTOR", childId, childName, descriptor: f.descriptor, year });
    }

    pendingFiles = [];
    if ($trainingPreviews) $trainingPreviews.innerHTML = "";
    if ($trainingProgress) $trainingProgress.textContent = "";
    $btnSaveTraining.textContent = "💾 Save training photos";
    toast("✓ Training data saved", "success");

    const rec = await getDescriptors(childId);
    const count = rec?.descriptors?.length || 0;
    if ($trainingStatus) {
      $trainingStatus.textContent = `📚 ${count} face descriptor${count !== 1 ? "s" : ""} saved (max ${MAX_DESCRIPTORS_PER_CHILD})`;
    }
    updatePhaseIndicator();
  });

  $btnExportProfile?.addEventListener("click", async () => {
    const childId = $trainingChildSel?.value;
    const childName = $trainingChildSel?.options[$trainingChildSel.selectedIndex]?.text || "";
    if (!childId) { toast("Select a child first", "error"); return; }

    const rec = await getDescriptors(childId);
    if (!rec || !rec.descriptors || rec.descriptors.length === 0) {
      toast("No training data to export", "error");
      return;
    }

    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeName(childName)}_profile.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("✓ Profile exported", "success");
  });

  $btnImportProfile?.addEventListener("click", () => {
    $importProfileInput?.click();
  });

  $importProfileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const childId = $trainingChildSel?.value;
    if (!childId) {
      toast("Select a child first", "error");
      e.target.value = "";
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.descriptors || !Array.isArray(data.descriptors)) {
        throw new Error("Invalid profile format");
      }

      await setDescriptors(childId, data.descriptors, data.yearBuckets || {});
      toast(`✓ Imported ${data.descriptors.length} descriptors`, "success");

      const rec = await getDescriptors(childId);
      const count = rec?.descriptors?.length || 0;
      if ($trainingStatus) {
        $trainingStatus.textContent = `📚 ${count} face descriptor${count !== 1 ? "s" : ""} saved (max ${MAX_DESCRIPTORS_PER_CHILD})`;
      }
      updatePhaseIndicator();
    } catch (err) {
      toast(`❌ Import failed: ${err.message}`, "error");
    }
    e.target.value = "";
  });

  $btnResetFaceData?.addEventListener("click", async () => {
    const childId = $trainingChildSel?.value;
    if (!childId) return;
    if (!confirm("⚠ Delete all face training data for this child? This cannot be undone.")) return;

    await setDescriptors(childId, [], {});
    pendingFiles = [];
    if ($trainingPreviews) $trainingPreviews.innerHTML = "";
    if ($trainingStatus) $trainingStatus.textContent = "📚 0 face descriptors saved";
    if ($trainingProgress) $trainingProgress.textContent = "";
    toast("✓ Face data reset", "success");
    updatePhaseIndicator();
  });

  // Rebuild pages & cards
  $btnGenerateStoryCardsAll?.addEventListener("click", async () => {
    $btnGenerateStoryCardsAll.disabled = true;
    $btnGenerateStoryCardsAll.textContent = "⏳ Rebuilding…";
    if ($storyCardsStatus) $storyCardsStatus.textContent = "";

    const res = await send({ type: "REBUILD_HTML_ALL" });

    $btnGenerateStoryCardsAll.disabled = false;
    $btnGenerateStoryCardsAll.textContent = "🔄 Rebuild Pages & Cards";

    if (res?.ok) {
      if ($storyCardsStatus) $storyCardsStatus.textContent = `✅ Rebuilt ${res.count} story pages`;
      toast("✓ All story pages rebuilt", "success");
    } else {
      if ($storyCardsStatus) $storyCardsStatus.textContent = "❌ " + (res?.error || "Rebuild failed");
      toast("❌ Rebuild failed", "error");
    }
  });

  // Clear rejections
  $btnClearAllRejections?.addEventListener("click", async () => {
    if (!confirm("⚠ Clear all rejected image records? Previously-rejected photos will be re-evaluated on the next scan.")) return;
    $btnClearAllRejections.disabled = true;
    $btnClearAllRejections.textContent = "⏳ Clearing…";

    const res = await send({ type: "CLEAR_ALL_REJECTIONS" });

    $btnClearAllRejections.disabled = false;
    $btnClearAllRejections.textContent = "🔄 Reset All Rejected Images";

    if (res?.ok) {
      if ($clearRejectionsStatus) $clearRejectionsStatus.textContent = `✅ Cleared ${res.count} rejection records`;
      toast(`✓ ${res.count} rejections cleared`, "success");
    } else {
      if ($clearRejectionsStatus) $clearRejectionsStatus.textContent = "❌ " + (res?.error || "Failed");
      toast("❌ Failed to clear rejections", "error");
    }
  });

  // Debug capture mode
  chrome.storage.local.get("debugCaptureMode", (data) => {
    if ($chkDebugCaptureMode) $chkDebugCaptureMode.checked = data.debugCaptureMode ?? false;
  });

  $chkDebugCaptureMode?.addEventListener("change", () => {
    const enabled = $chkDebugCaptureMode.checked;
    chrome.storage.local.set({ debugCaptureMode: enabled });
    send({ type: "SET_DEBUG_CAPTURE", enabled });
  });

  $btnDownloadDebugLog?.addEventListener("click", async () => {
    const res = await send({ type: "GET_DEBUG_LOG" });
    if (!res?.ok || !res.log || res.log.length === 0) {
      toast("No debug log data", "error");
      return;
    }

    const blob = new Blob([JSON.stringify(res.log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `debug_log_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✓ Downloaded ${res.log.length} entries`, "success");
  });

  $btnClearDebugLog?.addEventListener("click", async () => {
    const res = await send({ type: "CLEAR_DEBUG_LOG" });
    if (res?.ok) {
      if ($debugLogStatus) $debugLogStatus.textContent = "✓ Debug log cleared";
      toast("✓ Debug log cleared", "success");
    } else {
      toast("❌ Failed to clear log", "error");
    }
  });

  // Export function for refreshing children lists
  window._loadSettingsChildren = loadSettingsChildren;

  function loadSettingsChildren() {
    send({ type: "GET_CHILDREN" }).then(res => {
      if (!res?.ok) return;
      const children = res.children || [];

      // Training child selector
      if ($trainingChildSel) {
        const selected = $trainingChildSel.value;
        $trainingChildSel.innerHTML = '<option value="">— select a child —</option>';
        for (const c of children) {
          const o = document.createElement("option");
          o.value = c.id;
          o.textContent = c.name;
          $trainingChildSel.appendChild(o);
        }
        if (selected) $trainingChildSel.value = selected;
      }

      // Children list display
      if ($childrenListSettings) {
        if (children.length === 0) {
          $childrenListSettings.innerHTML = '<p style="color:var(--muted);font-size:13px;">No children found — refresh your profile.</p>';
        } else {
          $childrenListSettings.innerHTML = "";
          for (const c of children) {
            const row = document.createElement("div");
            row.style.cssText = "padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;";
            row.textContent = `👶 ${c.name}`;
            $childrenListSettings.appendChild(row);
          }
        }
      }
    });
  }

  $btnRefreshChildren?.addEventListener("click", async () => {
    $btnRefreshChildren.disabled = true;
    $btnRefreshChildren.textContent = "⏳ Refreshing…";
    await send({ type: "REFRESH_PROFILE" });
    loadSettingsChildren();
    $btnRefreshChildren.disabled = false;
    $btnRefreshChildren.textContent = "↻ Refresh from Storypark";
    toast("✓ Children refreshed", "success");
  });

  // Initial loads
  loadCentreLocations();
  loadSettingsChildren();
  updatePhaseIndicator();
}

export function loadSettingsChildren() {
  if (window._loadSettingsChildren) {
    window._loadSettingsChildren();
  }
}
