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
import { sanitizeName, TEMPLATE_LIMITS, CARD_TITLE_MAX_CHARS } from "./lib/metadata-helpers.js";
import { getDescriptors, setDescriptors, MAX_DESCRIPTORS_PER_CHILD } from "./lib/db.js";

const humanAvailable = typeof Human !== "undefined";

let _settingsInited = false;
const GUIDED_STEP_LABELS = Object.freeze({
  syncCheck: "Sync",
  downloadLatest: "Download",
  checkRestore: "Step 4: Check & Restore Missing",
});

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
  const $btnRunFaceBootstrap = document.getElementById("btnRunFaceBootstrap");
  const $btnRunSelfImproveNow = document.getElementById("btnRunSelfImproveNow");
  const $btnDecisionAuditSummary = document.getElementById("btnDecisionAuditSummary");
  const $faceModelHealthPanel = document.getElementById("faceModelHealthPanel");
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
  const $btnSyncStoryparkInfo = document.getElementById("btnSyncStoryparkInfo");
  const $syncStoryparkInfoStatus = document.getElementById("syncStoryparkInfoStatus");
  const $chkAutoStoryparkSync = document.getElementById("chkAutoStoryparkSync");
  const $autoStoryparkSyncHours = document.getElementById("autoStoryparkSyncHours");
  const $btnResumeStoryparkSync = document.getElementById("btnResumeStoryparkSync");
  const $btnRefreshSyncHealth = document.getElementById("btnRefreshSyncHealth");
  const $storyparkSyncHealthPanel = document.getElementById("storyparkSyncHealthPanel");
  let _syncInfoActive = false;

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
  const $btnRunRetentionNow = document.getElementById("btnRunRetentionNow");
  const $retentionDecisionMax = document.getElementById("retentionDecisionMax");
  const $retentionNegativeDays = document.getElementById("retentionNegativeDays");
  const $retentionFingerprintDays = document.getElementById("retentionFingerprintDays");
  const $debugLogStatus = document.getElementById("debugLogStatus");

  const $humanWarning = document.getElementById("humanWarning");
  const $btnGenerateStoryCardsAll = document.getElementById("btnGenerateStoryCardsAll");
  const $storyCardsStatus = document.getElementById("storyCardsStatus");
  const $btnClearAllRejections = document.getElementById("btnClearAllRejections");
  const $clearRejectionsStatus = document.getElementById("clearRejectionsStatus");
  const $templateHtmlBody = document.getElementById("templateHtmlBody");
  const $templateCardTitle = document.getElementById("templateCardTitle");
  const $templateExifTitle = document.getElementById("templateExifTitle");
  const $templateIncludeRoutine = document.getElementById("templateIncludeRoutine");
  const $btnSaveTemplateSettings = document.getElementById("btnSaveTemplateSettings");
  const $btnPreviewTemplates = document.getElementById("btnPreviewTemplates");
  const $templatePreviewStatus = document.getElementById("templatePreviewStatus");
  const $templateCommandHelp = document.getElementById("templateCommandHelp");
  const $templateLivePreviewPanel = document.getElementById("templateLivePreviewPanel");
  const $templatePreviewMode = document.getElementById("templatePreviewMode");
  const $templateTargetMode = document.getElementById("templateTargetMode");
  const $metadataTemplateCard = document.getElementById("metadataTemplateCard");
  const $templateLimitsRef = document.getElementById("templateLimitsRef");

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
  const _centreSearchResults = new Map();

  function _isValidLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function _buildGoogleMapsLink(lat, lng) {
    if (!_isValidLatLng(lat, lng)) return "";
    return `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
  }

  function _buildGoogleMapsSearchLink(query) {
    const q = String(query || "").trim();
    if (!q) return "https://www.google.com/maps";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  function _formatCoords(lat, lng) {
    if (!_isValidLatLng(Number(lat), Number(lng))) return "";
    return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
  }

  function _extractLatLngFromText(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    const direct = raw.match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
    if (direct) {
      const lat = Number.parseFloat(direct[1]);
      const lng = Number.parseFloat(direct[2]);
      if (_isValidLatLng(lat, lng)) return { lat, lng };
    }

    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();

      // OpenStreetMap patterns:
      //   ?mlat=-27.47&mlon=153.02
      //   #map=18/-27.47/153.02
      const mlat = Number.parseFloat(url.searchParams.get("mlat"));
      const mlon = Number.parseFloat(url.searchParams.get("mlon"));
      if (_isValidLatLng(mlat, mlon)) return { lat: mlat, lng: mlon };
      const hashMap = url.hash.match(/map=\d+\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/i);
      if (hashMap) {
        const lat = Number.parseFloat(hashMap[1]);
        const lng = Number.parseFloat(hashMap[2]);
        if (_isValidLatLng(lat, lng)) return { lat, lng };
      }

      // Google Maps patterns:
      //   .../@-27.47,153.02,17z
      //   ...!3d-27.47!4d153.02
      //   ?q=-27.47,153.02 or ?query=-27.47,153.02 or ?ll=-27.47,153.02
      const atMatch = decodeURIComponent(url.pathname + url.hash).match(/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
      if (atMatch) {
        const lat = Number.parseFloat(atMatch[1]);
        const lng = Number.parseFloat(atMatch[2]);
        if (_isValidLatLng(lat, lng)) return { lat, lng };
      }
      const bangMatch = decodeURIComponent(raw).match(/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
      if (bangMatch) {
        const lat = Number.parseFloat(bangMatch[1]);
        const lng = Number.parseFloat(bangMatch[2]);
        if (_isValidLatLng(lat, lng)) return { lat, lng };
      }

      if (host.includes("google.") || host.includes("g.page")) {
        const q = url.searchParams.get("q") || url.searchParams.get("query") || url.searchParams.get("ll");
        if (q) {
          const qm = q.match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
          if (qm) {
            const lat = Number.parseFloat(qm[1]);
            const lng = Number.parseFloat(qm[2]);
            if (_isValidLatLng(lat, lng)) return { lat, lng };
          }
        }
      }
    } catch {
      // Non-URL input is handled by direct coordinate regex above.
    }

    return null;
  }

  function _escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderCentres() {
    if (!$centreList) return;
    $centreList.innerHTML = "";
    for (let i = 0; i < centreData.length; i++) {
      const c = centreData[i];
      const results = _centreSearchResults.get(i) || [];
      const item = document.createElement("div");
      item.className = "centre-item";
      const hasCoords = _isValidLatLng(Number(c?.lat), Number(c?.lng));
      item.innerHTML = `
        <div class="centre-row">
          <div class="centre-field centre-name-field">
            <label>Centre Name</label>
            <input type="text" value="${_escapeHtml(c.name || "")}" data-idx="${i}" data-field="name">
          </div>
          <div class="centre-field centre-maps-field">
            <label>Maps URL or Coordinates</label>
            <input type="text" value="${_escapeHtml(hasCoords ? _formatCoords(c.lat, c.lng) : (c.mapsUrl || ""))}" placeholder="Paste Google Maps / OpenStreetMap URL or lat,lng" data-idx="${i}" data-field="mapsUrl">
            <div class="centre-coords-hint">${hasCoords ? `📍 ${Number(c.lat).toFixed(6)}, ${Number(c.lng).toFixed(6)}` : "No valid coordinates set yet"}</div>
          </div>
          <button class="btn-secondary btn-search-centre" data-idx="${i}" title="Search OpenStreetMap">🔎 Search</button>
          <button class="btn-secondary btn-search-centre-google" data-idx="${i}" title="Search this centre in Google Maps">🌐 Google</button>
          <button class="btn-secondary btn-view-centre-map" data-idx="${i}" ${hasCoords ? "" : "disabled"} title="Open in Google Maps">🗺 View on Map</button>
          <button class="btn-remove-centre" data-idx="${i}">✕</button>
        </div>
        <div class="nominatim-picker" data-idx="${i}" style="${results.length ? "" : "display:none;"}">
          ${results.length
            ? results.map((r, ridx) => `
              <button class="nominatim-result" data-idx="${i}" data-result-idx="${ridx}">
                <strong>${_escapeHtml(r.name || c.name || "Location")}</strong><br>
                ${_escapeHtml(r.display_name || "")}
              </button>
            `).join("")
            : ""}
        </div>
      `;
      $centreList.appendChild(item);
    }
  }

  async function searchCentreSuggestions(idx) {
    const centre = centreData[idx];
    const name = (centre?.name || "").trim();
    if (!name) {
      toast("Enter a centre name first", "error");
      return;
    }

    const query = /\b(childcare|daycare|kindergarten|preschool|nursery|early learning)\b/i.test(name)
      ? name
      : `${name} childcare`;

    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`,
        {
          headers: {
            "Accept": "application/json",
          },
        }
      );
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      const results = (Array.isArray(data) ? data : [])
        .filter((r) => r && r.lat && r.lon)
        .map((r) => ({
          name: r.name || centre.name || "",
          display_name: r.display_name || "",
          lat: Number.parseFloat(r.lat),
          lng: Number.parseFloat(r.lon),
          address: r.display_name || "",
          mapsUrl: _formatCoords(r.lat, r.lon),
        }));

      _centreSearchResults.set(idx, results);
      renderCentres();
      if (results.length === 0) {
        const q = (centre?.name || "").trim();
        window.open(_buildGoogleMapsSearchLink(q), "_blank", "noopener,noreferrer");
        toast("No location matches found in OSM — opened Google Maps search", "error");
      }
    } catch (err) {
      toast(`❌ ${err.message}`, "error");
    }
  }

  $centreList?.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const idx = Number.parseInt(t.dataset.idx || "", 10);
    const field = t.dataset.field;
    if (!Number.isFinite(idx) || !field || !centreData[idx]) return;
    centreData[idx][field] = t.value;
    if (field === "name") _centreSearchResults.delete(idx);
  });

  $centreList?.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const idx = Number.parseInt(t.dataset.idx || "", 10);
    const field = t.dataset.field;
    if (!Number.isFinite(idx) || field !== "mapsUrl" || !centreData[idx]) return;

    const parsed = _extractLatLngFromText(t.value);
    if (parsed) {
      centreData[idx].lat = parsed.lat;
      centreData[idx].lng = parsed.lng;
      centreData[idx].mapsUrl = _formatCoords(parsed.lat, parsed.lng);
      renderCentres();
      toast(`✓ Location set (${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)})`, "success");
      return;
    }
    centreData[idx].mapsUrl = String(t.value || "").trim();
  });

  $centreList?.addEventListener("paste", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const idx = Number.parseInt(t.dataset.idx || "", 10);
    const field = t.dataset.field;
    if (!Number.isFinite(idx) || field !== "mapsUrl" || !centreData[idx]) return;
    const pasted = e.clipboardData?.getData("text") || "";
    const parsed = _extractLatLngFromText(pasted);
    if (!parsed) return;
    e.preventDefault();
    centreData[idx].lat = parsed.lat;
    centreData[idx].lng = parsed.lng;
    centreData[idx].mapsUrl = _formatCoords(parsed.lat, parsed.lng);
    renderCentres();
    toast("✓ Coordinates extracted from pasted link", "success");
  });

  $centreList?.addEventListener("click", async (e) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (!el) return;

    const removeBtn = el.closest(".btn-remove-centre");
    if (removeBtn) {
      const idx = Number.parseInt(removeBtn.dataset.idx || "", 10);
      if (!Number.isFinite(idx)) return;
      centreData.splice(idx, 1);
      _centreSearchResults.clear();
      renderCentres();
      return;
    }

    const searchBtn = el.closest(".btn-search-centre");
    if (searchBtn) {
      const idx = Number.parseInt(searchBtn.dataset.idx || "", 10);
      if (!Number.isFinite(idx)) return;
      searchBtn.disabled = true;
      searchBtn.textContent = "⏳ Searching…";
      await searchCentreSuggestions(idx);
      searchBtn.disabled = false;
      searchBtn.textContent = "🔎 Search";
      return;
    }

    const googleBtn = el.closest(".btn-search-centre-google");
    if (googleBtn) {
      const idx = Number.parseInt(googleBtn.dataset.idx || "", 10);
      if (!Number.isFinite(idx) || !centreData[idx]) return;
      const name = (centreData[idx].name || "").trim();
      if (!name) {
        toast("Enter a centre name first", "error");
        return;
      }
      window.open(_buildGoogleMapsSearchLink(`${name} childcare`), "_blank", "noopener,noreferrer");
      toast("Google Maps opened — copy coordinates and paste here", "success");
      return;
    }

    const mapBtn = el.closest(".btn-view-centre-map");
    if (mapBtn) {
      const idx = Number.parseInt(mapBtn.dataset.idx || "", 10);
      if (!Number.isFinite(idx) || !centreData[idx]) return;
      const lat = Number(centreData[idx].lat);
      const lng = Number(centreData[idx].lng);
      if (!_isValidLatLng(lat, lng)) {
        toast("Set location first via search or map link", "error");
        return;
      }
      window.open(_buildGoogleMapsLink(lat, lng), "_blank", "noopener,noreferrer");
      return;
    }

    const resultBtn = el.closest(".nominatim-result");
    if (resultBtn) {
      const idx = Number.parseInt(resultBtn.dataset.idx || "", 10);
      const ridx = Number.parseInt(resultBtn.dataset.resultIdx || "", 10);
      const options = _centreSearchResults.get(idx) || [];
      const picked = options[ridx];
      if (!picked || !centreData[idx]) return;
      centreData[idx] = {
        ...centreData[idx],
        name: centreData[idx].name || picked.name || "",
        mapsUrl: _formatCoords(picked.lat, picked.lng) || picked.mapsUrl || centreData[idx].mapsUrl || "",
        lat: picked.lat,
        lng: picked.lng,
        address: picked.address || "",
      };
      _centreSearchResults.delete(idx);
      renderCentres();
      toast(`✓ Selected location for ${centreData[idx].name || "centre"}`, "success");
    }
  });

  function toCentreLocationsMap(list) {
    const map = {};
    for (const c of list || []) {
      const name = (c?.name || "").trim();
      if (!name) continue;
      map[name] = {
        lat: Number.isFinite(c.lat) ? c.lat : null,
        lng: Number.isFinite(c.lng) ? c.lng : null,
        address: c.address || null,
        mapsUrl: _isValidLatLng(Number(c.lat), Number(c.lng)) ? _formatCoords(c.lat, c.lng) : (c.mapsUrl || ""),
      };
    }
    return map;
  }

  function loadCentreLocations() {
    return new Promise((resolve) => {
      chrome.storage.local.get("centreLocations", (data) => {
        const raw = data.centreLocations || [];
        // Backward-compatible: support both array and map storage formats.
        centreData = Array.isArray(raw)
          ? raw.filter((c) => c && typeof c === "object")
          : Object.entries(raw)
              .filter(([name]) => Boolean(name))
              .map(([name, meta]) => ({
                name,
                mapsUrl: meta?.mapsUrl || "",
                lat: meta?.lat ?? null,
                lng: meta?.lng ?? null,
                address: meta?.address || null,
              }));
        // Backfill coords from mapsUrl for older entries that stored full map URLs.
        centreData = centreData.map((c) => {
          const hasCoords = _isValidLatLng(Number(c?.lat), Number(c?.lng));
          if (hasCoords) return c;
          const parsed = _extractLatLngFromText(c?.mapsUrl || "");
          if (!parsed) return c;
          return {
            ...c,
            lat: parsed.lat,
            lng: parsed.lng,
            mapsUrl: _formatCoords(parsed.lat, parsed.lng),
          };
        });
        renderCentres();
        resolve(centreData);
      });
    });
  }

  async function saveCentreLocations() {
    const centreLocations = toCentreLocationsMap(centreData);
    // Persist via background so DB centreProfiles are updated immediately.
    const res = await send({ type: "SAVE_CENTRE_LOCATIONS", centreLocations });
    if (!res?.ok) {
      // Fallback to local write so UX still works if background route fails.
      chrome.storage.local.set({ centreLocations });
    }
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
      // Discovery writes centres into storage; re-load from source of truth.
      const refreshed = await loadCentreLocations();
      toast(`✓ Found ${refreshed.length} centres`, "success");
    } else {
      toast("❌ Discovery failed", "error");
    }
  });

  $btnSaveLocations?.addEventListener("click", async () => {
    await saveCentreLocations();
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

  async function refreshFaceModelHealth() {
    const childId = $trainingChildSel?.value;
    if (!childId || !$faceModelHealthPanel) {
      if ($faceModelHealthPanel) $faceModelHealthPanel.innerHTML = "<em>Select a child to load model health…</em>";
      return;
    }
    const res = await send({ type: "GET_FACE_MODEL_HEALTH", childId });
    if (!res?.ok) {
      $faceModelHealthPanel.innerHTML = `<span style="color:#f87171;">Failed to load model health: ${res?.error || "Unknown error"}</span>`;
      return;
    }
    const h = res.health || {};
    const holdout = res.holdout || {};
    $faceModelHealthPanel.innerHTML = [
      `<div><strong>Descriptors:</strong> ${h.descriptorCount ?? 0} · <strong>Negative:</strong> ${h.negativeDescriptorCount ?? 0}</div>`,
      `<div><strong>Last model improvement:</strong> ${h.lastSelfImproveAt ? new Date(h.lastSelfImproveAt).toLocaleString() : "Never"}</div>`,
      `<div><strong>Recovered skipped photos:</strong> ${h.recoveredRejected ?? 0} · <strong>Sent for review:</strong> ${h.reviewedCandidates ?? 0}</div>`,
      `<div><strong>Confidence trend:</strong> ${h.confidenceTrend != null ? `${Math.round(h.confidenceTrend * 100)}%` : "N/A"}</div>`,
      `<div><strong>Holdout set:</strong> ${holdout?.sampleSize ?? holdout?.keys?.length ?? 0} items</div>`,
    ].join("");
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
      $trainingStatus.textContent = `📚 ${count} face example${count !== 1 ? "s" : ""} saved (max ${MAX_DESCRIPTORS_PER_CHILD})`;
    }
    updatePhaseIndicator();
    refreshFaceModelHealth();
  });

  $trainingFileInput?.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (!humanAvailable) {
      toast("Face review engine is not available", "error");
      return;
    }
    try {
      await loadModels();
    } catch (err) {
      toast(`❌ Face review engine failed to load: ${err.message}`, "error");
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

    if ($trainingProgress) $trainingProgress.textContent = `✓ ${pendingFiles.length} face${pendingFiles.length !== 1 ? "s" : ""} found — click Save to store`;
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
    toast("✓ Face training saved", "success");

    const rec = await getDescriptors(childId);
    const count = rec?.descriptors?.length || 0;
    if ($trainingStatus) {
      $trainingStatus.textContent = `📚 ${count} face example${count !== 1 ? "s" : ""} saved (max ${MAX_DESCRIPTORS_PER_CHILD})`;
    }
    const selfImprove = await send({ type: "SELF_IMPROVE_FACE_MODEL", childId, childName });
    if (selfImprove?.ok) {
      toast(
        `✓ Face review improved: checked ${selfImprove.checked}, recovered ${selfImprove.recoveredRejected} skipped, sent ${selfImprove.reviewedCandidates} to review`,
        "success",
        4500
      );
    }
    updatePhaseIndicator();
    refreshFaceModelHealth();
  });

  $btnExportProfile?.addEventListener("click", async () => {
    const childId = $trainingChildSel?.value;
    const childName = $trainingChildSel?.options[$trainingChildSel.selectedIndex]?.text || "";
    if (!childId) { toast("Select a child first", "error"); return; }

    const rec = await getDescriptors(childId);
    if (!rec || !rec.descriptors || rec.descriptors.length === 0) {
      toast("No face training to export", "error");
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
      toast(`✓ Imported ${data.descriptors.length} face examples`, "success");

      const rec = await getDescriptors(childId);
      const count = rec?.descriptors?.length || 0;
      if ($trainingStatus) {
        $trainingStatus.textContent = `📚 ${count} face example${count !== 1 ? "s" : ""} saved (max ${MAX_DESCRIPTORS_PER_CHILD})`;
      }
      const childName = $trainingChildSel?.options[$trainingChildSel.selectedIndex]?.text || "";
      const selfImprove = await send({ type: "SELF_IMPROVE_FACE_MODEL", childId, childName });
      if (selfImprove?.ok) {
        toast(
          `✓ Face review improved: checked ${selfImprove.checked}, recovered ${selfImprove.recoveredRejected} skipped, sent ${selfImprove.reviewedCandidates} to review`,
          "success",
          4500
        );
      }
      updatePhaseIndicator();
      refreshFaceModelHealth();
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
    if ($trainingStatus) $trainingStatus.textContent = "📚 0 face examples saved";
    if ($trainingProgress) $trainingProgress.textContent = "";
    toast("✓ Face data reset", "success");
    updatePhaseIndicator();
    refreshFaceModelHealth();
  });

  $btnRunFaceBootstrap?.addEventListener("click", async () => {
    const childId = $trainingChildSel?.value;
    const childName = $trainingChildSel?.options[$trainingChildSel.selectedIndex]?.text || "";
    if (!childId) {
      toast("Select a child first", "error");
      return;
    }
    $btnRunFaceBootstrap.disabled = true;
    $btnRunFaceBootstrap.textContent = "⏳ Building…";
    const res = await send({ type: "RUN_INITIAL_FACE_BOOTSTRAP", childId, childName });
    $btnRunFaceBootstrap.disabled = false;
    $btnRunFaceBootstrap.textContent = "🧱 Build Face Review Starting Point";
    if (res?.ok) {
      toast(`✓ Face review start complete: ${res.seededPositive || 0} prepared, ${res.queuedReview || 0} queued`, "success", 4500);
      refreshFaceModelHealth();
    } else {
      toast(`❌ ${res?.error || "Initial build failed"}`, "error");
    }
  });

  $btnRunSelfImproveNow?.addEventListener("click", async () => {
    const childId = $trainingChildSel?.value;
    const childName = $trainingChildSel?.options[$trainingChildSel.selectedIndex]?.text || "";
    if (!childId) {
      toast("Select a child first", "error");
      return;
    }
    $btnRunSelfImproveNow.disabled = true;
    $btnRunSelfImproveNow.textContent = "⏳ Running…";
    const res = await send({ type: "SELF_IMPROVE_FACE_MODEL", childId, childName });
    $btnRunSelfImproveNow.disabled = false;
    $btnRunSelfImproveNow.textContent = "🧠 Improve Face Review Now";
    if (res?.ok) {
      toast(`✓ Face review improve complete: recovered ${res.recoveredRejected || 0}, sent to review ${res.reviewedCandidates || 0}`, "success", 4500);
      refreshFaceModelHealth();
    } else {
      toast(`❌ ${res?.error || "Self-improve failed"}`, "error");
    }
  });

  $btnDecisionAuditSummary?.addEventListener("click", async () => {
    const childId = $trainingChildSel?.value;
    if (!childId) {
      toast("Select a child first", "error");
      return;
    }
    const res = await send({ type: "GET_DECISION_AUDIT_SUMMARY", childId });
    if (!res?.ok) {
      toast(`❌ ${res?.error || "Could not load summary"}`, "error");
      return;
    }
    const by = res.byDecision || {};
    const summary = Object.keys(by).sort().map((k) => `${k}: ${by[k]}`).join(" · ");
    toast(`✓ Decision summary (${res.total || 0}): ${summary || "No decisions yet"}`, "success", 6000);
  });

  // Rebuild pages & cards
  $btnGenerateStoryCardsAll?.addEventListener("click", async () => {
    const postNav = document.querySelector('.sidebar-nav .nav-btn[data-tab="post"]');
    postNav?.click();
    if ($storyCardsStatus) $storyCardsStatus.textContent = "Use Generate HTML / Cards in Post-Processing.";
    toast("↗ Opened Post-Processing", "success");
  });

  // Clear rejections
  $btnClearAllRejections?.addEventListener("click", async () => {
    if (!confirm("⚠ Clear all skipped-photo records? Previously skipped photos will be checked again on the next scan.")) return;
    $btnClearAllRejections.disabled = true;
    $btnClearAllRejections.textContent = "⏳ Clearing…";

    const res = await send({ type: "CLEAR_ALL_REJECTIONS" });

    $btnClearAllRejections.disabled = false;
    $btnClearAllRejections.textContent = "🔄 Reset All Skipped Photos";

    if (res?.ok) {
      if ($clearRejectionsStatus) $clearRejectionsStatus.textContent = `✅ Cleared ${res.count} skipped-photo records`;
      toast(`✓ ${res.count} skipped-photo records cleared`, "success");
    } else {
      if ($clearRejectionsStatus) $clearRejectionsStatus.textContent = "❌ " + (res?.error || "Failed");
      toast("❌ Failed to clear skipped-photo records", "error");
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

  $btnRunRetentionNow?.addEventListener("click", async () => {
    const maxDecisionEntries = Math.max(1000, Number($retentionDecisionMax?.value || 25000));
    const negativeMaxAgeDays = Math.max(30, Number($retentionNegativeDays?.value || 365));
    const fingerprintMaxAgeDays = Math.max(30, Number($retentionFingerprintDays?.value || 365));
    const res = await send({
      type: "RUN_RETENTION_MAINTENANCE",
      maxDecisionEntries,
      negativeMaxAgeDays,
      fingerprintMaxAgeDays,
    });
    if (res?.ok) {
      if ($debugLogStatus) {
        $debugLogStatus.textContent = `✓ Retention complete: decision removed ${res.decision?.removed || 0}, negatives ${res.face?.negativePruned || 0}, fingerprints ${res.face?.fingerprintsPruned || 0}`;
      }
      toast("✓ Retention maintenance completed", "success");
      refreshFaceModelHealth();
    } else {
      toast(`❌ ${res?.error || "Retention failed"}`, "error");
    }
  });

  // Export function for refreshing children lists
  window._loadSettingsChildren = loadSettingsChildren;

  function loadSettingsChildren() {
    send({ type: "GET_CHILDREN" }).then(async (res) => {
      if (!res?.ok) return;
      const children = res.children || [];
      const { childCentres = {} } = await chrome.storage.local.get("childCentres");

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
            const centres = Array.isArray(childCentres?.[String(c.id)]) ? childCentres[String(c.id)] : [];
            row.textContent = centres.length
              ? `👶 ${c.name} · Centres: ${centres.join(", ")}`
              : `👶 ${c.name}`;
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
    toast(`✓ ${GUIDED_STEP_LABELS.syncCheck}: child list refreshed from Storypark`, "success");
  });

  $btnSyncStoryparkInfo?.addEventListener("click", async () => {
    _syncInfoActive = true;
    $btnSyncStoryparkInfo.disabled = true;
    $btnSyncStoryparkInfo.textContent = "⏳ Syncing…";
    if ($syncStoryparkInfoStatus) {
      $syncStoryparkInfoStatus.textContent = `${GUIDED_STEP_LABELS.syncCheck}: sync in progress; time remaining is shown live.`;
    }
    const res = await send({ type: "SYNC_STORYPARK_INFORMATION" });
    $btnSyncStoryparkInfo.disabled = false;
    $btnSyncStoryparkInfo.textContent = "🗄 Sync from Storypark";
    _syncInfoActive = false;

    if (res?.ok) {
      const s = res.stats || {};
      if ($syncStoryparkInfoStatus) {
        $syncStoryparkInfoStatus.textContent =
          `${GUIDED_STEP_LABELS.syncCheck}: synced ${s.stories ?? 0} stories across ${s.children ?? 0} children.`;
      }
      toast(`✓ ${GUIDED_STEP_LABELS.syncCheck}: Storypark information synced`, "success");
      loadSettingsChildren();
      await loadCentreLocations();
    } else {
      if ($syncStoryparkInfoStatus) $syncStoryparkInfoStatus.textContent = `❌ ${res?.error || "Sync failed"}`;
      toast(`❌ ${GUIDED_STEP_LABELS.syncCheck}: Storypark sync failed`, "error");
    }
  });

  async function loadStoryparkSyncStatus() {
    const res = await send({ type: "GET_STORYPARK_SYNC_STATUS" });
    if (!res?.ok) return;
    if ($chkAutoStoryparkSync) $chkAutoStoryparkSync.checked = !!res.schedule?.enabled;
    if ($autoStoryparkSyncHours) $autoStoryparkSyncHours.value = String(res.schedule?.hours || 72);
    if ($syncStoryparkInfoStatus && res.state?.lastSuccessAt) {
      const t = new Date(res.state.lastSuccessAt).toLocaleString();
      $syncStoryparkInfoStatus.textContent = `${GUIDED_STEP_LABELS.syncCheck}: last completed sync ${t}`;
    }
  }

  async function saveStoryparkSyncSchedule() {
    const enabled = !!$chkAutoStoryparkSync?.checked;
    const hours = Math.max(24, Number($autoStoryparkSyncHours?.value || 72));
    const res = await send({ type: "SET_STORYPARK_SYNC_SCHEDULE", enabled, hours });
    if (!res?.ok) {
      toast("❌ Couldn't save auto-sync schedule", "error");
      return;
    }
    if ($syncStoryparkInfoStatus) {
      $syncStoryparkInfoStatus.textContent = enabled
        ? `${GUIDED_STEP_LABELS.syncCheck}: automatic sync is on (every ${hours} hours).`
        : `${GUIDED_STEP_LABELS.syncCheck}: automatic sync is off.`;
    }
  }

  $chkAutoStoryparkSync?.addEventListener("change", saveStoryparkSyncSchedule);
  $autoStoryparkSyncHours?.addEventListener("change", saveStoryparkSyncSchedule);

  async function refreshSyncHealth() {
    const res = await send({ type: "GET_STORYPARK_SYNC_HEALTH" });
    if (!res?.ok || !$storyparkSyncHealthPanel) return;
    const st = res.state || {};
    const h = res.health || {};
    const chk = st?.checkpoint;
    $storyparkSyncHealthPanel.style.display = "block";
    const lines = [
      `<div><strong>Status:</strong> ${st.inProgress ? "Running" : "Idle"}</div>`,
      `<div><strong>Last success:</strong> ${st.lastSuccessAt ? new Date(st.lastSuccessAt).toLocaleString() : "Never"}</div>`,
      `<div><strong>Checkpoint:</strong> ${chk ? `${chk.childName || chk.childId || "?"} · page ${chk.childPage || 0} · token ${chk.pageToken || "none"}` : "None"}</div>`,
      `<div><strong>Journal:</strong> ${h.journalEntries ?? 0} entries · retries ${h.retriesLast200 ?? 0} · warnings ${h.warningsLast200 ?? 0} · errors ${h.errorsLast200 ?? 0}</div>`,
      `<div><strong>Integrity report:</strong> ${h.integrityGeneratedAt ? new Date(h.integrityGeneratedAt).toLocaleString() : "Unavailable"}</div>`,
    ];
    try {
      const db = await send({ type: "ACTIVE_DATABASE_INFO" });
      const rows = db?.ok && Array.isArray(db.info?.byChild) ? db.info.byChild : [];
      if (rows.length) {
        const daycareLines = rows.map((c) => {
          const label = c.daycareLabel || "No daycare data yet";
          const note = c.daycareDedupeNote ? ` <span style="opacity:0.85">(${escHtml(c.daycareDedupeNote)})</span>` : "";
          return `• ${escHtml(c.childName || c.childId || "?")}: ${escHtml(label)}${note}`;
        });
        lines.push(
          `<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);"><strong>Per-child daycare (local manifests):</strong><br>${daycareLines.join("<br>")}</div>`,
        );
      }
    } catch {
      /* ignore */
    }
    $storyparkSyncHealthPanel.innerHTML = lines.join("");
  }

  $btnRefreshSyncHealth?.addEventListener("click", refreshSyncHealth);

  $btnResumeStoryparkSync?.addEventListener("click", async () => {
    $btnResumeStoryparkSync.disabled = true;
    $btnResumeStoryparkSync.textContent = "⏳ Resuming…";
    const res = await send({ type: "RESUME_STORYPARK_SYNC_NOW" });
    $btnResumeStoryparkSync.disabled = false;
    $btnResumeStoryparkSync.textContent = "▶ Resume Last Sync";
    if (res?.ok) {
      toast(`✓ ${GUIDED_STEP_LABELS.syncCheck}: resumed from checkpoint`, "success");
      refreshSyncHealth();
    } else {
      toast(`❌ ${GUIDED_STEP_LABELS.syncCheck}: ${res?.error || "Resume failed"}`, "error");
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!_syncInfoActive || !$syncStoryparkInfoStatus) return;
    if (msg?.type === "PROGRESS" && typeof msg?.childName === "string" && msg.childName.startsWith("Syncing ")) {
      const etaPart = msg.eta ? ` · ⏱ ${msg.eta} remaining` : "";
      $syncStoryparkInfoStatus.textContent = `${GUIDED_STEP_LABELS.syncCheck}: ${msg.current || 0}/${msg.total || 0}${etaPart}`;
    }
    if (msg?.type === "SCAN_COMPLETE") {
      _syncInfoActive = false;
    }
  });

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Collapse whitespace and escape for double-quoted HTML attributes (e.g. title=""). */
  function escAttr(s) {
    return String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function buildTemplateTokenTooltip(t) {
    const parts = [
      `${t.token} — ${t.friendlyLabel}.`,
      `Source field: ${t.rawFieldReference}.`,
      t.description,
      `If missing: ${t.nullableBehavior}.`,
      `Example: ${t.exampleValue}.`,
    ];
    if (t.diskAliasNote) parts.push(t.diskAliasNote);
    return parts.join(" ");
  }

  const TEMPLATE_COMMANDS = [
    {
      token: "[StoryTitle]",
      rawFieldReference: "storyTitle",
      friendlyLabel: "Story title",
      description: "The story headline from Storypark, shown on cards and in metadata when used. The [Title] alias is accepted with the same value.",
      nullableBehavior: "empty if missing",
      exampleValue: "Park Adventure",
      diskAliasNote: "Disk folder/file templates accept [StoryTitle] or [Title] interchangeably.",
    },
    {
      token: "[StoryBody]",
      rawFieldReference: "storyBody",
      friendlyLabel: "Story body",
      description: "Educator narrative with HTML stripped to plain text for safe embedding.",
      nullableBehavior: "empty if missing",
      exampleValue: "We explored the sensory table and read a story about…",
    },
    {
      token: "[Routine]",
      rawFieldReference: "routineText",
      friendlyLabel: "Routine summary",
      description: "Feeds, sleeps, and other routine lines when your centre records them.",
      nullableBehavior: "empty if unavailable",
      exampleValue: "10:00 Morning tea · 12:30 Sleep",
    },
    {
      token: "[ChildName]",
      rawFieldReference: "childName",
      friendlyLabel: "Child name",
      description: "Full name for the active child on this story. Alias [Child] uses the same value.",
      nullableBehavior: "empty if missing",
      exampleValue: "Alex Taylor",
      diskAliasNote: "Disk templates accept [ChildName] or [Child].",
    },
    {
      token: "[ChildAge]",
      rawFieldReference: "childAge",
      friendlyLabel: "Child age",
      description: "Human-readable age string from synced profile data when available.",
      nullableBehavior: "empty if unknown",
      exampleValue: "3 years 2 months",
    },
    {
      token: "[StoryDate]",
      rawFieldReference: "storyDate",
      friendlyLabel: "Story date",
      description: "Story date from the manifest (not the download day). The [Date] alias is accepted here with the same value.",
      nullableBehavior: "empty if missing",
      exampleValue: "2026-04-25",
      diskAliasNote: "Disk folder/file templates accept [StoryDate] or [Date] interchangeably.",
    },
    {
      token: "[Class]",
      rawFieldReference: "roomName",
      friendlyLabel: "Room / class",
      description: "Room or class label from the story or child profile. Alias [Room] uses the same value.",
      nullableBehavior: "empty if missing",
      exampleValue: "Kowhai Room",
      diskAliasNote: "Disk templates accept [Class] or [Room].",
    },
    {
      token: "[CentreName]",
      rawFieldReference: "centreName",
      friendlyLabel: "Centre / daycare",
      description: "Daycare or centre display name attached to the story. Aliases [Daycare] and [Centre] use the same value.",
      nullableBehavior: "empty if missing",
      exampleValue: "Storypark ELC",
      diskAliasNote: "Disk templates accept [CentreName], [Daycare], or [Centre].",
    },
    {
      token: "[EducatorName]",
      rawFieldReference: "educatorName",
      friendlyLabel: "Educator name",
      description: "Primary educator credited on the story when Storypark provides it. Alias [Educator] is the same value.",
      nullableBehavior: "empty if missing",
      exampleValue: "Aroha",
      diskAliasNote: "Disk templates accept [EducatorName] or [Educator].",
    },
    {
      token: "[PhotoCount]",
      rawFieldReference: "photoCount",
      friendlyLabel: "Photo count",
      description: "Number of approved photo files linked to the story for display in footers.",
      nullableBehavior: "0 when unknown",
      exampleValue: "8",
    },
  ];

  function insertTemplateToken(rawToken, targetOverride) {
    const target = String(targetOverride || $templateTargetMode?.value || "html").trim() || "html";
    const el = target === "card"
      ? $templateCardTitle
      : target === "exif"
        ? $templateExifTitle
        : $templateHtmlBody;
    if (!el) return;
    const token = String(rawToken || "");
    const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
    const v = el.value;
    el.value = `${v.slice(0, start)}${token}${v.slice(end)}`;
    el.focus();
    const pos = start + token.length;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* contenteditable or unsupported */
    }
  }

  function renderTemplateCommandHelp() {
    if (!$templateCommandHelp) return;
    const insertTitle = escAttr("Inserts this token at the cursor in the field chosen under Target (HTML body, Card title, or EXIF title).");
    $templateCommandHelp.innerHTML = TEMPLATE_COMMANDS.map((t) => {
      const dataTok = escAttr(t.token);
      const rowTip = escAttr(buildTemplateTokenTooltip(t));
      const aliasLine = t.diskAliasNote
        ? `<div style="font-size:10px;color:var(--muted);margin-top:2px;">${escHtml(t.diskAliasNote)}</div>`
        : "";
      return (
        `<div class="template-command-block" title="${rowTip}" style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.06);">` +
        `<div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;">` +
        `<code class="template-token-code" title="${rowTip}" style="min-width:140px;font-size:12px;">${escHtml(t.token)}</code>` +
        `<div class="template-command-body" title="${rowTip}" style="flex:1;min-width:180px;">` +
        `<div style="font-size:12px;color:var(--text);font-weight:600;">${escHtml(t.friendlyLabel)}` +
        ` <span style="font-weight:400;color:var(--muted);">(${escHtml(t.rawFieldReference)})</span></div>` +
        `<div style="font-size:11px;color:var(--muted);line-height:1.45;margin-top:3px;">${escHtml(t.description)}</div>` +
        `<div style="font-size:11px;color:var(--muted);margin-top:4px;">If missing: <em>${escHtml(t.nullableBehavior)}</em> · Example: <code>${escHtml(t.exampleValue)}</code></div>` +
        `${aliasLine}` +
        `</div>` +
        `<button type="button" class="btn-secondary template-insert-btn" data-token="${dataTok}" title="${insertTitle}" style="font-size:11px;padding:3px 10px;align-self:flex-start;">Insert</button>` +
        `</div>` +
        `</div>`
      );
    }).join("");
  }

  $templateCommandHelp?.addEventListener("click", (e) => {
    const btn = e.target.closest(".template-insert-btn");
    if (!btn || !$templateCommandHelp.contains(btn)) return;
    const tok = btn.getAttribute("data-token");
    if (tok) insertTemplateToken(tok);
  });

  $metadataTemplateCard?.addEventListener("click", (e) => {
    const chip = e.target.closest(".metadata-template-chip");
    if (!chip || !$metadataTemplateCard.contains(chip)) return;
    const tok = chip.getAttribute("data-token");
    const tgt = chip.getAttribute("data-insert-target");
    if (tok) insertTemplateToken(tok, tgt || undefined);
  });

  // Initial loads
  (async () => {
    const tmplRes = await send({ type: "GET_TEMPLATE_SETTINGS" });
    const t = tmplRes?.ok ? (tmplRes.settings || {}) : {};
    if ($templateHtmlBody) $templateHtmlBody.value = t.html?.body || "[StoryBody]";
    if ($templateCardTitle) $templateCardTitle.value = t.card?.title || "[StoryTitle]";
    if ($templateExifTitle) $templateExifTitle.value = t.exif?.title || "[ChildName] - [ChildAge]";
    if ($templateIncludeRoutine) $templateIncludeRoutine.checked = t.html?.includeRoutine ?? true;
    renderTemplateCommandHelp();
    if ($templateLimitsRef) {
      $templateLimitsRef.textContent =
        `Enforced caps: HTML body ≤${TEMPLATE_LIMITS.html} chars · Card title ≤${CARD_TITLE_MAX_CHARS} chars · EXIF title ≤${TEMPLATE_LIMITS.exifTitle} (ASCII-only); EXIF subject ≤${TEMPLATE_LIMITS.exifSubject}; EXIF comments ≤${TEMPLATE_LIMITS.exifComments}. Missing [Token] values become empty; delimiter cleanup runs after substitution.`;
    }
  })();

  $btnSaveTemplateSettings?.addEventListener("click", async () => {
    const settings = {
      html: {
        body: $templateHtmlBody?.value || "[StoryBody]",
        includeRoutine: !!$templateIncludeRoutine?.checked,
      },
      card: {
        title: $templateCardTitle?.value || "[StoryTitle]",
        includeRoutine: !!$templateIncludeRoutine?.checked,
      },
      exif: {
        title: $templateExifTitle?.value || "[ChildName] - [ChildAge]",
        includeRoutine: !!$templateIncludeRoutine?.checked,
      },
    };
    const res = await send({ type: "SAVE_TEMPLATE_SETTINGS", settings });
    if (res?.ok) {
      toast("✓ Template settings saved", "success");
      if ($templatePreviewStatus) $templatePreviewStatus.textContent = "Saved to Database/template_settings.json";
    } else {
      toast("❌ Failed to save template settings", "error");
    }
  });

  // Keep the face-model workflow explicit for parents: training data improves match quality over time.
  if ($trainingStatus && !$trainingStatus.textContent.trim()) {
    $trainingStatus.textContent = "Face Review gets better over time as you confirm photos and add training examples.";
  }

  $btnPreviewTemplates?.addEventListener("click", async () => {
    const preview = await send({
      type: "PREVIEW_TEMPLATE_SETTINGS",
      settings: {
        html: { body: $templateHtmlBody?.value || "[StoryBody]", includeRoutine: !!$templateIncludeRoutine?.checked },
        card: { title: $templateCardTitle?.value || "[StoryTitle]", includeRoutine: !!$templateIncludeRoutine?.checked },
        exif: { title: $templateExifTitle?.value || "[ChildName] - [ChildAge]" },
      },
      previewMode: $templatePreviewMode?.value || "brief",
      targetMode: $templateTargetMode?.value || "html",
    });
    if (!preview?.ok) return;
    if ($templatePreviewStatus) {
      const tf = preview?.truncationFlags || {};
      const truncBits = [tf.html && "HTML", tf.card && "Card", tf.exifTitle && "EXIF"].filter(Boolean).join(", ");
      const truncHint = truncBits ? ` · Truncated: ${truncBits}` : "";
      $templatePreviewStatus.textContent =
        `HTML ${preview.lengths.html}/${TEMPLATE_LIMITS.html} · Card ${preview.lengths.card}/${CARD_TITLE_MAX_CHARS} · EXIF title ${preview.lengths.exifTitle}/${TEMPLATE_LIMITS.exifTitle}${truncHint}`;
    }
    if ($templateLivePreviewPanel) {
      const source = preview?.source || "mock sample";
      const rawTemplate = preview?.rawTemplate || "(template unavailable)";
      const rendered = preview?.rendered || {};
      const sourceNotes = Array.isArray(preview?.sourceNotes) ? preview.sourceNotes.join(", ") : "n/a";
      const previewNotes = Array.isArray(preview?.previewNotes) ? preview.previewNotes.join(" ") : "";
      const tf = preview?.truncationFlags || {};
      const truncLine = (tf.html || tf.card || tf.exifTitle)
        ? `<div style="margin-top:6px;font-size:11px;color:var(--warning);"><strong>Length limits in this preview:</strong> ` +
          `${[tf.html && "HTML body", tf.card && "Card title", tf.exifTitle && "EXIF title"].filter(Boolean).join(", ")}</div>`
        : "";
      $templateLivePreviewPanel.innerHTML = [
        `<div><strong>Data source:</strong> ${escHtml(source)}</div>`,
        `<div><strong>Source notes:</strong> ${escHtml(sourceNotes)}</div>`,
        previewNotes ? `<div style="margin-top:6px;color:var(--muted);font-size:11px;">${escHtml(previewNotes)}</div>` : "",
        truncLine,
        `<div style="margin-top:6px;"><strong>Raw template (selected target)</strong><br><code>${escHtml(rawTemplate)}</code></div>`,
        `<div style="margin-top:6px;"><strong>Rendered HTML</strong><br><code>${escHtml(rendered.html || "")}</code></div>`,
        `<div style="margin-top:6px;"><strong>Rendered card title</strong><br><code>${escHtml(rendered.card || "")}</code></div>`,
        `<div style="margin-top:6px;"><strong>Rendered EXIF title</strong><br><code>${escHtml(rendered.exifTitle || "")}</code></div>`,
      ].join("");
    }
  });

  loadCentreLocations();
  loadSettingsChildren();
  loadStoryparkSyncStatus();
  refreshSyncHealth();
  updatePhaseIndicator();
  refreshFaceModelHealth();
}

export function loadSettingsChildren() {
  if (window._loadSettingsChildren) {
    window._loadSettingsChildren();
  }
}
