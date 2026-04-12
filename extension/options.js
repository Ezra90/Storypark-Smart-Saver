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
import { getDescriptors, setDescriptors, MAX_DESCRIPTORS_PER_CHILD } from "./lib/db.js";

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
const btnDiscoverCentres   = document.getElementById("btnDiscoverCentres");
const btnDownloadDiagLog   = document.getElementById("btnDownloadDiagLog");
const btnSaveLocations     = document.getElementById("btnSaveLocations");
const trainingChildSelect  = document.getElementById("trainingChildSelect");
const trainingFileInput    = document.getElementById("trainingFileInput");
const trainingPreviews     = document.getElementById("trainingPreviews");
const trainingProgress     = document.getElementById("trainingProgress");
const trainingLoading      = document.getElementById("trainingLoading");
const trainingLoadingBar   = document.getElementById("trainingLoadingBar");
const btnSaveTraining      = document.getElementById("btnSaveTraining");
const btnExportProfile     = document.getElementById("btnExportProfile");
const btnImportProfile     = document.getElementById("btnImportProfile");
const importProfileInput   = document.getElementById("importProfileInput");
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

  // Show discovered address (read-only) if available from the Storypark API.
  // This helps the user confirm the correct centre and use the address for
  // the Google Maps search link.
  const address = loc.address || null;
  if (address) {
    const addressEl = document.createElement("div");
    addressEl.style.cssText =
      "grid-column:1/-1;font-size:11px;color:var(--muted,#9a9aaf);" +
      "margin:-4px 0 6px;padding-left:2px;";
    addressEl.textContent = `📍 ${address}`;
    nameField.appendChild(addressEl);
  }

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
      mapsLink.href        = `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
      mapsLink.textContent = "📍 View on Map";
      mapsLink.style.display = "";
    } else {
      mapsLink.style.display = "none";
    }
  };
  updateMapsLink();

  // "Search on Google Maps" link — when an address was discovered from the API
  // it is used as the search query (more precise than the centre name alone);
  // otherwise fall back to the centre name.  Lets the user copy the Maps URL
  // and paste it back into the Coordinates field, or click to confirm visually.
  const searchMapsLink = document.createElement("a");
  searchMapsLink.style.cssText  = "font-size:12px; white-space:nowrap; align-self:flex-end; padding-bottom:8px;";
  searchMapsLink.target         = "_blank";
  searchMapsLink.rel            = "noopener";
  searchMapsLink.textContent    = "🔍 Search on Google Maps";
  const updateSearchMapsLink = () => {
    // Prefer the full address (name + address) for a more accurate Maps result.
    const centreName = nameInput.value.trim();
    const q = address
      ? `${centreName}, ${address}`
      : centreName;
    searchMapsLink.href = q
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
      : "#";
    searchMapsLink.style.display = q ? "" : "none";
  };
  updateSearchMapsLink();
  nameInput.addEventListener("input", updateSearchMapsLink);

  // "Auto-Lookup" button — uses Nominatim OSM to geocode the centre name (Bug 1).
  const btnLookup = document.createElement("button");
  btnLookup.className   = "btn-add";
  btnLookup.textContent = "🔍 Auto-Lookup";
  btnLookup.type        = "button";
  btnLookup.style.cssText = "width:auto;padding:6px 12px;margin:0;font-size:12px;align-self:flex-end;";
  btnLookup.title = "Automatically look up GPS coordinates from the centre name using OpenStreetMap";
  btnLookup.addEventListener("click", async () => {
    const query = nameInput.value.trim();
    if (!query) {
      alert("Enter a centre name first.");
      return;
    }
    const origText    = btnLookup.textContent;
    btnLookup.textContent = "Searching…";
    btnLookup.disabled    = true;
    try {
      // If the API provided an address, combine name + address for accuracy.
      // Otherwise append a childcare keyword to help Nominatim find the business.
      let searchQuery;
      if (address) {
        searchQuery = `${query}, ${address}`;
      } else {
        const lowerQuery = query.toLowerCase();
        const hasKeyword = /childcare|daycare|kindergarten|preschool|nursery|early learning|child care|day care/.test(lowerQuery);
        searchQuery = hasKeyword ? query : `${query} childcare`;
      }

      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=5&addressdetails=1`,
        { headers: { "User-Agent": "StoryparkSmartSaver/2.0" } }
      );
      const results = await resp.json();
      if (results.length === 0) {
        alert("No results found for that name. Try adding the suburb or city (e.g. \"Sunshine Childcare Brisbane\"), or use the \"Search on Google Maps\" link to find exact coordinates.");
      } else if (results.length === 1) {
        mapsInput.value = `${results[0].lat}, ${results[0].lon}`;
        updateCache();
      } else {
        // Show a picker so the user can choose the most accurate result
        const existing = row.querySelector(".nominatim-picker");
        if (existing) existing.remove();

        const picker = document.createElement("div");
        picker.className = "nominatim-picker";
        picker.style.cssText = "grid-column:1/-1;display:flex;flex-direction:column;gap:4px;margin-top:4px;background:var(--bg2,#f5f5f5);border:1px solid var(--border,#ddd);border-radius:6px;padding:8px;";

        const label = document.createElement("p");
        label.style.cssText = "margin:0 0 6px;font-size:12px;color:var(--muted,#666);";
        label.textContent = "Multiple results found — select the correct location:";
        picker.appendChild(label);

        for (const result of results) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn-add";
          btn.style.cssText = "width:auto;text-align:left;padding:5px 10px;font-size:12px;white-space:normal;height:auto;";
          const displayName = result.display_name || `${result.lat}, ${result.lon}`;
          btn.textContent = displayName;
          btn.addEventListener("click", () => {
            mapsInput.value = `${result.lat}, ${result.lon}`;
            updateCache();
            picker.remove();
          });
          picker.appendChild(btn);
        }

        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "btn-remove-centre";
        dismiss.style.cssText = "margin-top:4px;width:auto;align-self:flex-start;";
        dismiss.textContent = "✕ Cancel";
        dismiss.addEventListener("click", () => picker.remove());
        picker.appendChild(dismiss);

        row.appendChild(picker);
      }
    } catch (e) {
      alert("Auto-lookup failed: " + e.message);
    }
    btnLookup.textContent = origText;
    btnLookup.disabled    = false;
  });

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
  row.appendChild(searchMapsLink);
  row.appendChild(mapsLink);
  row.appendChild(btnLookup);
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
        address: address || centreLocationsCache[newKey]?.address || null,
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

btnDiscoverCentres.addEventListener("click", () => {
  const orig = btnDiscoverCentres.textContent;
  btnDiscoverCentres.disabled    = true;
  btnDiscoverCentres.textContent = "Discovering…";
  chrome.runtime.sendMessage({ type: "DISCOVER_CENTRES" }, (res) => {
    btnDiscoverCentres.disabled    = false;
    btnDiscoverCentres.textContent = orig;
    if (res?.ok) {
      // Reload the centre list to reflect any newly-added centres.
      loadCentreLocations();
      showToast("✓ Centre list refreshed from Storypark");
    } else {
      alert(
        "Could not discover centres: " +
          (res?.error || "Make sure Storypark is open in a tab and you are logged in.")
      );
    }
  });
});

btnSaveLocations.addEventListener("click", async () => {
  btnSaveLocations.disabled    = true;
  btnSaveLocations.textContent = "Saving…";
  await chrome.storage.local.set({ centreLocations: centreLocationsCache });
  btnSaveLocations.disabled    = false;
  btnSaveLocations.textContent = "💾 Save Locations";
  showToast("✓ Locations saved!");
});

btnDownloadDiagLog.addEventListener("click", () => {
  const orig = btnDownloadDiagLog.textContent;
  btnDownloadDiagLog.disabled    = true;
  btnDownloadDiagLog.textContent = "Collecting…";
  chrome.runtime.sendMessage({ type: "GET_DIAGNOSTIC_LOG" }, (res) => {
    btnDownloadDiagLog.disabled    = false;
    btnDownloadDiagLog.textContent = orig;
    if (!res?.ok) {
      alert("Could not retrieve diagnostic log. Try refreshing the page.");
      return;
    }
    const payload = {
      capturedAt:      res.capturedAt,
      centreLocations: res.centreLocations,
      apiLog:          res.log,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `storypark-diag-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

/* ================================================================== */
/*  Human library availability check                                   */
/* ================================================================== */

let faceApiAvailable = false;

// Catch any promise rejections from the Human.js library that escape the
// try/catch below (e.g. internal TF.js async backend errors).  Without
// this handler Chrome records them as extension errors in the error tab.
window.addEventListener("unhandledrejection", (event) => {
  const stack = event.reason?.stack || "";
  const msg   = event.reason?.message || String(event.reason);
  // Only suppress errors that originate from human.js itself.
  if (stack.includes("human.js") || msg.includes("human.js")) {
    console.warn("[options] Unhandled Human.js rejection caught:", event.reason);
    event.preventDefault(); // suppress the extension error tab entry
    faceApiAvailable = false;
    humanWarning.style.display = "block";
    if (!humanWarning.textContent.includes("unavailable")) {
      humanWarning.textContent = `⚠ Face recognition unavailable: ${msg}`;
    }
  }
});

(async () => {
  if (typeof Human === "undefined") {
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
    // The profile refresh may have discovered new centre names – reload them.
    loadCentreLocations();
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

/**
 * Refresh the training status indicator for a given child (Bug 2).
 * Reads descriptor count from IndexedDB and displays a quality indicator.
 *
 * @param {string} childId
 */
async function refreshTrainingStatus(childId) {
  const statusEl = document.getElementById("trainingStatus");
  if (!statusEl) return;
  if (!childId) { statusEl.innerHTML = ""; return; }
  try {
    const data  = await getDescriptors(childId).catch(() => null);
    const count = data?.descriptors?.length ?? 0;
    const max   = 30;
    if (count === 0) {
      statusEl.innerHTML = `<span style="color:var(--warning);">⚠ No training data yet. Upload at least 10 photos for best results.</span>`;
    } else if (count < 10) {
      statusEl.innerHTML = `<span style="color:var(--warning);">🟡 ${count}/${max} face descriptors stored — needs more photos to improve accuracy.</span>`;
    } else {
      statusEl.innerHTML = `<span style="color:var(--success);">✅ ${count}/${max} face descriptors stored — model is well-trained.</span>`;
    }
  } catch {
    statusEl.innerHTML = "";
  }
}

trainingChildSelect.addEventListener("change", async () => {
  pendingTrainingFiles = [];
  trainingFileInput.value = "";
  renderTrainingPreviews();
  await refreshTrainingStatus(trainingChildSelect.value);
});

trainingFileInput.addEventListener("change", async () => {
  // Snapshot the newly-chosen files and immediately clear the input so the
  // same file(s) can be re-selected later without triggering a no-op event.
  const newFiles = Array.from(trainingFileInput.files);
  trainingFileInput.value = "";

  // Cap the total number of pending training photos at 25.
  const slots = 25 - pendingTrainingFiles.length;
  if (slots <= 0) return;
  const filesToAdd = newFiles.slice(0, slots);

  const childId = trainingChildSelect.value;
  let existingDescriptors = [];
  if (childId) {
    const found = await getDescriptors(childId).catch(() => null);
    existingDescriptors = found?.descriptors ?? [];
  }

  for (const file of filesToAdd) {
    const dataUrl = await readFileAsDataURL(file);
    const entry   = {
      file,
      dataUrl,
      faces:             [],
      selectedFaceIndex: 0,
      descriptor:        null,
      matchPct:          null,
    };

    // Append to the custom array and render immediately so the user can
    // delete this entry before face detection completes for subsequent files.
    pendingTrainingFiles.push(entry);
    renderTrainingPreviews();

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

        // Only update and re-render if the entry is still in the array
        // (the user may have deleted it while face detection was running).
        const entryIndex = pendingTrainingFiles.indexOf(entry);
        if (entryIndex !== -1) {
          entry.faces             = facesWithMatch;
          entry.selectedFaceIndex = 0;
          entry.descriptor        = facesWithMatch[0]?.embedding ?? null;
          entry.matchPct          = facesWithMatch[0]?.matchPct  ?? null;
          renderTrainingPreviews();
        }
      } catch (err) {
        console.warn("[options] face encoding error:", err.message);
      }
    }
  }
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
      // Prefer sending the descriptor that the live preview already computed
      // (from lib/face.js running in the options page).  This avoids a second
      // round-trip to the offscreen document and prevents failures caused by
      // the offscreen Human instance not being initialised at training time.
      // Fall back to PROCESS_TRAINING_IMAGE (offscreen re-detection) only when
      // no descriptor was produced by the live preview (face API unavailable or
      // the user skipped the preview by loading the page without human.js).
      const msgPayload = entry.descriptor
        ? {
            type:       "SAVE_TRAINING_DESCRIPTOR",
            childId,
            childName,
            descriptor: Array.from(entry.descriptor),
          }
        : {
            type:         "PROCESS_TRAINING_IMAGE",
            childId,
            childName,
            imageDataUri: entry.dataUrl,
            faceIndex:    entry.selectedFaceIndex ?? 0,
          };

      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msgPayload, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!res?.ok) {
            reject(new Error(res?.error || "Unknown error"));
          } else {
            resolve();
          }
        });
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
    // Refresh training status to reflect newly-saved descriptors (Bug 2)
    await refreshTrainingStatus(childId);
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

/* ================================================================== */
/*  Facial profile export / import                                     */
/* ================================================================== */

btnExportProfile.addEventListener("click", async () => {
  const childId = trainingChildSelect.value;
  if (!childId) {
    alert("Please select a child first.");
    return;
  }
  const childName =
    trainingChildSelect.options[trainingChildSelect.selectedIndex]?.textContent || "";

  const data = await getDescriptors(childId).catch(() => null);
  if (!data || !data.descriptors || data.descriptors.length === 0) {
    alert("No training data to export for this child. Save some training photos first.");
    return;
  }

  const exportPayload = {
    version:    1,
    exportDate: new Date().toISOString(),
    childId:    data.childId,
    childName:  data.childName || childName,
    descriptors: data.descriptors,
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `storypark-face-${(childName || childId).replace(/\s+/g, "-").toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`✓ Exported ${data.descriptors.length} descriptors for ${childName}`);
});

btnImportProfile.addEventListener("click", () => {
  importProfileInput.click();
});

importProfileInput.addEventListener("change", async () => {
  const file = importProfileInput.files?.[0];
  if (!file) return;
  importProfileInput.value = "";

  let parsed;
  try {
    const text = await new Promise((resolve, reject) => {
      const reader  = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
    parsed = JSON.parse(text);
  } catch (e) {
    alert("Could not read the file: " + e.message);
    return;
  }

  if (!parsed || !Array.isArray(parsed.descriptors) || parsed.descriptors.length === 0) {
    alert("Invalid profile file — no descriptors found. Make sure you chose a valid export.");
    return;
  }

  // Determine the target child: prefer the currently-selected child; fall back
  // to the childId embedded in the export file.
  const targetChildId =
    trainingChildSelect.value || parsed.childId || "";
  const targetChildName = trainingChildSelect.value
    ? (trainingChildSelect.options[trainingChildSelect.selectedIndex]?.textContent || "")
    : (parsed.childName || parsed.childId || "Unknown");

  if (!targetChildId) {
    alert(
      "Please select a child from the list first (or the export file must contain a childId)."
    );
    return;
  }

  const existing      = await getDescriptors(targetChildId).catch(() => null);
  const existingCount = existing?.descriptors?.length ?? 0;
  const importCount   = parsed.descriptors.length;

  let mergedDescriptors;
  if (existingCount > 0) {
    const doMerge = confirm(
      `${targetChildName} already has ${existingCount} stored descriptor(s).\n` +
      `The import file contains ${importCount} descriptor(s).\n\n` +
      `Click OK to MERGE both sets (up to ${MAX_DESCRIPTORS_PER_CHILD} kept).\n` +
      `Click Cancel to REPLACE all existing data with the imported file.`
    );
    if (doMerge) {
      // Merge: combine existing + imported, keep the most recent up to the cap.
      // Descriptors are stored in chronological order (oldest → newest), so
      // existing descriptors are older and imported ones are appended at the
      // end. slice(-MAX_DESCRIPTORS_PER_CHILD) therefore preserves the most
      // recent entries from both sets.
      const combined = [...existing.descriptors, ...parsed.descriptors];
      mergedDescriptors = combined.slice(-MAX_DESCRIPTORS_PER_CHILD);
    } else {
      mergedDescriptors = parsed.descriptors.slice(-MAX_DESCRIPTORS_PER_CHILD);
    }
  } else {
    mergedDescriptors = parsed.descriptors.slice(-MAX_DESCRIPTORS_PER_CHILD);
  }

  try {
    await setDescriptors(targetChildId, targetChildName, mergedDescriptors);
    // Notify the offscreen document to refresh its in-memory profile cache.
    chrome.runtime.sendMessage({ type: "REFRESH_PROFILES" }).catch(() => {});
    showToast(`✓ Imported ${mergedDescriptors.length} descriptors for ${targetChildName}`);
    await refreshTrainingStatus(targetChildId);
  } catch (e) {
    alert("Import failed: " + e.message);
  }
});

btnSave.addEventListener("click", async () => {
  btnSave.disabled    = true;
  btnSave.textContent = "Saving…";

  const autoThreshold = parseInt(autoThresholdNumber.value, 10) || 85;
  const minThreshold  = parseInt(minThresholdNumber.value, 10) || 50;

  if (minThreshold >= autoThreshold) {
    showToast("⚠ Review threshold must be lower than Auto-Approve threshold.");
    btnSave.disabled    = false;
    btnSave.textContent = "💾 Save Settings";
    return;
  }

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
      // Refresh training status after reset (Bug 2)
      refreshTrainingStatus(childId);
    } else {
      alert("Reset failed: " + (res?.error || "Unknown error"));
    }
  });
});

loadChildren();
loadCentreLocations();
