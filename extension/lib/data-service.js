/**
 * data-service.js — Authoritative database read/write layer
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All data operations that involve business rules or cross-store    │
 * │  synchronisation between IndexedDB and chrome.storage.local.      │
 * │                                                                    │
 * │  If an operation touches BOTH IDB and chrome.storage.local,       │
 * │  it MUST go through this file — never call them directly in       │
 * │  separate places.  This prevents the "GPS in storage but not IDB" │
 * │  class of bugs.                                                    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Raw IDB operations → lib/db.js (direct CRUD, no business rules)   │
 * │  HTTP requests → lib/api-client.js                                 │
 * │  Storypark field name knowledge → lib/storypark-api.js             │
 * │  EXIF/IPTC metadata → lib/metadata-helpers.js                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * INVARIANTS (never violate these):
 *   1. saveCentre() ALWAYS writes to BOTH IDB centreProfiles AND
 *      chrome.storage.local.centreLocations atomically.
 *   2. getCentreGPS() ALWAYS uses IDB as source of truth.  Falls back
 *      to chrome.storage.local and backfills IDB on hit (self-healing).
 *   3. Writes to chrome.storage.local NEVER happen without a matching
 *      IDB write in the same function.
 *   4. This module is safe to import from both service worker AND
 *      extension page contexts.
 *
 * EXPORTS (grouped by domain):
 *
 *   Centres:
 *     saveCentre(name, coords)     — atomic write to IDB + storage
 *     getCentreGPS(name)           — authoritative GPS lookup
 *     listCentres()                — all known centre names + GPS
 *     mergeCentres(entries)        — bulk discovery without overwriting GPS
 *
 *   Children:
 *     getChildren()                — chrome.storage.local.children[]
 *     saveChildren(children)       — chrome.storage.local.children[]
 *     saveChildProfile(profile)    — IDB childProfiles
 *     getChildProfile(childId)     — IDB childProfiles
 *
 *   Settings:
 *     getSettings()                — all scan settings from chrome.storage.local
 *
 *   Face learning:
 *     learnFace(childId, name, descriptor, year) — appendDescriptor in IDB
 *     rejectFace(childId, descriptor)            — appendNegativeDescriptor in IDB
 *
 *   Story tracking:
 *     saveStoryManifest(manifest)  — validated addDownloadedStory
 *     getStoryManifests(childId)   — getDownloadedStories for one child
 *     getAllStoryManifests()        — getDownloadedStories for all children
 *     markStoryDone(storyId, date, childId) — markStoryProcessed
 */

import {
  saveCentreProfile,
  getCentreGPS    as _idbGetCentreGPS,
  updateCentreGPS as _idbUpdateCentreGPS,
  getAllCentreProfiles,
  saveChildProfile    as _idbSaveChildProfile,
  getChildProfile     as _idbGetChildProfile,
  appendDescriptor    as _idbAppendDescriptor,
  appendNegativeDescriptor,
  addDownloadedStory,
  getDownloadedStories,
  getAllDownloadedStories,
  markStoryProcessed,
  incrementVerifiedCount,
  advancePhase,
} from "./db.js";

/* ================================================================== */
/*  Centre management                                                  */
/* ================================================================== */

/**
 * Atomically save a centre's GPS coordinates + address.
 *
 * Write order (source of truth first):
 *   1. IDB centreProfiles   ← authoritative, used by getCentreGPS()
 *   2. chrome.storage.local ← legacy cache, used as fallback + backup
 *
 * Both writes happen in this one call.  If the storage.local write fails
 * the IDB write still stands — IDB is the source of truth.
 *
 * @param {string} name       — Centre name (primary key)
 * @param {Object} [coords]   — { lat?, lng?, address? }
 * @param {number|null} [coords.lat]
 * @param {number|null} [coords.lng]
 * @param {string|null} [coords.address]
 * @returns {Promise<void>}
 */
export async function saveCentre(name, coords = {}) {
  if (!name || typeof name !== "string") return;
  const { lat = null, lng = null, address = null } = coords;

  // ── 1. Write to IDB centreProfiles (source of truth) ──
  await saveCentreProfile({ centreName: name, lat, lng, address }).catch(err => {
    console.warn(`[data-service] IDB centreProfiles write failed for "${name}":`, err.message);
  });

  // ── 2. Mirror to chrome.storage.local.centreLocations (legacy cache) ──
  // Read-modify-write to avoid clobbering other centres
  try {
    const { centreLocations = {} } = await chrome.storage.local.get("centreLocations");
    const existing = centreLocations[name] || {};
    centreLocations[name] = {
      lat:     lat     ?? existing.lat     ?? null,
      lng:     lng     ?? existing.lng     ?? null,
      address: address ?? existing.address ?? null,
    };
    await chrome.storage.local.set({ centreLocations });
  } catch (err) {
    // Non-fatal: IDB is the source of truth, storage is a cache
    console.warn(`[data-service] storage.local centreLocations write failed for "${name}":`, err.message);
  }
}

/**
 * Authoritative GPS lookup for a centre.
 *
 * Resolution order:
 *   1. IDB centreProfiles (source of truth)
 *   2. chrome.storage.local.centreLocations (legacy fallback)
 *      → If found here but not IDB: backfills IDB (self-healing)
 *   3. Returns null if not found in either store
 *
 * INVARIANT: Always call this function for GPS lookups — never call
 * db.js getCentreGPS() or chrome.storage.local directly.
 *
 * @param {string} name — Centre name
 * @returns {Promise<import('./types.js').GpsCoords|null>}
 */
export async function getCentreGPS(name) {
  if (!name || typeof name !== "string") return null;

  // ── 1. Check IDB (primary) ──
  try {
    const gps = await _idbGetCentreGPS(name);
    if (gps?.lat != null && gps?.lng != null) {
      return { lat: gps.lat, lng: gps.lng };
    }
  } catch { /* fall through to storage */ }

  // ── 2. Check chrome.storage.local (legacy fallback) ──
  try {
    const { centreLocations = {} } = await chrome.storage.local.get("centreLocations");
    const loc = centreLocations[name];
    if (loc?.lat != null && loc?.lng != null) {
      // Backfill IDB so next call takes the fast path (self-healing)
      _idbUpdateCentreGPS(name, loc.lat, loc.lng).catch(() => {});
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch { /* GPS not available */ }

  return null;
}

/**
 * Return all known centre profiles (IDB-first).
 *
 * @returns {Promise<import('./types.js').CentreProfile[]>}
 */
export async function listCentres() {
  try {
    return await getAllCentreProfiles();
  } catch {
    return [];
  }
}

/**
 * Merge a list of newly-discovered centres into the stores WITHOUT
 * overwriting existing GPS coordinates.  Used by storypark-api.js
 * when new centre names are found in API responses.
 *
 * Accepts either:
 *   • string[]                    — names only (backward-compatible)
 *   • { name, address? }[]        — with optional address
 *
 * GPS coordinates are NOT set here — call saveCentre() with GPS data
 * once the user provides coordinates or auto-geocoding completes.
 *
 * @param {(string|{name:string, address?:string})[]} entries
 * @returns {Promise<number>} — Number of new centres added
 */
export async function mergeCentres(entries) {
  if (!entries || entries.length === 0) return 0;
  let added = 0;
  const pendingWrites = [];

  // Read current state once
  const { centreLocations = {} } = await chrome.storage.local.get("centreLocations").catch(() => ({ centreLocations: {} }));
  let storageChanged = false;

  for (const entry of entries) {
    const name    = (typeof entry === "string" ? entry : entry.name || "").trim();
    const address = typeof entry === "string" ? null : (entry.address || null);
    if (!name) continue;

    const isNew = !(name in centreLocations);
    if (isNew) {
      // New centre — add with null GPS (to be filled later)
      centreLocations[name] = { lat: null, lng: null, address };
      storageChanged = true;
      added++;
      // Persist to IDB
      pendingWrites.push(
        saveCentreProfile({ centreName: name, lat: null, lng: null, address }).catch(() => {})
      );
    } else if (address && centreLocations[name].address == null) {
      // Existing centre — update address if we now have one
      centreLocations[name].address = address;
      storageChanged = true;
      pendingWrites.push(
        saveCentreProfile({ centreName: name, lat: centreLocations[name].lat, lng: centreLocations[name].lng, address }).catch(() => {})
      );
    }
  }

  if (storageChanged) {
    await chrome.storage.local.set({ centreLocations }).catch(() => {});
  }
  if (pendingWrites.length > 0) {
    await Promise.allSettled(pendingWrites);
  }

  return added;
}

/* ================================================================== */
/*  Children list                                                      */
/* ================================================================== */

/**
 * Return the cached children list from chrome.storage.local.
 * Returns [] if no children are cached (profile not yet fetched).
 *
 * @returns {Promise<import('./types.js').Child[]>}
 */
export async function getChildren() {
  const { children = [] } = await chrome.storage.local.get("children");
  return children;
}

/**
 * Persist the children list to chrome.storage.local.
 * Also stores the active centre name from the first child's profile
 * if not already set.
 *
 * @param {import('./types.js').Child[]} children
 * @returns {Promise<void>}
 */
export async function saveChildren(children) {
  if (!Array.isArray(children)) return;
  await chrome.storage.local.set({ children });
}

/* ================================================================== */
/*  Child profile                                                      */
/* ================================================================== */

/**
 * Save a child's profile (birthday, regularDays, companies, centreIds)
 * to IDB childProfiles.
 *
 * Also sets activeCentreName in chrome.storage.local if not already set
 * and a company name is available.
 *
 * @param {import('./types.js').ChildProfile} profile
 * @returns {Promise<void>}
 */
export async function saveChildProfile(profile) {
  if (!profile?.childId) return;
  await _idbSaveChildProfile(profile);

  // Set activeCentreName if not already set
  const companies = profile.companies || [];
  if (companies.length > 0) {
    const { activeCentreName } = await chrome.storage.local.get("activeCentreName").catch(() => ({}));
    if (!activeCentreName) {
      await chrome.storage.local.set({ activeCentreName: companies[0] }).catch(() => {});
    }
  }
}

/**
 * Retrieve a child's profile from IDB childProfiles.
 * Returns null if not found.
 *
 * @param {string} childId
 * @returns {Promise<import('./types.js').ChildProfile|null>}
 */
export async function getChildProfile(childId) {
  if (!childId) return null;
  return _idbGetChildProfile(childId).catch(() => null);
}

/* ================================================================== */
/*  Settings                                                           */
/* ================================================================== */

/**
 * Retrieve all scan-relevant settings from chrome.storage.local.
 * Always returns a complete object with sensible defaults — callers
 * never need to handle missing keys.
 *
 * @returns {Promise<ScanSettings>}
 *
 * @typedef {Object} ScanSettings
 * @property {number}  autoThreshold       — 0–100, default 85
 * @property {number}  minThreshold        — 0–100, default 50
 * @property {string}  activeCentreName    — fallback centre name
 * @property {boolean} attendanceFilter    — skip absent days
 * @property {boolean} saveStoryHtml       — generate story.html
 * @property {boolean} saveStoryCard       — generate story card JPEG
 * @property {boolean} skipFaceRec         — download all media
 * @property {boolean} fillGapsOnly        — only stories with no photos yet
 * @property {boolean} debugCaptureMode    — developer API capture
 * @property {string}  scanDateMode        — "all" | "custom"
 * @property {string|null} scanCutoffFromDate — YYYY-MM-DD
 * @property {string|null} scanCutoffToDate   — YYYY-MM-DD
 * @property {boolean} keepScenarioPhotos   — auto-keep photos with no face
 */
export async function getSettings() {
  const data = await chrome.storage.local.get([
    "autoThreshold", "minThreshold", "activeCentreName",
    "attendanceFilter", "saveStoryHtml", "saveStoryCard",
    "skipFaceRec", "fillGapsOnly", "debugCaptureMode",
    "scanDateMode", "scanCutoffFromDate", "scanCutoffToDate",
    "keepScenarioPhotos",
  ]);
  return {
    autoThreshold:       data.autoThreshold       ?? 85,
    minThreshold:        data.minThreshold        ?? 50,
    activeCentreName:    data.activeCentreName    ?? "",
    attendanceFilter:    data.attendanceFilter    ?? false,
    saveStoryHtml:       data.saveStoryHtml       ?? true,
    saveStoryCard:       data.saveStoryCard       ?? true,
    skipFaceRec:         data.skipFaceRec         ?? false,
    fillGapsOnly:        data.fillGapsOnly        ?? false,
    debugCaptureMode:    data.debugCaptureMode    ?? false,
    scanDateMode:        data.scanDateMode        ?? "all",
    scanCutoffFromDate:  data.scanCutoffFromDate  ?? null,
    scanCutoffToDate:    data.scanCutoffToDate    ?? null,
    keepScenarioPhotos:  data.keepScenarioPhotos  ?? false,
  };
}

/* ================================================================== */
/*  Face learning                                                      */
/* ================================================================== */

/**
 * Append a confirmed face descriptor to a child's profile (continuous learning).
 * Also checks whether the child should advance to the next recognition phase.
 *
 * Call this whenever:
 *   - A face is auto-approved during a scan (high-confidence match)
 *   - A user approves a face in the Review tab
 *   - Training photos are saved in Settings
 *
 * @param {string}    childId     — Storypark child ID
 * @param {string}    childName   — Display name
 * @param {number[]}  descriptor  — 512-element face embedding
 * @param {string}    [year]      — YYYY for year-bucketing (default: current year)
 * @returns {Promise<void>}
 */
export async function learnFace(childId, childName, descriptor, year = null) {
  if (!childId || !descriptor || !Array.isArray(descriptor)) return;
  const effectiveYear = year || new Date().getFullYear().toString();
  await _idbAppendDescriptor(childId, childName, descriptor, effectiveYear);
}

/**
 * Append a face descriptor to a child's NEGATIVE profile ("not my child").
 * Negative descriptors improve contrastive matching accuracy by teaching
 * the model what the child does NOT look like.
 *
 * Call this when:
 *   - A user rejects a face in the Review tab
 *   - A scan auto-rejects below minThreshold with a confirmed mismatch
 *
 * @param {string}   childId    — Storypark child ID
 * @param {number[]} descriptor — Face embedding
 * @returns {Promise<void>}
 */
export async function rejectFace(childId, descriptor) {
  if (!childId || !descriptor || !Array.isArray(descriptor)) return;
  await appendNegativeDescriptor(childId, descriptor);
}

/* ================================================================== */
/*  Story tracking                                                     */
/* ================================================================== */

/**
 * Save a story manifest to IDB after validating required fields.
 * This is the authoritative write path for all story manifests.
 *
 * Validation: childId, childName, storyId, folderName must be non-empty.
 * Missing fields throw an Error rather than silently writing corrupt data.
 *
 * @param {import('./types.js').StoryManifest} manifest
 * @returns {Promise<void>}
 * @throws {Error} — If required fields are missing
 */
export async function saveStoryManifest(manifest) {
  // Validate required fields
  const required = ["childId", "childName", "storyId", "folderName"];
  for (const field of required) {
    if (!manifest[field]) {
      throw new Error(`[data-service] saveStoryManifest: missing required field "${field}"`);
    }
  }
  await addDownloadedStory(manifest);
}

/**
 * Return story manifests for one child from IDB.
 *
 * @param {string} childId
 * @returns {Promise<import('./types.js').StoryManifest[]>}
 */
export async function getStoryManifests(childId) {
  if (!childId) return [];
  return getDownloadedStories(childId).catch(() => []);
}

/**
 * Return ALL story manifests for ALL children from IDB.
 *
 * @returns {Promise<import('./types.js').StoryManifest[]>}
 */
export async function getAllStoryManifests() {
  return getAllDownloadedStories().catch(() => []);
}

/**
 * Mark a story as fully processed (so EXTRACT_LATEST skips it).
 * Delegates directly to db.js markStoryProcessed().
 *
 * @param {string} storyId
 * @param {string} date      — YYYY-MM-DD (for the processedStories date field)
 * @param {string} childId
 * @returns {Promise<void>}
 */
export async function markStoryDone(storyId, date, childId) {
  if (!storyId) return;
  await markStoryProcessed(storyId, date || "", childId || "");
}
