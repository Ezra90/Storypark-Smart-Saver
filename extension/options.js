/**
 * options.js – Settings page for Storypark Extracts.
 *
 * Manages:
 *  - Read-only display of children (fetched from Storypark API by background)
 *  - Face recognition strictness (autoThreshold / minThreshold)
 *  - Face training data: manual photo upload with live match preview
 *    Descriptors are saved to IndexedDB via lib/db.js
 */

import { loadModels, buildEncoding, computeMatchPercent } from "./lib/face.js";
import { getDescriptors, setDescriptors } from "./lib/db.js";

/* ================================================================== */
/*  Element refs                                                       */
/* ================================================================== */

const childrenList        = document.getElementById("childrenList");
const btnRefreshChildren  = document.getElementById("btnRefreshChildren");
const faceStrictnessSelect = document.getElementById("faceStrictness");
const trainingChildSelect  = document.getElementById("trainingChildSelect");
const trainingFileInput    = document.getElementById("trainingFileInput");
const trainingPreviews     = document.getElementById("trainingPreviews");
const btnSaveTraining      = document.getElementById("btnSaveTraining");
const btnSave              = document.getElementById("btnSave");
const toast                = document.getElementById("toast");
const humanWarning         = document.getElementById("humanWarning");

/* ================================================================== */
/*  Strictness mapping                                                 */
/* ================================================================== */

const STRICTNESS_MAP = {
  strict: { autoThreshold: 90, minThreshold: 60 },
  normal: { autoThreshold: 85, minThreshold: 50 },
  loose:  { autoThreshold: 70, minThreshold: 30 },
};

function thresholdsToStrictness(auto, min) {
  if (auto >= 90 && min >= 60) return "strict";
  if (auto >= 70 && min >= 30) return "normal";
  return "loose";
}

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
  chrome.storage.local.get("children", ({ children = [] }) => {
    renderChildrenList(children);
    populateTrainingChildSelect(children);
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
  const card = document.createElement("div");
  card.className    = "match-preview";
  card.dataset.index = index;

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
  } else if (entry.descriptor === null && entry.matchPct === null) {
    badge.textContent  = "No face detected";
    badge.className   += " bad";
  } else if (entry.matchPct !== null) {
    badge.textContent  = `Match: ${entry.matchPct}%`;
    badge.className   += ` ${matchBadgeClass(entry.matchPct)}`;
  } else {
    badge.textContent  = "Face detected ✓";
    badge.className   += " good";
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
  renderTrainingPreviews(); // show empty state immediately while loading

  const childId = trainingChildSelect.value;
  let existingDescriptors = [];
  if (childId) {
    const found = await getDescriptors(childId).catch(() => null);
    existingDescriptors = found?.descriptors ?? [];
  }

  for (const file of files) {
    const dataUrl = await readFileAsDataURL(file);
    const entry   = { file, dataUrl, descriptor: null, matchPct: null };
    pendingTrainingFiles.push(entry);

    if (faceApiAvailable) {
      try {
        const img        = await fileToImage(file);
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
  const childId  = trainingChildSelect.value;
  const childOpt = trainingChildSelect.options[trainingChildSelect.selectedIndex];
  const childName = childOpt?.textContent || "";

  if (!childId) {
    alert("Please select a child first.");
    return;
  }

  const valid = pendingTrainingFiles.filter((e) => e.descriptor !== null);
  if (valid.length === 0) {
    alert("No valid face photos detected. Please choose clearer photos.");
    return;
  }

  btnSaveTraining.disabled    = true;
  btnSaveTraining.textContent = "Saving…";

  try {
    await setDescriptors(childId, childName, valid.map((e) => e.descriptor));
    showToast(`✓ Saved ${valid.length} training photo(s) for ${childName}`);
    pendingTrainingFiles = [];
    renderTrainingPreviews();
  } catch (err) {
    alert("Failed to save descriptors: " + err.message);
  }

  btnSaveTraining.disabled    = false;
  btnSaveTraining.textContent = "�� Save training photos";
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

  const strictness = faceStrictnessSelect.value;
  const { autoThreshold, minThreshold } =
    STRICTNESS_MAP[strictness] || STRICTNESS_MAP.normal;

  await chrome.storage.local.set({ autoThreshold, minThreshold });

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
    faceStrictnessSelect.value = thresholdsToStrictness(autoThreshold, minThreshold);
  }
);

loadChildren();
