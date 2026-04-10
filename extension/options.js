/**
 * options.js – Settings page for Storypark Smart Saver.
 *
 * Manages:
 *  - Read-only display of children (fetched from Storypark API by background)
 *  - Face recognition strictness (autoThreshold / minThreshold)
 *  - Face training data: manual photo upload with live match preview
 *    Descriptors are saved to IndexedDB via lib/db.js
 */

import { loadModels, detectFaces, matchEmbedding } from "./lib/face.js";
import { getDescriptors } from "./lib/db.js";

/* ================================================================== */
/*  Element refs                                                       */
/* ================================================================== */

const childrenList        = document.getElementById("childrenList");
const btnRefreshChildren  = document.getElementById("btnRefreshChildren");
const autoThresholdRange  = document.getElementById("autoThresholdRange");
const autoThresholdNumber = document.getElementById("autoThresholdNumber");
const minThresholdRange   = document.getElementById("minThresholdRange");
const minThresholdNumber  = document.getElementById("minThresholdNumber");
const centreList           = document.getElementById("centreList");
const btnAddCentre         = document.getElementById("btnAddCentre");
const btnSaveLocations     = document.getElementById("btnSaveLocations");
const trainingChildSelect  = document.getElementById("trainingChildSelect");
const trainingFileInput    = document.getElementById("trainingFileInput");
const trainingPreviews     = document.getElementById("trainingPreviews");
const trainingProgress     = document.getElementById("trainingProgress");
const trainingLoading      = document.getElementById("trainingLoading");
const trainingLoadingBar   = document.getElementById("trainingLoadingBar");
const btnSaveTraining      = document.getElementById("btnSaveTraining");
const btnResetFaceData     = document.getElementById("btnResetFaceData");
const btnSave              = document.getElementById("btnSave");
const toast                = document.getElementById("toast");
const humanWarning         = document.getElementById("humanWarning");

/* ================================================================== */
/*  Threshold sync (slider ↔ number)                                   */
/* ================================================================== */

function clampThreshold(value) {
  return Math.max(0, Math.min(100, parseInt(value, 10) || 0));
}

autoThresholdRange.addEventListener("input", () => {
  autoThresholdNumber.value = autoThresholdRange.value;
});
autoThresholdNumber.addEventListener("input", () => {
  const v = clampThreshold(autoThresholdNumber.value);
  autoThresholdRange.value  = v;
  autoThresholdNumber.value = v;
});

minThresholdRange.addEventListener("input", () => {
  minThresholdNumber.value = minThresholdRange.value;
});
minThresholdNumber.addEventListener("input", () => {
  const v = clampThreshold(minThresholdNumber.value);
  minThresholdRange.value  = v;
  minThresholdNumber.value = v;
});

/* ================================================================== */
/*  Centre Locations (GPS for EXIF)                                    */
/* ================================================================== */

/**
 * In-memory mirror of the persisted centreLocations object.
 * Keys are centre names; values are { lat: number|null, lng: number|null }.
 */
let centreLocationsCache = {};

function buildCentreRow(name, loc) {
  const row = document.createElement("div");
  row.className = "centre-row";

  // Centre name (read-only for API-discovered, editable for manual adds)
  const nameField = document.createElement("div");
  nameField.className = "centre-field centre-name-field";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Centre Name";
  const nameInput = document.createElement("input");
  nameInput.type        = "text";
  nameInput.value       = name;
  nameInput.placeholder = "e.g. Sunshine Childcare";
  nameInput.dataset.originalName = name;
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);

  // Combined Google Maps URL / coordinates field
  const mapsField = document.createElement("div");
  mapsField.className = "centre-field centre-maps-field";
  const mapsLabel = document.createElement("label");
  mapsLabel.textContent = "Google Maps Link or Coordinates";
  const mapsInput = document.createElement("input");
  mapsInput.type        = "text";
  mapsInput.placeholder = "Paste a Maps URL or -27.741, 153.186";
  // Pre-fill with existing coordinates if present
  if (loc.lat != null && loc.lng != null) {
    mapsInput.value = `${loc.lat}, ${loc.lng}`;
  }
  mapsField.appendChild(mapsLabel);
  mapsField.appendChild(mapsInput);

  /**
   * Parse the input value and return {lat, lng} or null.
   * Accepts:
   *   - Google Maps URL containing /@lat,lng
   *   - Plain "lat, lng" coordinates
   */
  function parseCoords(raw) {
    if (!raw) return null;
    // Google Maps URL: extract from /@lat,lng
    const urlMatch = raw.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (urlMatch) {
      return { lat: parseFloat(urlMatch[1]), lng: parseFloat(urlMatch[2]) };
    }
    // Plain coordinates: lat,lng or lat, lng
    const coordMatch = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coordMatch) {
      return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]) };
    }
    return null;
  }

  // Google Maps link (visible when coordinates are set)
  const mapsLink = document.createElement("a");
  mapsLink.style.cssText  = "font-size:12px; white-space:nowrap; align-self:flex-end; padding-bottom:8px;";
  mapsLink.target         = "_blank";
  mapsLink.rel            = "noopener";
  const updateMapsLink = () => {
    const coords = parseCoords(mapsInput.value);
    if (coords) {
      mapsLink.href        = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
      mapsLink.textContent = "📍 View on Map";
      mapsLink.style.display = "";
    } else {
      mapsLink.style.display = "none";
    }
  };
  updateMapsLink();

  // Remove button
  const btnRemove = document.createElement("button");
  btnRemove.className   = "btn-remove-centre";
  btnRemove.textContent = "✕";
  btnRemove.title       = "Remove this centre";
  btnRemove.type        = "button";
  btnRemove.addEventListener("click", () => {
    const key = nameInput.dataset.originalName || nameInput.value;
    delete centreLocationsCache[key];
    row.remove();
  });

  row.appendChild(nameField);
  row.appendChild(mapsField);
  row.appendChild(mapsLink);
  row.appendChild(btnRemove);

  // Keep cache in sync on input changes
  const updateCache = () => {
    const oldKey = nameInput.dataset.originalName;
    const newKey = nameInput.value.trim();
    const coords = parseCoords(mapsInput.value);

    // If a Maps URL was pasted, replace the input value with clean coordinates
    if (coords && (mapsInput.value.includes("maps.google") || mapsInput.value.includes("google.com/maps"))) {
      mapsInput.value = `${coords.lat}, ${coords.lng}`;
    }

    if (oldKey && oldKey !== newKey) {
      delete centreLocationsCache[oldKey];
      nameInput.dataset.originalName = newKey;
    }
    if (newKey) {
      centreLocationsCache[newKey] = {
        lat: coords ? coords.lat : null,
        lng: coords ? coords.lng : null,
      };
    }
    updateMapsLink();
  };
  nameInput.addEventListener("input", updateCache);
  mapsInput.addEventListener("input",  updateCache);
  mapsInput.addEventListener("paste",  () => setTimeout(updateCache, 0));

  return row;
}

function renderCentreList(locations) {
  centreList.innerHTML = "";
  const entries = Object.entries(locations);
  if (entries.length === 0) {
    const p = document.createElement("p");
    p.style.cssText = "font-size:13px;color:var(--muted);margin-bottom:8px;";
    p.textContent   = "No centres discovered yet. Run a scan or refresh your profile to auto-detect centres.";
    centreList.appendChild(p);
    return;
  }
  for (const [name, loc] of entries) {
    centreList.appendChild(buildCentreRow(name, loc));
  }
}

function loadCentreLocations() {
  chrome.storage.local.get("centreLocations", ({ centreLocations = {} }) => {
    centreLocationsCache = centreLocations;
    renderCentreList(centreLocationsCache);
  });
}

btnAddCentre.addEventListener("click", () => {
  // Find a unique default name
  let idx = 1;
  while ((`New Centre ${idx}`) in centreLocationsCache) idx++;
  const name = `New Centre ${idx}`;
  centreLocationsCache[name] = { lat: null, lng: null };
  centreList.appendChild(buildCentreRow(name, { lat: null, lng: null }));
});

btnSaveLocations.addEventListener("click", async () => {
  btnSaveLocations.disabled    = true;
  btnSaveLocations.textContent = "Saving…";
  await chrome.storage.local.set({ centreLocations: centreLocationsCache });
  btnSaveLocations.disabled    = false;
  btnSaveLocations.textContent = "💾 Save Locations";
  showToast("✓ Locations saved!");
});

/* ================================================================== */
/*  Human library availability check                                   */
/* ================================================================== */

let faceApiAvailable = false;

(async () => {
  if (window._humanMissing || typeof Human === "undefined") {
    humanWarning.style.display = "block";
    return;
  }
  try {
    await loadModels();
    faceApiAvailable = true;
  } catch (err) {
    console.warn("[options] Human models failed:", err.message);
    humanWarning.style.display = "block";
    humanWarning.textContent   = `⚠ Face recognition unavailable: ${err.message}`;
  }
})();

/* ================================================================== */
/*  Children list (read-only)                                          */
/* ================================================================== */

function renderChildrenList(children) {
  childrenList.innerHTML = "";
  if (!children || children.length === 0) {
    const p = document.createElement("p");
    p.id          = "noChildrenMsg";
    p.style.cssText = "font-size:13px;color:var(--muted);margin-bottom:8px;";
    p.textContent = "No children found. Open Storypark in a tab and click Refresh.";
    childrenList.appendChild(p);
    return;
  }
  for (const child of children) {
    const row = document.createElement("div");
    row.className   = "child-display-row";
    row.textContent = child.name;
    childrenList.appendChild(row);
  }
}

function populateTrainingChildSelect(children) {
  const current = trainingChildSelect.value;
  trainingChildSelect.innerHTML = '<option value="">— select a child —</option>';
  for (const child of children) {
    const opt = document.createElement("option");
    opt.value       = child.id;
    opt.textContent = child.name;
    trainingChildSelect.appendChild(opt);
  }
  if (current) trainingChildSelect.value = current;
}

function loadChildren() {
  // Show any cached data immediately so the UI isn't blank
  chrome.storage.local.get("children", ({ children = [] }) => {
    renderChildrenList(children);
    populateTrainingChildSelect(children);
  });
  // Then auto-refresh from the Storypark API so the list is always current
  chrome.runtime.sendMessage({ type: "REFRESH_PROFILE" }, (res) => {
    if (chrome.runtime.lastError) return; // background not yet ready; cached data is sufficient
    if (res?.ok && res.children.length > 0) {
      renderChildrenList(res.children);
      populateTrainingChildSelect(res.children);
    }
  });
}

btnRefreshChildren.addEventListener("click", () => {
  btnRefreshChildren.disabled    = true;
  btnRefreshChildren.textContent = "Refreshing…";

  chrome.runtime.sendMessage({ type: "REFRESH_PROFILE" }, (res) => {
    btnRefreshChildren.disabled    = false;
    btnRefreshChildren.textContent = "↻ Refresh from Storypark";
    if (res?.ok) {
      renderChildrenList(res.children);
      populateTrainingChildSelect(res.children);
    } else {
      alert(
        "Could not refresh children: " +
          (res?.error || "Make sure Storypark is open in a tab.")
      );
    }
  });
});

/* ================================================================== */
/*  Face training – manual upload with live match preview             */
/* ================================================================== */

let pendingTrainingFiles = [];

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader  = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url   = URL.createObjectURL(file);
    const img   = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

function matchBadgeClass(pct) {
  if (pct === null) return "none";
  if (pct >= 80)    return "good";
  if (pct >= 50)    return "ok";
  return "bad";
}

function buildPreviewCard(entry, index) {
  const wrapper = document.createElement("div");
  wrapper.className    = "training-card-wrapper";
  wrapper.dataset.index = index;

  const card = document.createElement("div");
  card.className    = "match-preview";

  // Remove button
  const btnRemove = document.createElement("button");
  btnRemove.className   = "btn-remove-training";
  btnRemove.textContent = "✕";
  btnRemove.title       = "Remove this photo";
  btnRemove.addEventListener("click", () => {
    pendingTrainingFiles.splice(index, 1);
    renderTrainingPreviews();
  });

  const img = document.createElement("img");
  img.src = entry.dataUrl;
  img.alt = "Training photo";

  const info = document.createElement("div");
  info.style.flex = "1";

  const fileName      = document.createElement("div");
  fileName.style.fontSize   = "12px";
  fileName.style.fontWeight = "600";
  fileName.textContent = entry.file.name;

  const badge = document.createElement("span");
  badge.className = "match-badge";
  if (!faceApiAvailable) {
    badge.textContent  = "Models unavailable";
    badge.className   += " none";
  } else if (!entry.descriptor) {
    badge.textContent  = "No face detected";
    badge.className   += " none";
  } else if (entry.matchPct !== null) {
    badge.textContent  = `Match: ${entry.matchPct}%`;
    badge.className   += ` ${matchBadgeClass(entry.matchPct)}`;
  } else {
    badge.textContent  = "Face detected ✓";
    badge.className   += " good";
  }

  info.appendChild(fileName);
  info.appendChild(badge);

  // When more than one face was found, show buttons so the user can pick the
  // correct face for this child.
  if (entry.faces && entry.faces.length > 1) {
    const selector = document.createElement("div");
    selector.className = "face-selector";

    entry.faces.forEach((face, fi) => {
      const btn = document.createElement("button");
      btn.className  = "face-btn" + (fi === entry.selectedFaceIndex ? " selected" : "");
      btn.textContent = `Face ${fi + 1}`;
      btn.addEventListener("click", () => {
        entry.selectedFaceIndex = fi;
        entry.descriptor        = face.embedding;
        entry.matchPct          = face.matchPct;
        renderTrainingPreviews();
      });
      selector.appendChild(btn);
    });

    info.appendChild(selector);
  }

  card.appendChild(img);
  card.appendChild(info);

  wrapper.appendChild(btnRemove);
  wrapper.appendChild(card);
  return wrapper;
}

function renderTrainingPreviews() {
  trainingPreviews.innerHTML = "";
  for (let i = 0; i < pendingTrainingFiles.length; i++) {
    trainingPreviews.appendChild(buildPreviewCard(pendingTrainingFiles[i], i));
  }
  btnSaveTraining.disabled = pendingTrainingFiles.length === 0;
}

trainingChildSelect.addEventListener("change", () => {
  pendingTrainingFiles = [];
  trainingFileInput.value = "";
  renderTrainingPreviews();
});

trainingFileInput.addEventListener("change", async () => {
  const files = Array.from(trainingFileInput.files).slice(0, 25);
  pendingTrainingFiles = [];
  renderTrainingPreviews(); // show empty state immediately while loading

  const childId = trainingChildSelect.value;
  let existingDescriptors = [];
  if (childId) {
    const found = await getDescriptors(childId).catch(() => null);
    existingDescriptors = found?.descriptors ?? [];
  }

  for (const file of files) {
    const dataUrl = await readFileAsDataURL(file);
    const entry   = {
      file,
      dataUrl,
      faces:             [],
      selectedFaceIndex: 0,
      descriptor:        null,
      matchPct:          null,
    };
    pendingTrainingFiles.push(entry);

    if (faceApiAvailable) {
      try {
        const img      = await fileToImage(file);
        const detected = await detectFaces(img);

        // Build a reference set of already-processed embeddings for match scoring
        const referenceDescriptors = [
          ...existingDescriptors,
          ...pendingTrainingFiles
            .slice(0, pendingTrainingFiles.indexOf(entry))
            .filter((e) => e.descriptor)
            .map((e) => e.descriptor),
        ];

        // Compute per-face match pct so the user can compare faces
        const facesWithMatch = await Promise.all(
          detected.map(async (face) => ({
            embedding: face.embedding,
            score:     face.score,
            matchPct:  await matchEmbedding(face.embedding, referenceDescriptors),
          }))
        );

        entry.faces             = facesWithMatch;
        entry.selectedFaceIndex = 0;
        entry.descriptor        = facesWithMatch[0]?.embedding ?? null;
        entry.matchPct          = facesWithMatch[0]?.matchPct  ?? null;
      } catch (err) {
        console.warn("[options] face encoding error:", err.message);
      }
    }
  }

  renderTrainingPreviews();
});

btnSaveTraining.addEventListener("click", async () => {
  const childId  = trainingChildSelect.value;
  const childOpt = trainingChildSelect.options[trainingChildSelect.selectedIndex];
  const childName = childOpt?.textContent || "";

  if (!childId) {
    alert("Please select a child first.");
    return;
  }

  if (pendingTrainingFiles.length === 0) {
    alert("No photos selected. Please choose photos first.");
    return;
  }

  btnSaveTraining.disabled    = true;
  btnSaveTraining.textContent = "Saving…";
  trainingLoading.style.display = "flex";
  trainingLoadingBar.value      = 0;

  const total = pendingTrainingFiles.length;
  trainingLoadingBar.max        = total;
  let saved   = 0;
  const photoLabel = (n) => `photo${n !== 1 ? "s" : ""}`;
  trainingProgress.textContent = `Training 0 of ${total} ${photoLabel(total)}…`;

  for (let i = 0; i < pendingTrainingFiles.length; i++) {
    const entry = pendingTrainingFiles[i];
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type:         "PROCESS_TRAINING_IMAGE",
            childId,
            childName,
            imageDataUri: entry.dataUrl,
            faceIndex:    entry.selectedFaceIndex ?? 0,
          },
          (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!res?.ok) {
              reject(new Error(res?.error || "Unknown error"));
            } else {
              resolve();
            }
          }
        );
      });
      saved++;
    } catch (err) {
      console.warn(`[options] Training image ${i + 1} failed:`, err.message);
    }
    trainingProgress.textContent =
      `Trained ${saved} of ${total} ${photoLabel(total)}…`;
    trainingLoadingBar.value = i + 1;
  }

  if (saved > 0) {
    showToast(`✓ Saved ${saved} training photo(s) for ${childName}`);
    pendingTrainingFiles = [];
    renderTrainingPreviews();
  } else {
    alert("No faces could be detected. Please try again with clearer, well-lit photos.");
  }

  trainingProgress.textContent = "";
  trainingLoading.style.display = "none";
  btnSaveTraining.disabled    = false;
  btnSaveTraining.textContent = "💾 Save training photos";
});

/* ================================================================== */
/*  Save face strictness settings                                      */
/* ================================================================== */

function showToast(msg = "✓ Settings saved!") {
  toast.textContent      = msg;
  toast.style.display    = "block";
  setTimeout(() => { toast.style.display = "none"; }, 2500);
}

btnSave.addEventListener("click", async () => {
  btnSave.disabled    = true;
  btnSave.textContent = "Saving…";

  const autoThreshold = parseInt(autoThresholdNumber.value, 10) || 85;
  const minThreshold  = parseInt(minThresholdNumber.value, 10) || 50;

  await chrome.storage.local.set({
    autoThreshold,
    minThreshold,
    centreLocations: centreLocationsCache,
  });

  btnSave.disabled    = false;
  btnSave.textContent = "💾 Save Settings";
  showToast();
});

/* ================================================================== */
/*  Init – load saved settings and children                           */
/* ================================================================== */

chrome.storage.local.get(
  ["autoThreshold", "minThreshold"],
  ({ autoThreshold = 85, minThreshold = 50 }) => {
    autoThresholdRange.value  = autoThreshold;
    autoThresholdNumber.value = autoThreshold;
    minThresholdRange.value   = minThreshold;
    minThresholdNumber.value  = minThreshold;
  }
);

/* ================================================================== */
/*  Reset Face Data                                                    */
/* ================================================================== */

btnResetFaceData.addEventListener("click", () => {
  const childId = trainingChildSelect.value;
  if (!childId) {
    alert("Please select a child first.");
    return;
  }
  const childName =
    trainingChildSelect.options[trainingChildSelect.selectedIndex]?.textContent || "";
  if (
    !confirm(
      `Are you sure you want to reset all face training data for ${childName}? This cannot be undone.`
    )
  ) {
    return;
  }
  btnResetFaceData.disabled = true;
  chrome.runtime.sendMessage({ type: "RESET_FACE_DATA", childId }, (res) => {
    btnResetFaceData.disabled = false;
    if (res?.ok) {
      showToast(`✓ Face data reset for ${childName}`);
      pendingTrainingFiles = [];
      renderTrainingPreviews();
    } else {
      alert("Reset failed: " + (res?.error || "Unknown error"));
    }
  });
});

loadChildren();
loadCentreLocations();
