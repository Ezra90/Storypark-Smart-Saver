/**
 * options.js – Settings page logic for the Storypark Photo Sync extension.
 *
 * Manages:
 *  - Children names + reference face photo uploads
 *  - Daycare GPS coordinates
 *  - Google Photos album selection / creation
 *  - Persists everything to chrome.storage.local
 */

const childrenList = document.getElementById("childrenList");
const btnAddChild = document.getElementById("btnAddChild");
const latInput = document.getElementById("lat");
const lonInput = document.getElementById("lon");
const albumSelect = document.getElementById("albumSelect");
const albumRefresh = document.getElementById("albumRefresh");
const newAlbumName = document.getElementById("newAlbumName");
const btnCreateAlbum = document.getElementById("btnCreateAlbum");
const btnSave = document.getElementById("btnSave");
const toast = document.getElementById("toast");

/* ------------------------------------------------------------------ */
/*  Children UI                                                        */
/* ------------------------------------------------------------------ */

let childRows = []; // { name: string, encodingIndex: number|null }

function renderChildren(children) {
  childrenList.innerHTML = "";
  childRows = [];

  children.forEach((child, idx) => {
    addChildRow(child.name, idx);
  });
}

function addChildRow(name = "", encodingIdx = null) {
  const row = document.createElement("div");
  row.className = "child-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Child's name";
  nameInput.value = name;

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
  });

  row.appendChild(nameInput);
  row.appendChild(fileInput);
  row.appendChild(removeBtn);
  childrenList.appendChild(row);

  const entry = { nameInput, fileInput, encodingIdx };
  childRows.push(entry);
}

btnAddChild.addEventListener("click", () => addChildRow());

/* ------------------------------------------------------------------ */
/*  Album management                                                   */
/* ------------------------------------------------------------------ */

function loadAlbums() {
  albumSelect.disabled = true;
  chrome.runtime.sendMessage({ type: "LIST_ALBUMS" }, (res) => {
    albumSelect.disabled = false;
    // Keep "None" option
    albumSelect.innerHTML = '<option value="">None (main library)</option>';

    if (res?.ok && res.albums) {
      for (const album of res.albums) {
        const opt = document.createElement("option");
        opt.value = album.id;
        opt.textContent = album.title || album.id;
        albumSelect.appendChild(opt);
      }
    }

    // Restore saved selection
    chrome.storage.local.get("albumId", ({ albumId }) => {
      if (albumId) albumSelect.value = albumId;
    });
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
/*  Face encoding from reference photos                                */
/* ------------------------------------------------------------------ */

/**
 * Read a file input as an ArrayBuffer, then store the raw data.
 * Full face-api.js encoding is done lazily at sync time; here we
 * persist the raw image bytes so the encoding can be computed later
 * in an offscreen document or the options page with face-api loaded.
 *
 * For the foundational build, we store the image as a base64 data URL
 * and the encoding placeholder. When face-api.js models are available,
 * this converts to a real 128-D descriptor.
 */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ */
/*  Save                                                               */
/* ------------------------------------------------------------------ */

btnSave.addEventListener("click", async () => {
  btnSave.disabled = true;
  btnSave.textContent = "Saving…";

  // Collect children data
  const children = [];
  const childEncodings = [];

  for (const row of childRows) {
    const name = row.nameInput.value.trim();
    if (!name) continue;

    const childData = { name };

    // If a new reference photo was selected, read it
    if (row.fileInput.files.length > 0) {
      const dataUrl = await readFileAsDataURL(row.fileInput.files[0]);
      childData.referencePhoto = dataUrl;
      // Store a placeholder encoding entry; real encoding is computed
      // when face-api.js models are loaded (see face.js).
      childEncodings.push({
        name,
        referencePhoto: dataUrl,
        descriptor: null, // will be computed at sync/build time
      });
    } else {
      // Preserve existing encoding if available
      const { childEncodings: existing = [] } =
        await chrome.storage.local.get("childEncodings");
      const prev = existing.find((c) => c.name === name);
      if (prev) childEncodings.push(prev);
    }

    children.push(childData);
  }

  // Validate GPS
  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);
  const validLat = !isNaN(lat) && lat >= -90 && lat <= 90;
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

  // Save to chrome.storage.local
  await chrome.storage.local.set({
    children,
    childEncodings,
    daycareLat: validLat ? lat : null,
    daycareLon: validLon ? lon : null,
    albumId: albumSelect.value || "",
  });

  btnSave.disabled = false;
  btnSave.textContent = "💾 Save Settings";

  // Show toast
  toast.style.display = "block";
  setTimeout(() => {
    toast.style.display = "none";
  }, 2500);
});

/* ------------------------------------------------------------------ */
/*  Load saved settings on page open                                   */
/* ------------------------------------------------------------------ */

(async function init() {
  const data = await chrome.storage.local.get([
    "children",
    "daycareLat",
    "daycareLon",
    "albumId",
  ]);

  // Children
  const children = data.children || [];
  if (children.length > 0) {
    renderChildren(children);
  } else {
    addChildRow(); // start with one empty row
  }

  // GPS
  if (data.daycareLat != null) latInput.value = data.daycareLat;
  if (data.daycareLon != null) lonInput.value = data.daycareLon;

  // Albums (async)
  loadAlbums();
})();
