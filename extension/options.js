/**
 * options.js – Settings page logic for the Storypark Photo Sync extension.
 *
 * Manages:
 *  - Children names + reference face photo uploads
 *  - Daycare name, GPS coordinates
 *  - Face Recognition Strictness (maps to autoThreshold / minThreshold internally)
 *  - Google Photos album selection / creation
 *  - Face Training Data (manual upload with live match %, import from album)
 *  - Persists everything to chrome.storage.local
 */

import { loadModels, buildEncoding, computeMatchPercent } from "./lib/face.js";

/* ------------------------------------------------------------------ */
/*  Element references                                                 */
/* ------------------------------------------------------------------ */

const childrenList      = document.getElementById("childrenList");
const btnAddChild       = document.getElementById("btnAddChild");
const daycareNameInput  = document.getElementById("daycareName");
const latInput          = document.getElementById("lat");
const lonInput          = document.getElementById("lon");
const albumSelect       = document.getElementById("albumSelect");
const albumRefresh      = document.getElementById("albumRefresh");
const newAlbumName      = document.getElementById("newAlbumName");
const btnCreateAlbum    = document.getElementById("btnCreateAlbum");
const btnSave           = document.getElementById("btnSave");
const toast             = document.getElementById("toast");
const faceApiWarning    = document.getElementById("faceApiWarning");
const autoSyncEnabled   = document.getElementById("autoSyncEnabled");
const autoSyncFrequency = document.getElementById("autoSyncFrequency");

const faceStrictnessSelect = document.getElementById("faceStrictness");

/** Map strictness dropdown value → { autoThreshold, minThreshold } */
const STRICTNESS_MAP = {
  strict: { autoThreshold: 90, minThreshold: 60 },
  normal: { autoThreshold: 85, minThreshold: 50 },
  loose:  { autoThreshold: 70, minThreshold: 30 },
};

/**
 * Infer the closest strictness level from stored numeric thresholds.
 * Ranges are intentionally slightly wider than the exact STRICTNESS_MAP
 * values to handle settings saved by older versions of the extension.
 */
function thresholdsToStrictness(auto, min) {
  if (auto >= 90 && min >= 60) return "strict";
  if (auto >= 70 && min >= 30) return "normal";
  return "loose";
}

const trainingChildSelect   = document.getElementById("trainingChildSelect");
const trainingFileInput     = document.getElementById("trainingFileInput");
const trainingPreviews      = document.getElementById("trainingPreviews");
const btnSaveTraining       = document.getElementById("btnSaveTraining");
const trainingAlbumSelect   = document.getElementById("trainingAlbumSelect");
const trainingAlbumRefresh  = document.getElementById("trainingAlbumRefresh");
const btnImportAlbum        = document.getElementById("btnImportAlbum");
const importStatus          = document.getElementById("importStatus");

/* ------------------------------------------------------------------ */
/*  face-api.js availability check                                     */
/* ------------------------------------------------------------------ */

let faceApiAvailable = false;

(async () => {
  if (window._faceApiMissing || typeof faceapi === "undefined") {
    faceApiWarning.style.display = "block";
    return;
  }
  try {
    await loadModels();
    faceApiAvailable = true;
  } catch (err) {
    console.warn("[options] face-api.js models failed to load:", err.message);
    faceApiWarning.style.display = "block";
    faceApiWarning.textContent =
      `⚠ Face recognition unavailable: ${err.message}`;
  }
})();

/* ------------------------------------------------------------------ */
/*  Children UI                                                        */
/* ------------------------------------------------------------------ */

let childRows = []; // { nameInput, fileInput, albumSelect, encodingIdx }

function syncTrainingChildDropdown() {
  const current = trainingChildSelect.value;
  trainingChildSelect.innerHTML = '<option value="">— select a child —</option>';
  for (const row of childRows) {
    const name = row.nameInput.value.trim();
    if (!name) continue;
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    trainingChildSelect.appendChild(opt);
  }
  if (current) trainingChildSelect.value = current;
}

function renderChildren(children) {
  childrenList.innerHTML = "";
  childRows = [];
  children.forEach((child, idx) =>
    addChildRow(child.name, idx, child.albumId || "")
  );
  syncTrainingChildDropdown();
}

function addChildRow(name = "", encodingIdx = null, savedAlbumId = "") {
  const row = document.createElement("div");
  row.className = "child-row";

  // Main row: name + file + remove button
  const rowMain = document.createElement("div");
  rowMain.className = "child-row-main";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Child's name";
  nameInput.value = name;
  nameInput.addEventListener("input", syncTrainingChildDropdown);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.title = "Upload reference face photo";

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove child";
  removeBtn.addEventListener("click", () => {
    row.remove();
    const idx = childRows.indexOf(entry);
    if (idx !== -1) childRows.splice(idx, 1);
    syncTrainingChildDropdown();
  });

  rowMain.appendChild(nameInput);
  rowMain.appendChild(fileInput);
  rowMain.appendChild(removeBtn);
  row.appendChild(rowMain);

  // Album sub-row: per-child Google Photos album selector
  const albumRow = document.createElement("div");
  albumRow.className = "child-album-row";

  const albumLabel = document.createElement("label");
  albumLabel.textContent = "Google Photos Album:";

  const childAlbumSelect = document.createElement("select");
  childAlbumSelect.className = "child-album-select";
  // Placeholder option; will be populated by loadAlbums()
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None (use default album)";
  childAlbumSelect.appendChild(noneOpt);
  // Remember the saved value so it can be restored after albums load
  childAlbumSelect.dataset.savedAlbumId = savedAlbumId;

  albumRow.appendChild(albumLabel);
  albumRow.appendChild(childAlbumSelect);
  row.appendChild(albumRow);

  childrenList.appendChild(row);

  const entry = { nameInput, fileInput, albumSelect: childAlbumSelect, encodingIdx };
  childRows.push(entry);
  return entry;
}

btnAddChild.addEventListener("click", () => {
  addChildRow();
  syncTrainingChildDropdown();
});

/* ------------------------------------------------------------------ */
/*  Album management (upload target)                                   */
/* ------------------------------------------------------------------ */

function populateAlbumSelect(select, albums, savedId) {
  select.innerHTML = '<option value="">None (main library)</option>';
  for (const album of albums) {
    const opt = document.createElement("option");
    opt.value = album.id;
    opt.textContent = album.title || album.id;
    select.appendChild(opt);
  }
  if (savedId) select.value = savedId;
}

/** Populate all per-child album selects, restoring each child's saved albumId. */
function populateChildAlbumSelects(albums) {
  for (const row of childRows) {
    const saved = row.albumSelect.dataset.savedAlbumId || "";
    // Preserve the "None" option header text for child rows
    row.albumSelect.innerHTML = '<option value="">None (use default album)</option>';
    for (const album of albums) {
      const opt = document.createElement("option");
      opt.value = album.id;
      opt.textContent = album.title || album.id;
      row.albumSelect.appendChild(opt);
    }
    if (saved) row.albumSelect.value = saved;
  }
}

function loadAlbums() {
  albumSelect.disabled = true;
  chrome.runtime.sendMessage({ type: "LIST_ALBUMS" }, (res) => {
    albumSelect.disabled = false;
    if (res?.ok && res.albums) {
      chrome.storage.local.get("albumId", ({ albumId }) => {
        populateAlbumSelect(albumSelect, res.albums, albumId);
      });
      // Populate training album dropdown
      populateAlbumSelect(trainingAlbumSelect, res.albums, "");
      trainingAlbumSelect.dispatchEvent(new Event("change"));
      // Populate per-child album selects
      populateChildAlbumSelects(res.albums);
    }
  });
}

albumRefresh.addEventListener("click", loadAlbums);

btnCreateAlbum.addEventListener("click", () => {
  const title = newAlbumName.value.trim();
  if (!title) return;
  btnCreateAlbum.disabled = true;
  chrome.runtime.sendMessage({ type: "CREATE_ALBUM", title }, (res) => {
    btnCreateAlbum.disabled = false;
    if (res?.ok && res.album) {
      const opt = document.createElement("option");
      opt.value = res.album.id;
      opt.textContent = res.album.title;
      albumSelect.appendChild(opt);
      albumSelect.value = res.album.id;
      newAlbumName.value = "";
    } else {
      alert("Failed to create album: " + (res?.error || "Unknown error"));
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Face Training – tab switching                                      */
/* ------------------------------------------------------------------ */

document.querySelectorAll(".training-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".training-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".training-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
  });
});

/* ------------------------------------------------------------------ */
/*  Face Training – manual upload with live match preview             */
/* ------------------------------------------------------------------ */

/** Pending training files: [{ file, dataUrl, descriptor: number[]|null, matchPct: number|null }] */
let pendingTrainingFiles = [];

async function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function matchBadgeClass(pct) {
  if (pct === null) return "none";
  if (pct >= 80) return "good";
  if (pct >= 50) return "ok";
  return "bad";
}

function buildPreviewCard(entry, index) {
  const card = document.createElement("div");
  card.className = "match-preview";
  card.dataset.index = index;

  const img = document.createElement("img");
  img.src = entry.dataUrl;
  img.alt = "Training photo";

  const info = document.createElement("div");
  info.style.flex = "1";

  const fileName = document.createElement("div");
  fileName.style.fontSize = "12px";
  fileName.style.fontWeight = "600";
  fileName.textContent = entry.file.name;

  const badge = document.createElement("span");
  badge.className = "match-badge";
  if (!faceApiAvailable) {
    badge.textContent = "Models unavailable";
    badge.className += " none";
  } else if (entry.descriptor === null && entry.matchPct === null) {
    badge.textContent = "No face detected";
    badge.className += " bad";
  } else if (entry.matchPct !== null) {
    badge.textContent = `Match: ${entry.matchPct}%`;
    badge.className += ` ${matchBadgeClass(entry.matchPct)}`;
  } else {
    // First photo – no comparison yet
    badge.textContent = "Face detected ✓";
    badge.className += " good";
  }

  info.appendChild(fileName);
  info.appendChild(badge);
  card.appendChild(img);
  card.appendChild(info);
  return card;
}

function renderTrainingPreviews() {
  trainingPreviews.innerHTML = "";
  for (let i = 0; i < pendingTrainingFiles.length; i++) {
    trainingPreviews.appendChild(buildPreviewCard(pendingTrainingFiles[i], i));
  }
  btnSaveTraining.disabled = pendingTrainingFiles.length === 0;
}

trainingFileInput.addEventListener("change", async () => {
  const files = Array.from(trainingFileInput.files).slice(0, 10);
  pendingTrainingFiles = [];
  renderTrainingPreviews(); // show immediately while loading

  // Get existing descriptors for this child (for comparison)
  const childName = trainingChildSelect.value;
  let existingDescriptors = [];
  if (childName) {
    const { childEncodings = [] } = await chrome.storage.local.get("childEncodings");
    const found = childEncodings.find((c) => c.name === childName);
    if (found?.allDescriptors) existingDescriptors = found.allDescriptors;
    else if (found?.descriptor) existingDescriptors = [found.descriptor];
  }

  for (const file of files) {
    const dataUrl = await readFileAsDataURL(file);
    const entry = { file, dataUrl, descriptor: null, matchPct: null };
    pendingTrainingFiles.push(entry);

    if (faceApiAvailable) {
      try {
        const img = await fileToImage(file);
        const descriptor = await buildEncoding(img);
        entry.descriptor = descriptor ? Array.from(descriptor) : null;

        if (descriptor) {
          const allDescriptors = [
            ...existingDescriptors,
            ...pendingTrainingFiles
              .slice(0, pendingTrainingFiles.indexOf(entry))
              .filter((e) => e.descriptor)
              .map((e) => e.descriptor),
          ];
          const { matchPct } = await computeMatchPercent(img, allDescriptors);
          entry.matchPct = matchPct;
        }
      } catch (err) {
        console.warn("[options] face encoding error:", err.message);
      }
    }
  }

  renderTrainingPreviews();
});

btnSaveTraining.addEventListener("click", async () => {
  const childName = trainingChildSelect.value;
  if (!childName) {
    alert("Please select a child first.");
    return;
  }
  const valid = pendingTrainingFiles.filter((e) => e.descriptor !== null);
  if (valid.length === 0) {
    alert("No valid face photos detected. Please choose clearer photos.");
    return;
  }

  btnSaveTraining.disabled = true;
  btnSaveTraining.textContent = "Saving…";

  const { childEncodings = [] } = await chrome.storage.local.get("childEncodings");
  const filtered = childEncodings.filter((c) => c.name !== childName);
  filtered.push({
    name: childName,
    descriptor: valid[0].descriptor, // primary descriptor
    allDescriptors: valid.map((e) => e.descriptor),
  });
  await chrome.storage.local.set({ childEncodings: filtered });

  btnSaveTraining.disabled = false;
  btnSaveTraining.textContent = "💾 Save training photos";
  pendingTrainingFiles = [];
  renderTrainingPreviews();
  showToast(`✓ Saved ${valid.length} training photo(s) for ${childName}`);
});

/* ------------------------------------------------------------------ */
/*  Face Training – import from Google Photos album                   */
/* ------------------------------------------------------------------ */

trainingAlbumRefresh.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "LIST_ALBUMS" }, (res) => {
    if (res?.ok && res.albums) {
      populateAlbumSelect(trainingAlbumSelect, res.albums, "");
    }
  });
});

trainingAlbumSelect.addEventListener("change", () => {
  btnImportAlbum.disabled = !trainingAlbumSelect.value;
});

btnImportAlbum.addEventListener("click", () => {
  const albumId = trainingAlbumSelect.value;
  const childName = trainingChildSelect.value;
  if (!albumId) { alert("Please select an album."); return; }
  if (!childName) { alert("Please select a child first."); return; }

  btnImportAlbum.disabled = true;
  importStatus.textContent = "Importing…";

  chrome.runtime.sendMessage(
    { type: "IMPORT_TRAINING_ALBUM", albumId, childName },
    (res) => {
      btnImportAlbum.disabled = false;
      if (res?.ok) {
        importStatus.textContent =
          `✓ Imported ${res.count} face descriptor(s) for ${childName}.`;
      } else {
        importStatus.textContent =
          "✗ Import failed: " + (res?.error || "Unknown error");
      }
    }
  );
});

/* ------------------------------------------------------------------ */
/*  Save all settings                                                  */
/* ------------------------------------------------------------------ */

function showToast(msg = "✓ Settings saved!") {
  toast.textContent = msg;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 2500);
}

btnSave.addEventListener("click", async () => {
  btnSave.disabled = true;
  btnSave.textContent = "Saving…";

  // Collect children
  const children = [];
  const childEncodings = [];

  for (const row of childRows) {
    const name = row.nameInput.value.trim();
    if (!name) continue;

    // Per-child album ID (empty string = use global default)
    const childAlbumId = row.albumSelect.value || "";

    const childData = { name, albumId: childAlbumId };

    if (row.fileInput.files.length > 0) {
      const dataUrl = await readFileAsDataURL(row.fileInput.files[0]);
      childData.referencePhoto = dataUrl;
      childEncodings.push({
        name,
        albumId: childAlbumId,
        referencePhoto: dataUrl,
        descriptor: null, // computed lazily by offscreen doc or training section
      });
    } else {
      // Preserve existing encoding, but update albumId
      const { childEncodings: existing = [] } =
        await chrome.storage.local.get("childEncodings");
      const prev = existing.find((c) => c.name === name);
      if (prev) {
        childEncodings.push({ ...prev, albumId: childAlbumId });
      }
    }

    children.push(childData);
  }

  // Validate GPS
  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);
  const validLat = !isNaN(lat) && lat >= -90  && lat <= 90;
  const validLon = !isNaN(lon) && lon >= -180 && lon <= 180;

  if (latInput.value && !validLat) {
    alert("Latitude must be between -90 and 90.");
    btnSave.disabled = false;
    btnSave.textContent = "💾 Save Settings";
    return;
  }
  if (lonInput.value && !validLon) {
    alert("Longitude must be between -180 and 180.");
    btnSave.disabled = false;
    btnSave.textContent = "💾 Save Settings";
    return;
  }

  // Validate thresholds from strictness dropdown
  const strictness = faceStrictnessSelect.value;
  const { autoThreshold, minThreshold } = STRICTNESS_MAP[strictness] || STRICTNESS_MAP.normal;

  await chrome.storage.local.set({
    children,
    childEncodings,
    daycareName: daycareNameInput.value.trim(),
    daycareLat: validLat ? lat : null,
    daycareLon: validLon ? lon : null,
    albumId: albumSelect.value || "",
    autoThreshold,
    minThreshold,
  });

  // Persist auto-sync settings and notify background to reconfigure alarm
  const syncEnabled = autoSyncEnabled.checked;
  const syncFrequency = autoSyncFrequency.value;
  chrome.runtime.sendMessage(
    { type: "SET_AUTO_SYNC", enabled: syncEnabled, frequency: syncFrequency },
    (res) => {
      if (res && !res.ok) {
        console.warn("[options] Auto-sync alarm setup failed:", res.error);
        showToast("⚠ Settings saved, but auto-sync alarm setup failed.");
      }
    }
  );

  btnSave.disabled = false;
  btnSave.textContent = "💾 Save Settings";
  showToast();
});

/* ------------------------------------------------------------------ */
/*  Load saved settings on page open                                   */
/* ------------------------------------------------------------------ */

(async function init() {
  const data = await chrome.storage.local.get([
    "children",
    "daycareName",
    "daycareLat",
    "daycareLon",
    "albumId",
    "autoThreshold",
    "minThreshold",
    "autoSyncEnabled",
    "autoSyncFrequency",
  ]);

  // Children (restored with per-child albumId via renderChildren → addChildRow)
  const children = data.children || [];
  if (children.length > 0) {
    renderChildren(children);
  } else {
    addChildRow();
    syncTrainingChildDropdown();
  }

  // Daycare name
  if (data.daycareName) daycareNameInput.value = data.daycareName;

  // GPS
  if (data.daycareLat != null) latInput.value = data.daycareLat;
  if (data.daycareLon != null) lonInput.value = data.daycareLon;

  // Thresholds → strictness dropdown
  if (data.autoThreshold != null || data.minThreshold != null) {
    const auto = data.autoThreshold ?? 85;
    const min  = data.minThreshold  ?? 50;
    faceStrictnessSelect.value = thresholdsToStrictness(auto, min);
  }

  // Auto-sync
  autoSyncEnabled.checked = data.autoSyncEnabled === true;
  if (data.autoSyncFrequency) autoSyncFrequency.value = data.autoSyncFrequency;

  // Albums (also populates per-child album selects after fetch)
  loadAlbums();
})();
