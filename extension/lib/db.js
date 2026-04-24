/**
 * lib/db.js – IndexedDB helper for persistence.
 *
 * Object stores:
 *  - processedUrls    : out-of-line key (URL string) → 1  (dedup ledger)
 *  - processedStories : keyPath=storyId → { storyId, date, childId }
 *  - reviewQueue      : autoIncrement → { croppedFaceDataUrl, descriptor,
 *                         storyData, description, childId, childName,
 *                         savePath, matchPct, matchedChildren }
 *  - knownDescriptors : keyPath=childId → { childId, childName, descriptors: number[][] }
 *
 * All functions are async and safe to call from the service worker.
 */

const DB_NAME    = "storyparkSyncDB";
const DB_VERSION = 12; // v12: fileMovements store (file location tracking)

/** Maximum number of face descriptors kept per child (global fallback). */
export const MAX_DESCRIPTORS_PER_CHILD = 1000;

/** Maximum number of face descriptors kept per year per child. */
const MAX_DESCRIPTORS_PER_YEAR = 100;

const STORE_PROCESSED_URLS    = "processedUrls";
const STORE_PROCESSED_STORIES = "processedStories";
const STORE_REVIEW_QUEUE      = "reviewQueue";
const STORE_KNOWN_DESCRIPTORS = "knownDescriptors";
const STORE_CHILD_PHASES      = "childPhases";
const STORE_REJECTED_IMAGES   = "rejectedImages";
const STORE_PENDING_DOWNLOADS = "pendingDownloads";
const STORE_DOWNLOADED_STORIES = "downloadedStories";
const STORE_NEGATIVE_DESCRIPTORS = "negativeDescriptors";
const STORE_SCAN_CHECKPOINTS = "scanCheckpoints";
const STORE_IMAGE_FINGERPRINTS = "imageFingerprints";
const STORE_STORY_CACHE = "storyCache";
const STORE_LINKED_FOLDER = "linkedFolder";
const STORE_CHILD_PROFILES    = "childProfiles";
const STORE_CENTRE_PROFILES   = "centreProfiles";
const STORE_EDUCATORS         = "educators";
const STORE_FILE_SYSTEM_STATE = "fileSystemState";
const STORE_FILE_MOVEMENTS    = "fileMovements";   // v12: file location tracking

/* ================================================================== */
/*  File-based storage — Database/ folder inside the linked folder     */
/*                                                                     */
/*  Heavy stores (descriptors, fingerprints, manifests) are written as */
/*  JSON files in Database/ to avoid bloating Chrome's IndexedDB.      */
/*  IDB is retained as a small fallback (linked folder handle + small  */
/*  bounded stores).  Migrates automatically on first use.             */
/* ================================================================== */

const _DB_FOLDER         = "Database";
const _DB_FILE_DESCS     = "descriptors.json";
const _DB_FILE_NEG_DESCS = "negative_descriptors.json";
const _DB_FILE_PRINTS    = "fingerprints.json";
const _DB_FILE_MANIFESTS = "manifests.json";
const _DB_FILE_REJECTIONS = "rejections.json";   // v2.3: persisted rejection ledger

/** Session-level in-memory cache — cleared on service worker restart. */
const _fileCache = {
  descriptors:    null,   // { [childId]: record }
  negDescriptors: null,   // { [childId]: record }
  fingerprints:   null,   // { [key]: record }
  manifests:      null,   // { [key]: manifest }
  rejections:     null,   // { [storyId_imageUrl]: 1 }  v2.3
};

/** Get or create the Database/ folder inside the linked folder. */
async function _getDbFolder() {
  try {
    const root = await getLinkedFolderHandle();
    if (!root) return null;
    return await root.getDirectoryHandle(_DB_FOLDER, { create: true });
  } catch { return null; }
}

/** Read a JSON file from Database/. Returns null on any error. */
async function _readDbFile(filename) {
  try {
    const folder = await _getDbFolder();
    if (!folder) return null;
    const fh = await folder.getFileHandle(filename);
    return JSON.parse(await (await fh.getFile()).text());
  } catch { return null; }
}

/** Write data as JSON to Database/filename. Returns true on success. */
async function _writeDbFile(filename, data) {
  try {
    const folder = await _getDbFolder();
    if (!folder) return false;
    const fh = await folder.getFileHandle(filename, { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(data));
    await w.close();
    return true;
  } catch { return false; }
}

/* Cache loaders — read once per session, then use in-memory copy */
async function _loadDescriptors() {
  if (_fileCache.descriptors !== null) return _fileCache.descriptors;
  _fileCache.descriptors = (await _readDbFile(_DB_FILE_DESCS)) || {};
  return _fileCache.descriptors;
}
async function _loadNegDescriptors() {
  if (_fileCache.negDescriptors !== null) return _fileCache.negDescriptors;
  _fileCache.negDescriptors = (await _readDbFile(_DB_FILE_NEG_DESCS)) || {};
  return _fileCache.negDescriptors;
}
async function _loadFingerprints() {
  if (_fileCache.fingerprints !== null) return _fileCache.fingerprints;
  _fileCache.fingerprints = (await _readDbFile(_DB_FILE_PRINTS)) || {};
  return _fileCache.fingerprints;
}
async function _loadManifests() {
  if (_fileCache.manifests !== null) return _fileCache.manifests;
  _fileCache.manifests = (await _readDbFile(_DB_FILE_MANIFESTS)) || {};
  // Lazy-migrate each manifest to schema v2 on first read (adds missing
  // fields with safe defaults). Applied in-memory only — disk is updated
  // the next time addDownloadedStory() writes. Old manifests continue to
  // work; new fields unlock richer repair/audit behaviour.
  for (const key of Object.keys(_fileCache.manifests)) {
    _fileCache.manifests[key] = _lazyMigrateManifest(_fileCache.manifests[key]);
  }
  return _fileCache.manifests;
}

/** Load the persisted rejection ledger. Primary: Database/rejections.json. */
async function _loadRejections() {
  if (_fileCache.rejections !== null) return _fileCache.rejections;
  _fileCache.rejections = (await _readDbFile(_DB_FILE_REJECTIONS)) || {};
  return _fileCache.rejections;
}

/* ================================================================== */
/*  Active Database info — for "📂 Active Database" settings panel     */
/*                                                                     */
/*  Tells the dashboard exactly where the source-of-truth JSON files   */
/*  live.  Returns the linked-folder name (if any), the presence +     */
/*  byte-size of each expected Database/*.json file, and the most      */
/*  recent modification timestamp across them.                         */
/* ================================================================== */

/**
 * Describe the active Database/ folder: linked-folder name, per-file
 * presence/size/timestamp for the 5 core JSON files, and an overall
 * "last updated" timestamp (ISO).
 *
 * Returns `{ linkedFolderName: null, files: [], lastUpdated: null }`
 * when the folder has not been linked yet (the IDB fallback is active).
 *
 * @returns {Promise<{
 *   linkedFolderName: string|null,
 *   folderPath: string|null,
 *   files: Array<{ name: string, exists: boolean, sizeBytes: number, lastModified: string|null }>,
 *   lastUpdated: string|null,
 * }>}
 */
export async function getActiveDatabaseInfo() {
  const files = [
    { name: _DB_FILE_MANIFESTS, exists: false, sizeBytes: 0, lastModified: null },
    { name: _DB_FILE_DESCS,     exists: false, sizeBytes: 0, lastModified: null },
    { name: _DB_FILE_NEG_DESCS, exists: false, sizeBytes: 0, lastModified: null },
    { name: _DB_FILE_PRINTS,    exists: false, sizeBytes: 0, lastModified: null },
    { name: _DB_FILE_REJECTIONS,exists: false, sizeBytes: 0, lastModified: null },
  ];
  let linkedFolderName = null;
  let folderPath = null;
  let lastUpdated = null;

  try {
    const root = await getLinkedFolderHandle();
    if (!root) {
      return { linkedFolderName: null, folderPath: null, files, lastUpdated: null };
    }
    linkedFolderName = root.name;
    folderPath = `${root.name}/${_DB_FOLDER}`;
    let folder;
    try {
      folder = await root.getDirectoryHandle(_DB_FOLDER, { create: false });
    } catch {
      // Database/ folder doesn't exist yet — nothing written to disk
      return { linkedFolderName, folderPath, files, lastUpdated: null };
    }

    for (const record of files) {
      try {
        const fh = await folder.getFileHandle(record.name);
        const f  = await fh.getFile();
        record.exists       = true;
        record.sizeBytes    = f.size || 0;
        const lm            = f.lastModified ? new Date(f.lastModified).toISOString() : null;
        record.lastModified = lm;
        if (lm && (!lastUpdated || lm > lastUpdated)) lastUpdated = lm;
      } catch { /* file not found — leave defaults */ }
    }
  } catch {
    /* never throw — this is an info call; the UI handles null fields */
  }

  return { linkedFolderName, folderPath, files, lastUpdated };
}

/**
 * Eager-load the hot file caches (manifests + rejections) so the very first
 * caller doesn't block on disk I/O.  Called from background.js on service
 * worker startup.  Safe to call multiple times — the _load* helpers memoise.
 *
 * Returns the counts that were loaded so the SW can log them.
 *
 * @returns {Promise<{manifests: number, rejections: number, descriptors: number, negative: number, fingerprints: number}>}
 */
export async function eagerLoadHotCaches() {
  const out = { manifests: 0, rejections: 0, descriptors: 0, negative: 0, fingerprints: 0 };
  try { out.manifests      = Object.keys(await _loadManifests()).length;      } catch {}
  try { out.rejections     = Object.keys(await _loadRejections()).length;     } catch {}
  try { out.descriptors    = Object.keys(await _loadDescriptors()).length;    } catch {}
  try { out.negative       = Object.keys(await _loadNegDescriptors()).length; } catch {}
  try { out.fingerprints   = Object.keys(await _loadFingerprints()).length;   } catch {}
  return out;
}

/**
 * Rebuild the rejection ledger from whatever files are currently in the
 * "{Child} Rejected Matches/Stories/…" folders on disk.  Used when
 * rejections.json is missing (e.g. user restored only the photo folders)
 * and the manifest's rejectedFilenames[] list alone isn't enough — we walk
 * the actual disk contents to figure out which images were rejected.
 *
 * For every rejected file on disk we:
 *   1. Look up the owning manifest by matching `folderName` segment
 *   2. Find the original image URL (from mediaUrls[] matching filename)
 *   3. Write a rejection record to Database/rejections.json
 *
 * This is intentionally called by the dashboard / audit code (which has
 * FileSystemDirectoryHandle access) rather than the SW — we only accept
 * a pre-walked `{ [childName]: { [folderName]: string[] } }` map here so
 * db.js stays service-worker-safe.
 *
 * @param {Object} allManifests  Keyed { [childName]: { [folderName]: manifest } }
 * @param {Object} rejectedFilesByChild  { [childName]: { [folderName]: string[] filenames } }
 * @returns {Promise<number>}  Number of rejection records written
 */
export async function rebuildRejectionsFromFolders(manifestsList, rejectedFilesByChild) {
  if (!rejectedFilesByChild || typeof rejectedFilesByChild !== "object") return 0;
  const cache = await _loadRejections();
  let added = 0;

  // Build folder lookup: childName → folderName → manifest
  const byChild = new Map();
  for (const m of manifestsList || []) {
    if (!m?.childName || !m?.folderName) continue;
    if (!byChild.has(m.childName)) byChild.set(m.childName, new Map());
    byChild.get(m.childName).set(m.folderName, m);
  }

  for (const [childName, byFolder] of Object.entries(rejectedFilesByChild)) {
    const manifestLookup = byChild.get(childName);
    if (!manifestLookup) continue;
    for (const [folderName, filenames] of Object.entries(byFolder || {})) {
      const manifest = manifestLookup.get(folderName);
      if (!manifest) continue;
      const storyId = manifest.storyId;
      if (!storyId) continue;
      const urlByFilename = new Map();
      for (const mu of manifest.mediaUrls || []) {
        if (mu?.filename && mu?.originalUrl) urlByFilename.set(mu.filename, mu.originalUrl);
      }
      for (const filename of filenames || []) {
        const originalUrl = urlByFilename.get(filename);
        if (!originalUrl) continue;
        const key = `${storyId}_${originalUrl}`;
        if (!cache[key]) { cache[key] = 1; added++; }
        // Also mirror into manifest.rejectedFilenames so future HTML regen
        // skips the file.
        if (!Array.isArray(manifest.rejectedFilenames)) manifest.rejectedFilenames = [];
        if (!manifest.rejectedFilenames.includes(filename)) {
          manifest.rejectedFilenames.push(filename);
        }
      }
    }
  }

  if (added > 0) {
    await _writeDbFile(_DB_FILE_REJECTIONS, cache);
    // Also persist updated manifests (rejectedFilenames list additions)
    const mCache = await _loadManifests();
    for (const m of manifestsList || []) {
      const k = m.key || `${m.childId}_${m.storyId}`;
      if (mCache[k]) mCache[k] = { ...mCache[k], rejectedFilenames: m.rejectedFilenames };
    }
    await _writeDbFile(_DB_FILE_MANIFESTS, mCache);
  }

  return added;
}


/* ================================================================== */
/*  Manifest schema v2 — lazy migration on read                        */
/*                                                                     */
/*  v1 fields (pre-v2.3):                                              */
/*    childId, childName, storyId, storyTitle, storyDate,              */
/*    educatorName, roomName, centreName, folderName,                  */
/*    approvedFilenames[], mediaUrls[], thumbnailFilename,             */
/*    excerpt, storyBody, childAge, storyRoutine, key                  */
/*                                                                     */
/*  v2 fields (NEW — additive):                                        */
/*    rejectedFilenames[]  files moved to {Child} Rejected Matches/     */
/*    storyCardFilename    explicit name (fallback: "<date> - Story Card.jpg") */
/*    storyHtmlFilename    explicit name (fallback: "story.html")      */
/*    mediaTypes{}         filename → "image" | "video" (from extension) */
/*    savedAt              ISO timestamp of last manifest write        */
/*    schemaVersion        2                                           */
/*                                                                     */
/*  Migration is pure-function and idempotent. Every read passes every */
/*  old manifest through this function, so v2 fields appear to every   */
/*  caller even when disk still has a v1 record. The disk record is    */
/*  upgraded the next time addDownloadedStory() persists it.           */
/* ================================================================== */

/** Regex for detecting video files by extension. */
const _VIDEO_EXT_RE = /\.(mp4|mov|avi|webm|m4v|3gp|mkv)$/i;

/**
 * Lazy-migrate a single manifest record to schema v2 with safe defaults.
 * Returns a new object — never mutates the input.
 * Idempotent: records that are already v2 pass through unchanged.
 *
 * @param {Object} m  A manifest record (any schema version)
 * @returns {Object}  Manifest upgraded to schema v2
 */
function _lazyMigrateManifest(m) {
  if (!m || typeof m !== "object") return m;
  if (m.schemaVersion >= 2 && Array.isArray(m.rejectedFilenames) && m.mediaTypes) {
    return m; // already v2, no work needed
  }

  const approved = Array.isArray(m.approvedFilenames) ? m.approvedFilenames : [];
  const rejectedFilenames = Array.isArray(m.rejectedFilenames) ? m.rejectedFilenames : [];

  // Infer mediaTypes from extensions if not already present
  let mediaTypes = m.mediaTypes;
  if (!mediaTypes || typeof mediaTypes !== "object") {
    mediaTypes = {};
    for (const fname of approved) {
      mediaTypes[fname] = _VIDEO_EXT_RE.test(fname) ? "video" : "image";
    }
    for (const fname of rejectedFilenames) {
      if (!mediaTypes[fname]) {
        mediaTypes[fname] = _VIDEO_EXT_RE.test(fname) ? "video" : "image";
      }
    }
  }

  // Default storyCardFilename follows the established convention
  const storyCardFilename = m.storyCardFilename
    || (m.storyDate ? `${m.storyDate} - Story Card.jpg` : "");

  return {
    ...m,
    rejectedFilenames,
    storyCardFilename,
    storyHtmlFilename: m.storyHtmlFilename || "story.html",
    mediaTypes,
    savedAt: m.savedAt || new Date().toISOString(),
    schemaVersion: 2,
  };
}

/* ------------------------------------------------------------------ */
/*  DB open / upgrade                                                  */
/* ------------------------------------------------------------------ */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_PROCESSED_URLS)) {
        db.createObjectStore(STORE_PROCESSED_URLS);
      }
      if (!db.objectStoreNames.contains(STORE_PROCESSED_STORIES)) {
        db.createObjectStore(STORE_PROCESSED_STORIES, { keyPath: "storyId" });
      }
      if (!db.objectStoreNames.contains(STORE_REVIEW_QUEUE)) {
        db.createObjectStore(STORE_REVIEW_QUEUE, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_KNOWN_DESCRIPTORS)) {
        db.createObjectStore(STORE_KNOWN_DESCRIPTORS, { keyPath: "childId" });
      }
      if (!db.objectStoreNames.contains(STORE_CHILD_PHASES)) {
        db.createObjectStore(STORE_CHILD_PHASES, { keyPath: "childId" });
      }
      if (!db.objectStoreNames.contains(STORE_REJECTED_IMAGES)) {
        db.createObjectStore(STORE_REJECTED_IMAGES);  // out-of-line key: "storyId_imageUrl"
      }
      if (!db.objectStoreNames.contains(STORE_PENDING_DOWNLOADS)) {
        db.createObjectStore(STORE_PENDING_DOWNLOADS, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_DOWNLOADED_STORIES)) {
        const dlStore = db.createObjectStore(STORE_DOWNLOADED_STORIES, { keyPath: "key" });
        dlStore.createIndex("childId", "childId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_NEGATIVE_DESCRIPTORS)) {
        db.createObjectStore(STORE_NEGATIVE_DESCRIPTORS, { keyPath: "childId" });
      }
      if (!db.objectStoreNames.contains(STORE_SCAN_CHECKPOINTS)) {
        db.createObjectStore(STORE_SCAN_CHECKPOINTS, { keyPath: "childId" });
      }
      // v10: Add childId index to downloadedStories for efficient per-child queries
      //      (previously required a full cursor scan for every per-child lookup).
      if (event.oldVersion < 10 && db.objectStoreNames.contains(STORE_DOWNLOADED_STORIES)) {
        const store = event.target.transaction.objectStore(STORE_DOWNLOADED_STORIES);
        if (!store.indexNames.contains("childId")) {
          store.createIndex("childId", "childId", { unique: false });
        }
      }

      // v8: Face fingerprint cache — avoids re-downloading images on re-scans
      if (!db.objectStoreNames.contains(STORE_IMAGE_FINGERPRINTS)) {
        const fpStore = db.createObjectStore(STORE_IMAGE_FINGERPRINTS, { keyPath: "key" });
        fpStore.createIndex("childId", "childId", { unique: false });
      }
      // v8: Story metadata cache — avoids re-fetching story details on re-scans
      if (!db.objectStoreNames.contains(STORE_STORY_CACHE)) {
        db.createObjectStore(STORE_STORY_CACHE, { keyPath: "storyId" });
      }
      // v9: Linked download folder handle — persists the FileSystemDirectoryHandle
      // across sessions so the user only needs to grant folder permission once.
      if (!db.objectStoreNames.contains(STORE_LINKED_FOLDER)) {
        db.createObjectStore(STORE_LINKED_FOLDER);
      }

      // v11: Rich Storypark data stores — child profiles, centre GPS, educators,
      //      and per-file download state for crash-recovery integrity checks.
      if (!db.objectStoreNames.contains(STORE_CHILD_PROFILES)) {
        db.createObjectStore(STORE_CHILD_PROFILES, { keyPath: "childId" });
      }
      if (!db.objectStoreNames.contains(STORE_CENTRE_PROFILES)) {
        // keyPath=centreName allows O(1) lookup by name (the primary lookup key).
        db.createObjectStore(STORE_CENTRE_PROFILES, { keyPath: "centreName" });
      }
      if (!db.objectStoreNames.contains(STORE_EDUCATORS)) {
        // key = "childId_educatorId" for deduplication
        const eduStore = db.createObjectStore(STORE_EDUCATORS, { keyPath: "key" });
        eduStore.createIndex("childId", "childId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_FILE_SYSTEM_STATE)) {
        // keyPath=filePath — unique per file, supports upsert on re-download.
        // childId index allows per-child integrity checks without a full table scan.
        const fsStore = db.createObjectStore(STORE_FILE_SYSTEM_STATE, { keyPath: "filePath" });
        fsStore.createIndex("childId", "childId", { unique: false });
        fsStore.createIndex("storyId", "storyId", { unique: false });
      }

      // v12: File movement tracking — every file move is logged here.
      // autoIncrement id = cursor pagination key (never expose externally).
      // Indexes support: per-child query, per-type query (e.g. all "rejected"),
      //                  and efficient flush (only unflushed records).
      if (!db.objectStoreNames.contains(STORE_FILE_MOVEMENTS)) {
        const mvStore = db.createObjectStore(STORE_FILE_MOVEMENTS, { autoIncrement: true });
        mvStore.createIndex("by_child", "childId", { unique: false });
        mvStore.createIndex("by_type",  ["childId", "type"], { unique: false });
        mvStore.createIndex("unflushed", ["flushed", "ts"], { unique: false });
      }
    };

    req.onsuccess = (event) => resolve(event.target.result);
    req.onerror   = () => reject(req.error);
  });
}

/* ================================================================== */
/*  processedUrls                                                      */
/* ================================================================== */
// Note: The processedUrls object store is retained in the DB upgrade handler
// for compatibility with existing installations (DB version 2). The functions
// were unused and have been removed.

/* ================================================================== */
/*  processedStories                                                   */
/* ================================================================== */

/**
 * Return all processed story records.
 * @returns {Promise<Array<{storyId, date, childId}>>}
 */
export async function getProcessedStories() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_PROCESSED_STORIES, "readonly");
    const req = tx.objectStore(STORE_PROCESSED_STORIES).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Mark a story as fully processed.
 * @param {string} storyId
 * @param {string} date     ISO date string
 * @param {string} childId
 */
export async function markStoryProcessed(storyId, date, childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROCESSED_STORIES, "readwrite");
    tx.objectStore(STORE_PROCESSED_STORIES).put({ storyId, date, childId });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ================================================================== */
/*  downloadedStories — Per-child story manifest for index rebuilding  */
/* ================================================================== */

/**
 * Save or update a downloaded story manifest entry.
 * Key format: `${childId}_${storyId}`.
 *
 * @param {Object} manifest
 * @param {string} manifest.childId
 * @param {string} manifest.childName
 * @param {string} manifest.storyId
 * @param {string} manifest.storyTitle
 * @param {string} manifest.storyDate       YYYY-MM-DD
 * @param {string} [manifest.educatorName]
 * @param {string} [manifest.roomName]
 * @param {string} [manifest.centreName]
 * @param {string} manifest.folderName      e.g. "2026-04-17 — Friday fun"
 * @param {string[]} manifest.approvedFilenames
 * @param {string} [manifest.thumbnailFilename]  First photo (for index card)
 * @param {string} [manifest.excerpt]            First 200 chars of body
 */
/** Save or update a downloaded story manifest entry. Primary: Database/manifests.json */
export async function addDownloadedStory(manifest) {
  const key    = `${manifest.childId}_${manifest.storyId}`;
  const record = { ...manifest, key };
  // Primary: file cache
  const cache = await _loadManifests();
  cache[key]  = record;
  _writeDbFile(_DB_FILE_MANIFESTS, cache).catch(() => {});
  // Fallback: IDB
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOWNLOADED_STORIES, "readwrite");
    tx.objectStore(STORE_DOWNLOADED_STORIES).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Return manifests for a specific child. Primary: Database/manifests.json */
export async function getDownloadedStories(childId) {
  const cache    = await _loadManifests();
  const fromFile = Object.values(cache)
    .filter(m => m.childId === childId)
    .sort((a, b) => (b.storyDate || "").localeCompare(a.storyDate || ""));
  if (fromFile.length > 0) return fromFile;
  // Fallback: IDB
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_DOWNLOADED_STORIES, "readonly");
    const store = tx.objectStore(STORE_DOWNLOADED_STORIES);
    const req   = store.indexNames.contains("childId")
      ? store.index("childId").getAll(childId)
      : (() => { const items = []; const c = store.openCursor();
          c.onsuccess = e => { const cur = e.target.result; if (cur) { if (cur.value.childId === childId) items.push(cur.value); cur.continue(); } else resolve(items.sort((a,b)=>(b.storyDate||"").localeCompare(a.storyDate||""))); };
          c.onerror = () => reject(c.error); return null; })();
    if (req) {
      req.onsuccess = () => { db.close(); resolve((req.result||[]).sort((a,b)=>(b.storyDate||"").localeCompare(a.storyDate||""))); };
      req.onerror   = () => { db.close(); reject(req.error); };
    }
  });
}

/** Remove a filename from a story manifest. Updates both file and IDB. */
export async function removeFileFromStoryManifest(childId, storyId, filename) {
  const key   = `${childId}_${storyId}`;
  const cache = await _loadManifests();
  const _patch = (m) => {
    if (!m) return m;
    m.approvedFilenames = (m.approvedFilenames || []).filter(f => f !== filename);
    if (m.thumbnailFilename === filename) m.thumbnailFilename = m.approvedFilenames[0] || "";
    if (Array.isArray(m.mediaUrls)) m.mediaUrls = m.mediaUrls.filter(u => u.filename !== filename);
    return m;
  };
  if (cache[key]) { cache[key] = _patch(cache[key]); _writeDbFile(_DB_FILE_MANIFESTS, cache).catch(() => {}); }
  // Also update IDB fallback
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_DOWNLOADED_STORIES, "readwrite");
    const st  = tx.objectStore(STORE_DOWNLOADED_STORIES);
    const req = st.get(key);
    req.onsuccess = () => { const m = _patch(req.result); if (m) st.put(m); };
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Return all downloaded story manifests (all children). Primary: Database/manifests.json */
export async function getAllDownloadedStories() {
  const cache = await _loadManifests();
  if (Object.keys(cache).length > 0) return Object.values(cache);
  // Fallback: IDB (first run before migration)
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_DOWNLOADED_STORIES, "readonly");
    const req = tx.objectStore(STORE_DOWNLOADED_STORIES).getAll();
    req.onsuccess = async () => {
      db.close();
      const results = req.result || [];
      if (results.length > 0) {
        const obj = {};
        for (const m of results) obj[m.key || `${m.childId}_${m.storyId}`] = m;
        _fileCache.manifests = obj;
        _writeDbFile(_DB_FILE_MANIFESTS, obj).catch(() => {});
      }
      resolve(results);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/* ================================================================== */
/*  childPhases — 4-Phase adaptive face recognition tracking           */
/* ================================================================== */

/** Minimum verified descriptors required to advance from Phase 1 → 2. */
export const PHASE1_MIN_VERIFIED = 10;

/** Minimum verified descriptors required to advance from Phase 2 → 3. */
export const PHASE2_MIN_VERIFIED = 50;

/** Minimum verified descriptors required to advance from Phase 3 → 4. */
export const PHASE3_MIN_VERIFIED = 100;

/** Minimum model confidence (0-100) required to advance to Phase 4.
 *  Lowered from 80 to 70 — 100% confidence is mathematically impossible
 *  because internal consistency and verification rate have natural ceilings.
 *  70% is achievable with ~100 verified descriptors and decent consistency. */
export const PHASE4_MIN_CONFIDENCE = 70;

/**
 * Default phase record for a child with no phase data yet.
 * @param {string} childId
 * @returns {{childId: string, phase: number, verifiedCount: number, phase1Complete: boolean, phase2Complete: boolean}}
 */
function defaultPhaseRecord(childId) {
  return {
    childId,
    phase:          1,
    verifiedCount:  0,
    phase1Complete: false,
    phase2Complete: false,
  };
}

/**
 * Get the phase record for a child.
 * Returns the stored record, or a default Phase 1 record if none exists.
 *
 * @param {string} childId
 * @returns {Promise<{childId: string, phase: number, verifiedCount: number, phase1Complete: boolean, phase2Complete: boolean}>}
 */
export async function getChildPhase(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_CHILD_PHASES, "readonly");
    const req = tx.objectStore(STORE_CHILD_PHASES).get(childId);
    req.onsuccess = () => {
      db.close();
      resolve(req.result ?? defaultPhaseRecord(childId));
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return phase records for all children that have one.
 * @returns {Promise<Array<{childId, phase, verifiedCount, phase1Complete, phase2Complete}>>}
 */
export async function getAllChildPhases() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_CHILD_PHASES, "readonly");
    const req = tx.objectStore(STORE_CHILD_PHASES).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Upsert the phase record for a child.
 *
 * @param {string} childId
 * @param {Object} phaseData  Partial or full phase record (childId is forced).
 */
export async function setChildPhase(childId, phaseData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHILD_PHASES, "readwrite");
    tx.objectStore(STORE_CHILD_PHASES).put({ ...phaseData, childId });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Reset a child's phase to Phase 1 defaults.
 * Called when the user resets face data for a child.
 *
 * @param {string} childId
 */
export async function resetChildPhase(childId) {
  await setChildPhase(childId, defaultPhaseRecord(childId));
}

/**
 * Increment the verifiedCount for a child's phase record.
 * Creates a default Phase 1 record if none exists yet.
 *
 * @param {string} childId
 * @returns {Promise<{childId, phase, verifiedCount, phase1Complete, phase2Complete}>}
 */
export async function incrementVerifiedCount(childId) {
  const current = await getChildPhase(childId);
  current.verifiedCount = (current.verifiedCount || 0) + 1;
  await setChildPhase(childId, current);
  return current;
}

/**
 * Count how many review queue items belong to a specific child.
 *
 * @param {string} childId
 * @returns {Promise<number>}
 */
export async function getReviewQueueCountForChild(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_REVIEW_QUEUE, "readonly");
    const store = tx.objectStore(STORE_REVIEW_QUEUE);
    let count   = 0;

    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.childId === childId) count++;
        cursor.continue();
      } else {
        db.close();
        resolve(count);
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Compute a model confidence score (0–100) for a child's face recognition.
 *
 * Weighted average of:
 *   - Descriptor count  (40%): more training data = more reliable
 *   - Internal consistency (30%): avg pairwise cosine similarity among descriptors
 *   - Verification rate (30%): ratio of verifiedCount to total decisions
 *
 * @param {string} childId
 * @returns {Promise<{confidence: number, descriptorCount: number, consistency: number, details: string}>}
 */
export async function computeModelConfidence(childId) {
  const rec   = await getDescriptors(childId).catch(() => null);
  const phase = await getChildPhase(childId);
  const descs = rec?.descriptors || [];
  const count = descs.length;
  const verified = phase.verifiedCount || 0;

  // ── 1. Descriptor count score (0-100) ──
  let countScore;
  if (count === 0)       countScore = 0;
  else if (count < 10)   countScore = Math.round((count / 10) * 20);         // 0-20
  else if (count < 50)   countScore = 20 + Math.round(((count - 10) / 40) * 30); // 20-50
  else if (count < 100)  countScore = 50 + Math.round(((count - 50) / 50) * 25); // 50-75
  else                   countScore = 75 + Math.min(25, Math.round(((count - 100) / 200) * 25)); // 75-100

  // ── 2. Internal consistency score (0-100) ──
  // Sample up to 30 descriptors and compute average pairwise cosine similarity.
  let consistency = 0;
  if (count >= 2) {
    const sample = count <= 30 ? descs : descs.slice(-30); // use most recent
    let totalSim = 0;
    let pairs = 0;
    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        totalSim += _cosineSim(sample[i], sample[j]);
        pairs++;
      }
    }
    const avgSim = pairs > 0 ? totalSim / pairs : 0;
    // Map similarity (typically 0.5-1.0 range) to 0-100 score
    // < 0.5 = 0, 0.5 = 0, 0.7 = 50, 0.85 = 88, 1.0 = 100
    consistency = Math.max(0, Math.min(100, Math.round((avgSim - 0.5) * 200)));
  }

  // ── 3. Verification rate score (0-100) ──
  // Blended rate: human-verified descriptors count fully, auto-approved
  // descriptors (count - verified) count at 50% weight. This prevents
  // the score from dropping as auto-approved descriptors accumulate
  // during Phase 3+ scans — the model IS getting better, just not via
  // explicit human confirmation for every single photo.
  let verificationScore = 0;
  if (count > 0) {
    const autoApproved = Math.max(0, count - verified);
    const blendedVerified = verified + autoApproved * 0.5;
    const rate = Math.min(1, blendedVerified / count); // capped at 1.0
    verificationScore = Math.round(rate * 100);
  }

  // ── Weighted average ──
  const confidence = Math.round(
    countScore * 0.4 +
    consistency * 0.3 +
    verificationScore * 0.3
  );

  // ── Human-readable detail ──
  let details;
  if (confidence < 20)       details = "Building…";
  else if (confidence < 50)  details = "Learning";
  else if (confidence < 80)  details = "Good";
  else                       details = "Excellent";

  return { confidence, descriptorCount: count, consistency, verificationScore, details };
}

/** Internal cosine similarity for confidence calculation. */
function _cosineSim(a, b) {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA  += a[i] * a[i];
    nB  += b[i] * b[i];
  }
  const denom = Math.sqrt(nA) * Math.sqrt(nB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Check phase transition conditions and advance if met.
 *
 * 4-Phase transition rules:
 *   Phase 1 → 2:  queue empty  AND  verifiedCount >= 10
 *   Phase 2 → 3:  queue empty  AND  verifiedCount >= 50
 *   Phase 3 → 4:  queue empty  AND  verifiedCount >= 100  AND  confidence >= 80%
 *   Phase 4:      terminal (fully hands-off auto-download mode)
 *
 * @param {string} childId
 * @returns {Promise<{advanced: boolean, phase: object, confidence?: object}>}
 */
export async function advancePhase(childId) {
  const current       = await getChildPhase(childId);
  const queueCount    = await getReviewQueueCountForChild(childId);
  const queueEmpty    = queueCount === 0;
  let advanced = false;
  let confidenceData = null;

  if (current.phase === 1 && queueEmpty && current.verifiedCount >= PHASE1_MIN_VERIFIED) {
    current.phase          = 2;
    current.phase1Complete = true;
    advanced = true;
  } else if (current.phase === 2 && queueEmpty && current.verifiedCount >= PHASE2_MIN_VERIFIED) {
    current.phase          = 3;
    current.phase2Complete = true;
    advanced = true;
  } else if (current.phase === 3 && queueEmpty && current.verifiedCount >= PHASE3_MIN_VERIFIED) {
    // Phase 3 → 4 also requires model confidence >= 80%
    confidenceData = await computeModelConfidence(childId);
    if (confidenceData.confidence >= PHASE4_MIN_CONFIDENCE) {
      current.phase = 4;
      current.phase3Complete = true;
      advanced = true;
    }
  }

  if (advanced) {
    await setChildPhase(childId, current);
  }

  return { advanced, phase: current, confidence: confidenceData };
}

/* ================================================================== */
/*  reviewQueue                                                        */
/* ================================================================== */

/**
 * Return all items in the review queue (each with its auto-increment `id`).
 * @returns {Promise<Array>}
 */
export async function getReviewQueue() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_REVIEW_QUEUE, "readonly");
    const store = tx.objectStore(STORE_REVIEW_QUEUE);
    const items = [];

    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        items.push({ id: cursor.key, ...cursor.value });
        cursor.continue();
      } else {
        db.close();
        resolve(items);
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Fetch a single review queue item by its auto-increment key.
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
export async function getReviewQueueItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_REVIEW_QUEUE, "readonly");
    const req = tx.objectStore(STORE_REVIEW_QUEUE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Add an item to the review queue. Returns the new auto-increment key.
 * @param {Object} item
 * @returns {Promise<number>}
 */
export async function addToReviewQueue(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_REVIEW_QUEUE, "readwrite");
    const req = tx.objectStore(STORE_REVIEW_QUEUE).add(item);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Remove an item from the review queue by its auto-increment key.
 * @param {number} id
 */
export async function removeFromReviewQueue(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REVIEW_QUEUE, "readwrite");
    tx.objectStore(STORE_REVIEW_QUEUE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ================================================================== */
/*  knownDescriptors                                                   */
/* ================================================================== */

/**
 * Get all face descriptors for a child, or null if none stored.
 * @param {string} childId
 * @returns {Promise<{childId, childName, descriptors: number[][]}|null>}
 */
/** Get face descriptors for a child. Primary: Database/descriptors.json */
export async function getDescriptors(childId) {
  const cache = await _loadDescriptors();
  if (cache[childId]) return cache[childId];
  // Fallback: IDB
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_KNOWN_DESCRIPTORS, "readonly");
    const req = tx.objectStore(STORE_KNOWN_DESCRIPTORS).get(childId);
    req.onsuccess = async () => {
      db.close();
      if (req.result) { const c = await _loadDescriptors(); c[childId] = req.result; _writeDbFile(_DB_FILE_DESCS, c).catch(() => {}); }
      resolve(req.result ?? null);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Return all known-descriptor records (all children). */
export async function getAllDescriptors() {
  const cache = await _loadDescriptors();
  if (Object.keys(cache).length > 0) return Object.values(cache);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_KNOWN_DESCRIPTORS, "readonly");
    const req = tx.objectStore(STORE_KNOWN_DESCRIPTORS).getAll();
    req.onsuccess = async () => {
      db.close();
      const r = req.result || [];
      if (r.length > 0) { const o = {}; for (const x of r) o[x.childId] = x; _fileCache.descriptors = o; _writeDbFile(_DB_FILE_DESCS, o).catch(() => {}); }
      resolve(r);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Append a single face descriptor to a child's stored set, bucketed by year.
 * Each year's bucket is capped at MAX_DESCRIPTORS_PER_YEAR.
 * Primary: Database/descriptors.json  Fallback: IDB
 */
export async function appendDescriptor(childId, childName, descriptor, year = "unknown") {
  const cache    = await _loadDescriptors();
  const existing = cache[childId] ?? null;
  let descriptorsByYear = existing?.descriptorsByYear || {};
  if (existing?.descriptors && !existing.descriptorsByYear) descriptorsByYear["unknown"] = existing.descriptors;
  if (!descriptorsByYear[year]) descriptorsByYear[year] = [];
  descriptorsByYear[year].push(Array.from(descriptor));
  if (descriptorsByYear[year].length > MAX_DESCRIPTORS_PER_YEAR) {
    descriptorsByYear[year].splice(0, descriptorsByYear[year].length - MAX_DESCRIPTORS_PER_YEAR);
  }
  const flatDescriptors = Object.values(descriptorsByYear).flat();
  const record = { childId, childName, descriptorsByYear, descriptors: flatDescriptors };
  cache[childId] = record;
  _writeDbFile(_DB_FILE_DESCS, cache).catch(() => {});
  // Fallback: IDB
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KNOWN_DESCRIPTORS, "readwrite");
    tx.objectStore(STORE_KNOWN_DESCRIPTORS).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Alias kept for backwards compatibility. */
export const saveDescriptor = appendDescriptor;

/** Replace all face descriptors for a child. Primary: Database/descriptors.json */
export async function setDescriptors(childId, childName, descriptors) {
  const flat   = descriptors.map(d => Array.from(d));
  const record = { childId, childName, descriptors: flat, descriptorsByYear: { unknown: flat } };
  const cache  = await _loadDescriptors();
  cache[childId] = record;
  _writeDbFile(_DB_FILE_DESCS, cache).catch(() => {});
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KNOWN_DESCRIPTORS, "readwrite");
    tx.objectStore(STORE_KNOWN_DESCRIPTORS).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ================================================================== */
/*  rejectedImages — Prevent re-queuing of rejected photos             */
/* ================================================================== */

/**
 * Record that an image was rejected by the user during review.
 * Key format: "storyId_imageUrl" — unique per image per story.
 *
 * Dual-writes to Database/rejections.json (primary, portable) AND IDB
 * (fallback for pre-v2.3 profiles). Either side is sufficient to block
 * re-queuing, but the file path ensures the ledger survives Chrome-profile
 * resets and folder-copy restores.
 *
 * @param {string} storyId
 * @param {string} imageUrl  The original_url of the image
 */
export async function addRejection(storyId, imageUrl) {
  const key = `${storyId}_${imageUrl}`;
  // PRIMARY: Database/rejections.json (portable across Chrome profiles / PCs)
  const cache = await _loadRejections();
  cache[key]  = 1;
  _writeDbFile(_DB_FILE_REJECTIONS, cache).catch(() => {});
  // FALLBACK: IDB (unchanged — lets old code paths still see rejections immediately)
  const db  = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REJECTED_IMAGES, "readwrite");
    tx.objectStore(STORE_REJECTED_IMAGES).put(1, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Check whether an image was previously rejected.
 * Checks the file-backed cache first (O(1), no DB open), then falls back
 * to IDB if the cache hasn't been loaded or a legacy record is only in IDB.
 *
 * @param {string} storyId
 * @param {string} imageUrl
 * @returns {Promise<boolean>}
 */
export async function isRejected(storyId, imageUrl) {
  const key = `${storyId}_${imageUrl}`;
  const cache = await _loadRejections();
  if (cache[key]) return true;
  // Legacy fallback: pre-v2.3 installs only wrote IDB.
  const db  = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_REJECTED_IMAGES, "readonly");
    const req = tx.objectStore(STORE_REJECTED_IMAGES).get(key);
    req.onsuccess = async () => {
      db.close();
      if (req.result != null) {
        // Backfill the file cache so future checks hit the fast path and
        // the data becomes portable to the Database/ folder.
        const c = await _loadRejections();
        c[key] = 1;
        _writeDbFile(_DB_FILE_REJECTIONS, c).catch(() => {});
        resolve(true);
      } else {
        resolve(false);
      }
    };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return all rejection records as an array of key strings.
 * Used for full backup export. Primary: Database/rejections.json
 * @returns {Promise<string[]>}
 */
export async function getAllRejections() {
  const cache = await _loadRejections();
  if (Object.keys(cache).length > 0) return Object.keys(cache);
  // Fallback: IDB (pre-migration installs)
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_REJECTED_IMAGES, "readonly");
    const req = tx.objectStore(STORE_REJECTED_IMAGES).getAllKeys();
    req.onsuccess = async () => {
      db.close();
      const keys = req.result || [];
      if (keys.length > 0) {
        // Backfill + persist to file so future reads are portable
        const c = await _loadRejections();
        for (const k of keys) c[k] = 1;
        _writeDbFile(_DB_FILE_REJECTIONS, c).catch(() => {});
      }
      resolve(keys);
    };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Clear all rejection records (e.g. when user resets face data).
 * Wipes the file-backed ledger AND the IDB store atomically.
 */
export async function clearAllRejections() {
  // Wipe file cache
  _fileCache.rejections = {};
  _writeDbFile(_DB_FILE_REJECTIONS, {}).catch(() => {});
  // Wipe IDB
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REJECTED_IMAGES, "readwrite");
    tx.objectStore(STORE_REJECTED_IMAGES).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Mark a filename as rejected in a story's manifest (moves from approvedFilenames
 * to rejectedFilenames). Used by Clean Up / Re-evaluate when a photo is moved
 * to the {Child} Rejected Matches/ folder.  Keeps manifest.json in sync with disk.
 *
 * @param {string} childId
 * @param {string} storyId
 * @param {string} filename  The exact on-disk filename (not the original URL)
 * @returns {Promise<boolean>}  true if the manifest was actually modified
 */
export async function markFilenameRejectedInManifest(childId, storyId, filename) {
  const key   = `${childId}_${storyId}`;
  const cache = await _loadManifests();
  const m     = cache[key];
  if (!m) return false;

  const approved  = new Set(m.approvedFilenames || []);
  const rejected  = new Set(m.rejectedFilenames || []);
  let   changed   = false;

  if (approved.has(filename)) { approved.delete(filename); changed = true; }
  if (!rejected.has(filename)) { rejected.add(filename); changed = true; }
  if (m.thumbnailFilename === filename) {
    m.thumbnailFilename = [...approved][0] || "";
    changed = true;
  }
  if (!changed) return false;

  m.approvedFilenames = [...approved];
  m.rejectedFilenames = [...rejected];
  m.savedAt = new Date().toISOString();
  m.schemaVersion = 2;
  cache[key] = m;
  _writeDbFile(_DB_FILE_MANIFESTS, cache).catch(() => {});

  // Mirror into IDB for pre-migration callers
  try {
    const db = await openDB();
    await new Promise(res => {
      const tx = db.transaction(STORE_DOWNLOADED_STORIES, "readwrite");
      tx.objectStore(STORE_DOWNLOADED_STORIES).put(m);
      tx.oncomplete = () => { db.close(); res(); };
    });
  } catch {}
  return true;
}

/**
 * Inverse of markFilenameRejectedInManifest — used when a photo is rescued
 * from Rejected Matches/ back into Stories/ after the user approves it.
 *
 * @param {string} childId
 * @param {string} storyId
 * @param {string} filename
 * @returns {Promise<boolean>}  true if the manifest was actually modified
 */
export async function markFilenameApprovedInManifest(childId, storyId, filename) {
  const key   = `${childId}_${storyId}`;
  const cache = await _loadManifests();
  const m     = cache[key];
  if (!m) return false;

  const approved  = new Set(m.approvedFilenames || []);
  const rejected  = new Set(m.rejectedFilenames || []);
  let   changed   = false;

  if (rejected.has(filename)) { rejected.delete(filename); changed = true; }
  if (!approved.has(filename)) { approved.add(filename); changed = true; }
  if (!changed) return false;

  m.approvedFilenames = [...approved];
  m.rejectedFilenames = [...rejected];
  if (!m.thumbnailFilename) m.thumbnailFilename = filename;
  m.savedAt = new Date().toISOString();
  m.schemaVersion = 2;
  cache[key] = m;
  _writeDbFile(_DB_FILE_MANIFESTS, cache).catch(() => {});

  try {
    const db = await openDB();
    await new Promise(res => {
      const tx = db.transaction(STORE_DOWNLOADED_STORIES, "readwrite");
      tx.objectStore(STORE_DOWNLOADED_STORIES).put(m);
      tx.oncomplete = () => { db.close(); res(); };
    });
  } catch {}
  return true;
}

/* ================================================================== */
/*  pendingDownloads — Phase 1 deferred download queue                 */
/* ================================================================== */

/**
 * Add an item to the pending-download queue (Phase 1 train-only mode).
 * Stores all data needed to download the photo later.
 *
 * @param {Object} item  { childId, childName, storyData, savePath, description,
 *                          gpsCoords, exifTitle, exifSubject, exifComments }
 * @returns {Promise<number>} auto-increment key
 */
export async function addPendingDownload(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_PENDING_DOWNLOADS, "readwrite");
    const store = tx.objectStore(STORE_PENDING_DOWNLOADS);

    // Dedup: skip if an entry with the same savePath already exists
    if (item.savePath) {
      const cursor = store.openCursor();
      cursor.onsuccess = (event) => {
        const c = event.target.result;
        if (c) {
          if (c.value.savePath === item.savePath) {
            // Duplicate found — return existing key without adding
            db.close();
            resolve(c.key);
            return;
          }
          c.continue();
        } else {
          // No duplicate found — add the new item
          const addReq = store.add(item);
          addReq.onsuccess = () => { db.close(); resolve(addReq.result); };
        }
      };
      cursor.onerror = () => { db.close(); reject(cursor.error); };
    } else {
      // No savePath to dedup on — just add
      const req = store.add(item);
      req.onsuccess = () => { db.close(); resolve(req.result); };
    }
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Return all pending downloads for a specific child.
 *
 * @param {string} childId
 * @returns {Promise<Array<{id: number, ...item}>>}
 */
export async function getPendingDownloads(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_PENDING_DOWNLOADS, "readonly");
    const store = tx.objectStore(STORE_PENDING_DOWNLOADS);
    const items = [];

    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.childId === childId) {
          items.push({ id: cursor.key, ...cursor.value });
        }
        cursor.continue();
      } else {
        db.close();
        resolve(items);
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return ALL pending downloads (all children).
 * @returns {Promise<Array<{id: number, ...item}>>}
 */
export async function getAllPendingDownloads() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_PENDING_DOWNLOADS, "readonly");
    const store = tx.objectStore(STORE_PENDING_DOWNLOADS);
    const items = [];

    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        items.push({ id: cursor.key, ...cursor.value });
        cursor.continue();
      } else {
        db.close();
        resolve(items);
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Remove a single pending download by its auto-increment key.
 * @param {number} id
 */
export async function removePendingDownload(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING_DOWNLOADS, "readwrite");
    tx.objectStore(STORE_PENDING_DOWNLOADS).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Clear all pending downloads for a specific child.
 * @param {string} childId
 */
export async function clearPendingDownloads(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_PENDING_DOWNLOADS, "readwrite");
    const store = tx.objectStore(STORE_PENDING_DOWNLOADS);

    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.childId === childId) cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ================================================================== */
/*  negativeDescriptors — "Not my child" face profiles                 */
/* ================================================================== */

/** Maximum negative descriptors stored per child. */
const MAX_NEGATIVE_DESCRIPTORS = 200;

/**
 * Get negative (not-my-child) face descriptors for a child.
 * @param {string} childId
 * @returns {Promise<number[][]>}  Array of descriptor vectors
 */
/** Get negative (not-my-child) face descriptors for a child. Primary: Database/negative_descriptors.json */
export async function getNegativeDescriptors(childId) {
  const cache = await _loadNegDescriptors();
  if (cache[childId]) return cache[childId].descriptors || [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NEGATIVE_DESCRIPTORS, "readonly");
    const req = tx.objectStore(STORE_NEGATIVE_DESCRIPTORS).get(childId);
    req.onsuccess = async () => {
      db.close();
      if (req.result) { const c = await _loadNegDescriptors(); c[childId] = req.result; _writeDbFile(_DB_FILE_NEG_DESCS, c).catch(() => {}); }
      resolve(req.result?.descriptors || []);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Append a negative face descriptor. Primary: Database/negative_descriptors.json */
export async function appendNegativeDescriptor(childId, descriptor) {
  const cache    = await _loadNegDescriptors();
  const existing = cache[childId]?.descriptors || [];
  existing.push(Array.from(descriptor));
  if (existing.length > MAX_NEGATIVE_DESCRIPTORS) existing.splice(0, existing.length - MAX_NEGATIVE_DESCRIPTORS);
  const record = { childId, descriptors: existing };
  cache[childId] = record;
  _writeDbFile(_DB_FILE_NEG_DESCS, cache).catch(() => {});
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NEGATIVE_DESCRIPTORS, "readwrite");
    tx.objectStore(STORE_NEGATIVE_DESCRIPTORS).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Clear all negative descriptors for a child. */
export async function clearNegativeDescriptors(childId) {
  const cache = await _loadNegDescriptors();
  delete cache[childId];
  _writeDbFile(_DB_FILE_NEG_DESCS, cache).catch(() => {});
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NEGATIVE_DESCRIPTORS, "readwrite");
    tx.objectStore(STORE_NEGATIVE_DESCRIPTORS).delete(childId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ================================================================== */
/*  scanCheckpoints — Resume interrupted scans                         */
/* ================================================================== */

/**
 * Save a scan checkpoint for resuming later.
 * @param {Object} checkpoint  { childId, childName, mode, storyIndex, totalStories, lastStoryId, timestamp }
 */
export async function saveScanCheckpoint(checkpoint) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SCAN_CHECKPOINTS, "readwrite");
    tx.objectStore(STORE_SCAN_CHECKPOINTS).put({
      ...checkpoint,
      timestamp: new Date().toISOString(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Get the scan checkpoint for a child (if any).
 * @param {string} childId
 * @returns {Promise<Object|null>}
 */
export async function getScanCheckpoint(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_SCAN_CHECKPOINTS, "readonly");
    const req = tx.objectStore(STORE_SCAN_CHECKPOINTS).get(childId);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Clear the scan checkpoint for a child (scan completed successfully).
 * @param {string} childId
 */
export async function clearScanCheckpoint(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SCAN_CHECKPOINTS, "readwrite");
    tx.objectStore(STORE_SCAN_CHECKPOINTS).delete(childId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Get all scan checkpoints (for export/import).
 * @returns {Promise<Array>}
 */
export async function getAllScanCheckpoints() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_SCAN_CHECKPOINTS, "readonly");
    const req = tx.objectStore(STORE_SCAN_CHECKPOINTS).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/* ================================================================== */
/*  imageFingerprints — Cached face descriptors per photo              */
/*                                                                     */
/*  Avoids re-downloading and re-analyzing images on re-scans.         */
/*  Each entry stores ALL face descriptors found in a photo, keyed by  */
/*  "storyId_imageUrl". On re-scan, the matching step reads cached     */
/*  descriptors instead of hitting Storypark's API.                    */
/*                                                                     */
/*  A single descriptor is ~2KB (Float32Array[512] → number[]).        */
/*  500 photos × 2 faces each = ~2MB of IndexedDB — vs ~1.5GB of      */
/*  re-downloading the actual images from the API.                     */
/* ================================================================== */

/**
 * Save face fingerprint(s) for a photo.
 *
 * @param {Object} fingerprint
 * @param {string} fingerprint.storyId
 * @param {string} fingerprint.imageUrl   original_url from Storypark
 * @param {string} fingerprint.childId    which child's story this belongs to
 * @param {Array}  fingerprint.faces      Array of { descriptor: number[], box?: {x,y,w,h} }
 * @param {boolean} fingerprint.noFace    true if no faces were detected
 */
/**
 * Save face fingerprint(s) for a photo.
 * PRIMARY: Database/fingerprints.json (NOT written to IDB to prevent OOM).
 * @param {Object} fingerprint  { storyId, imageUrl, childId, faces, noFace }
 */
export async function saveImageFingerprint(fingerprint) {
  const key    = `${fingerprint.storyId}_${fingerprint.imageUrl}`;
  const record = { ...fingerprint, key, cachedAt: new Date().toISOString() };
  const cache  = await _loadFingerprints();
  cache[key]   = record;
  _writeDbFile(_DB_FILE_PRINTS, cache).catch(() => {});
  // Note: deliberately NOT written to IDB — that was the source of the OOM crash.
}

/** Get cached face fingerprint for a specific photo. Primary: Database/fingerprints.json */
export async function getImageFingerprint(storyId, imageUrl) {
  const key   = `${storyId}_${imageUrl}`;
  const cache = await _loadFingerprints();
  if (cache[key]) return cache[key];
  // Fallback: IDB (pre-migration data)
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_IMAGE_FINGERPRINTS, "readonly");
    const req = tx.objectStore(STORE_IMAGE_FINGERPRINTS).get(key);
    req.onsuccess = async () => {
      db.close();
      if (req.result) { const c = await _loadFingerprints(); c[key] = req.result; }
      resolve(req.result ?? null);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Get all cached fingerprints for a specific child. */
export async function getChildFingerprints(childId) {
  const cache    = await _loadFingerprints();
  const fromFile = Object.values(cache).filter(r => r.childId === childId);
  if (fromFile.length > 0) return fromFile;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_IMAGE_FINGERPRINTS, "readonly");
    const req = tx.objectStore(STORE_IMAGE_FINGERPRINTS).index("childId").getAll(childId);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/** Get all cached fingerprints (all children). */
export async function getAllImageFingerprints() {
  const cache = await _loadFingerprints();
  if (Object.keys(cache).length > 0) return Object.values(cache);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_IMAGE_FINGERPRINTS, "readonly");
    const req = tx.objectStore(STORE_IMAGE_FINGERPRINTS).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/** Clear all fingerprints from both file and IDB. */
export async function clearAllImageFingerprints() {
  _fileCache.fingerprints = {};
  _writeDbFile(_DB_FILE_PRINTS, {}).catch(() => {});
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGE_FINGERPRINTS, "readwrite");
    tx.objectStore(STORE_IMAGE_FINGERPRINTS).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/** Count total fingerprints stored. */
export async function countImageFingerprints() {
  const cache = await _loadFingerprints();
  if (Object.keys(cache).length > 0) return Object.keys(cache).length;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_IMAGE_FINGERPRINTS, "readonly");
    const req = tx.objectStore(STORE_IMAGE_FINGERPRINTS).count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/* ================================================================== */
/*  storyCache — Cached full story API responses                       */
/*                                                                     */
/*  Stores the parsed JSON from /api/v3/stories/{id} so re-scans and  */
/*  re-evaluations don't need to re-fetch story details. Includes all  */
/*  fields: title, body, media items, educator, room, centre, etc.     */
/*                                                                     */
/*  Each cached story is typically 2-5KB of JSON.                      */
/*  500 stories ≈ 1-2.5MB of IndexedDB storage.                       */
/* ================================================================== */

/**
 * Cache a full story API response.
 *
 * @param {string} storyId
 * @param {Object} storyData  The full parsed story object from the API
 */
export async function cacheStory(storyId, storyData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STORY_CACHE, "readwrite");
    tx.objectStore(STORE_STORY_CACHE).put({
      storyId,
      data: storyData,
      cachedAt: new Date().toISOString(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Get a cached story by ID.
 *
 * @param {string} storyId
 * @returns {Promise<Object|null>}  The cached story data or null
 */
export async function getCachedStory(storyId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_STORY_CACHE, "readonly");
    const req = tx.objectStore(STORE_STORY_CACHE).get(storyId);
    req.onsuccess = () => { db.close(); resolve(req.result?.data ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Get all cached stories.
 * @returns {Promise<Array>}
 */
export async function getAllCachedStories() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_STORY_CACHE, "readonly");
    const req = tx.objectStore(STORE_STORY_CACHE).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Clear all cached stories.
 */
export async function clearAllCachedStories() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STORY_CACHE, "readwrite");
    tx.objectStore(STORE_STORY_CACHE).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ================================================================== */
/*  linkedFolder — Persisted FileSystemDirectoryHandle                 */
/*                                                                     */
/*  Stores the user's chosen download folder handle so the extension   */
/*  can verify on-disk files without prompting for folder access on    */
/*  every session.                                                     */
/*                                                                     */
/*  FileSystemDirectoryHandle objects ARE serialisable to IndexedDB.   */
/*  The handle is stored under the fixed key "handle".                 */
/* ================================================================== */

const LINKED_FOLDER_KEY = "handle";

/**
 * Persist a FileSystemDirectoryHandle in IndexedDB.
 * Overwrites any previously stored handle.
 *
 * @param {FileSystemDirectoryHandle} handle
 */
export async function saveLinkedFolderHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LINKED_FOLDER, "readwrite");
    tx.objectStore(STORE_LINKED_FOLDER).put(handle, LINKED_FOLDER_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Retrieve the stored FileSystemDirectoryHandle, or null if none is stored.
 *
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function getLinkedFolderHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_LINKED_FOLDER, "readonly");
    const req = tx.objectStore(STORE_LINKED_FOLDER).get(LINKED_FOLDER_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Remove the stored FileSystemDirectoryHandle.
 * After calling this, getLinkedFolderHandle() will return null.
 */
export async function clearLinkedFolderHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LINKED_FOLDER, "readwrite");
    tx.objectStore(STORE_LINKED_FOLDER).delete(LINKED_FOLDER_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Count total cached stories.
 * @returns {Promise<number>}
 */
export async function countCachedStories() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_STORY_CACHE, "readonly");
    const req = tx.objectStore(STORE_STORY_CACHE).count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/* ================================================================== */
/*  childProfiles — Rich child data from Storypark API (v11)           */
/*                                                                     */
/*  Stores the full child profile so background.js can read birthday,  */
/*  regularDays and centre info from IDB instead of re-fetching from   */
/*  the API on every scan.  Profile is refreshed when stale (>24h).    */
/*                                                                     */
/*  Each record: { childId, childName, birthday, regularDays,          */
/*                 companies, centreIds, lastUpdated }                 */
/* ================================================================== */

/**
 * Upsert a child profile record.
 *
 * @param {Object} profile
 * @param {string} profile.childId
 * @param {string} profile.childName
 * @param {string|null} profile.birthday      YYYY-MM-DD
 * @param {string[]}    profile.regularDays   e.g. ["monday","thursday"]
 * @param {Array}       profile.companies     [{id, name, address, suburb}]
 * @param {string[]}    profile.centreIds     Storypark centre IDs
 */
export async function saveChildProfile(profile) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHILD_PROFILES, "readwrite");
    tx.objectStore(STORE_CHILD_PROFILES).put({
      ...profile,
      lastUpdated: new Date().toISOString(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Get a child profile by childId. Returns null if not stored.
 *
 * @param {string} childId
 * @returns {Promise<Object|null>}
 */
export async function getChildProfile(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_CHILD_PROFILES, "readonly");
    const req = tx.objectStore(STORE_CHILD_PROFILES).get(childId);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return all stored child profiles.
 * @returns {Promise<Array>}
 */
export async function getAllChildProfiles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_CHILD_PROFILES, "readonly");
    const req = tx.objectStore(STORE_CHILD_PROFILES).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Check if a child profile is stale (older than maxAgeMs, default 24h).
 * Returns true if the profile should be re-fetched from Storypark.
 *
 * @param {string} childId
 * @param {number} [maxAgeMs=86400000]  24 hours in ms
 * @returns {Promise<boolean>}
 */
export async function isChildProfileStale(childId, maxAgeMs = 24 * 60 * 60 * 1000) {
  const profile = await getChildProfile(childId);
  if (!profile?.lastUpdated) return true;
  const age = Date.now() - new Date(profile.lastUpdated).getTime();
  return age > maxAgeMs;
}

/* ================================================================== */
/*  centreProfiles — Centre/service GPS + address data (v11)           */
/*                                                                     */
/*  Replaces centreLocations in chrome.storage.local.                  */
/*  IDB-backed = properly backupable, richer fields, larger capacity.  */
/*  chrome.storage.local.centreLocations is read on import for         */
/*  backward compatibility with pre-v11 backups.                       */
/* ================================================================== */

/**
 * Save or update a centre profile.
 *
 * @param {Object} centre
 * @param {string}      centre.centreName   Primary key
 * @param {string|null} centre.centreId     Storypark service/institution ID
 * @param {string|null} centre.address
 * @param {string|null} centre.suburb
 * @param {string|null} centre.state
 * @param {string|null} centre.postcode
 * @param {number|null} centre.lat
 * @param {number|null} centre.lng
 */
export async function saveCentreProfile(centre) {
  if (!centre?.centreName) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_CENTRE_PROFILES, "readwrite");
    const store = tx.objectStore(STORE_CENTRE_PROFILES);
    const req   = store.get(centre.centreName);
    req.onsuccess = () => {
      const existing = req.result || {};
      store.put({
        ...existing,
        ...centre,
        lastUpdated: new Date().toISOString(),
      });
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Get a centre profile by name. Returns null if not stored.
 *
 * @param {string} centreName
 * @returns {Promise<Object|null>}
 */
export async function getCentreProfile(centreName) {
  if (!centreName) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_CENTRE_PROFILES, "readonly");
    const req = tx.objectStore(STORE_CENTRE_PROFILES).get(centreName);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Get GPS coordinates for a centre from IDB.
 * Returns { lat, lng } or null if not found / not geocoded.
 *
 * @param {string} centreName
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
export async function getCentreGPS(centreName) {
  const profile = await getCentreProfile(centreName);
  if (!profile || profile.lat == null || profile.lng == null) return null;
  return { lat: profile.lat, lng: profile.lng };
}

/**
 * Return all stored centre profiles.
 * @returns {Promise<Array>}
 */
export async function getAllCentreProfiles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_CENTRE_PROFILES, "readonly");
    const req = tx.objectStore(STORE_CENTRE_PROFILES).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Update GPS coordinates for a centre profile (after geocoding).
 *
 * @param {string} centreName
 * @param {number} lat
 * @param {number} lng
 */
export async function updateCentreGPS(centreName, lat, lng) {
  await saveCentreProfile({ centreName, lat, lng });
}

/**
 * Import centreLocations from the legacy chrome.storage.local format
 * into the new IDB centreProfiles store.  Called once during upgrade or
 * on backup import when the new store is empty.
 *
 * @param {Object} centreLocations  { [centreName]: { lat, lng, address } }
 */
export async function importLegacyCentreLocations(centreLocations) {
  if (!centreLocations || typeof centreLocations !== "object") return;
  for (const [centreName, loc] of Object.entries(centreLocations)) {
    await saveCentreProfile({
      centreName,
      centreId: null,
      address: loc.address || null,
      suburb: null,
      state: null,
      postcode: null,
      lat: loc.lat ?? null,
      lng: loc.lng ?? null,
    });
  }
}

/* ================================================================== */
/*  educators — Known educator data per child (v11)                    */
/*                                                                     */
/*  Tracks educator names and IDs so story metadata can be written     */
/*  without re-parsing raw API responses.                              */
/* ================================================================== */

/**
 * Save or update an educator record.
 * Key = "childId_educatorId" for deduplication.
 *
 * @param {Object} educator
 * @param {string} educator.educatorId    Storypark user ID
 * @param {string} educator.educatorName  Display name
 * @param {string} educator.childId       Which child they teach
 * @param {string} [educator.centreName]  Centre they teach at
 */
export async function saveEducator(educator) {
  if (!educator?.educatorId || !educator?.childId) return;
  const key = `${educator.childId}_${educator.educatorId}`;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EDUCATORS, "readwrite");
    tx.objectStore(STORE_EDUCATORS).put({
      ...educator,
      key,
      lastSeen: new Date().toISOString(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Return all educators seen for a specific child.
 *
 * @param {string} childId
 * @returns {Promise<Array>}
 */
export async function getEducatorsForChild(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_EDUCATORS, "readonly");
    const index = tx.objectStore(STORE_EDUCATORS).index("childId");
    const req   = index.getAll(childId);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return all educator records.
 * @returns {Promise<Array>}
 */
export async function getAllEducators() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_EDUCATORS, "readonly");
    const req = tx.objectStore(STORE_EDUCATORS).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/* ================================================================== */
/*  fileSystemState — Per-file download tracking for crash recovery    */
/*                                                                     */
/*  Written when each file is successfully saved to disk.              */
/*  Read during integrity checks: compare IDB state vs actual folder.  */
/*  keyPath=filePath supports upsert on re-download (put() overwrites)  */
/*  childId + storyId indexes allow efficient per-child/story queries.  */
/* ================================================================== */

/**
 * Record that a file was successfully downloaded to disk.
 * Upserts by filePath — calling again on re-download updates the timestamp.
 *
 * @param {Object} record
 * @param {string} record.filePath      Relative path (e.g. "Hugo Hill/Stories/.../photo.jpg")
 * @param {string} record.childId
 * @param {string} record.storyId
 * @param {string} record.filename      Just the filename
 * @param {string} [record.centreName]  Centre for cross-referencing
 */
export async function recordFileDownloaded(record) {
  if (!record?.filePath) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILE_SYSTEM_STATE, "readwrite");
    tx.objectStore(STORE_FILE_SYSTEM_STATE).put({
      ...record,
      downloadedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Get the file system state record for a specific file path.
 *
 * @param {string} filePath
 * @returns {Promise<Object|null>}
 */
export async function getFileSystemRecord(filePath) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FILE_SYSTEM_STATE, "readonly");
    const req = tx.objectStore(STORE_FILE_SYSTEM_STATE).get(filePath);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return all file system state records for a specific child.
 * Uses the childId index for an efficient O(log n + results) query.
 *
 * @param {string} childId
 * @returns {Promise<Array>}
 */
export async function getFileSystemRecordsForChild(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_FILE_SYSTEM_STATE, "readonly");
    const index = tx.objectStore(STORE_FILE_SYSTEM_STATE).index("childId");
    const req   = index.getAll(childId);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return all file system state records for a specific story.
 *
 * @param {string} storyId
 * @returns {Promise<Array>}
 */
export async function getFileSystemRecordsForStory(storyId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_FILE_SYSTEM_STATE, "readonly");
    const index = tx.objectStore(STORE_FILE_SYSTEM_STATE).index("storyId");
    const req   = index.getAll(storyId);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return all file system state records (all children).
 * Use with caution on large libraries — prefer per-child queries.
 * @returns {Promise<Array>}
 */
export async function getAllFileSystemRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FILE_SYSTEM_STATE, "readonly");
    const req = tx.objectStore(STORE_FILE_SYSTEM_STATE).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Count total file system records.
 * @returns {Promise<number>}
 */
export async function countFileSystemRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FILE_SYSTEM_STATE, "readonly");
    const req = tx.objectStore(STORE_FILE_SYSTEM_STATE).count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Delete a file system state record (e.g. after confirmed deletion from disk).
 *
 * @param {string} filePath
 */
export async function deleteFileSystemRecord(filePath) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILE_SYSTEM_STATE, "readwrite");
    tx.objectStore(STORE_FILE_SYSTEM_STATE).delete(filePath);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Clear all file system state records for a child.
 * Called when a child's downloads are fully reset.
 *
 * @param {string} childId
 */
export async function clearFileSystemRecordsForChild(childId) {
  const records = await getFileSystemRecordsForChild(childId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_FILE_SYSTEM_STATE, "readwrite");
    const store = tx.objectStore(STORE_FILE_SYSTEM_STATE);
    for (const r of records) {
      store.delete(r.filePath);
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ================================================================== */
/*  Migration — IDB → Database/ folder                                */
/*                                                                     */
/*  Reads all heavy stores from IndexedDB and writes them to the       */
/*  Database/ folder inside the linked folder.  Called automatically   */
/*  on the first session after the user links their folder (or after   */
/*  a Chrome profile reset).  Safe to call multiple times — existing   */
/*  file-based data is merged, not overwritten.                        */
/* ================================================================== */

/**
 * Migrate all heavy IDB stores to Database/ files.
 * After migration, the fingerprints store in IDB is cleared to free space.
 * @returns {Promise<{ok: boolean, migrated: number, reason?: string}>}
 */
export async function migrateLargeStoresToFiles() {
  const folder = await _getDbFolder();
  if (!folder) return { ok: false, reason: "No folder linked — link your Storypark Smart Saver folder first." };

  let migrated = 0;
  const _idbGetAll = async (store) => {
    const db = await openDB();
    return new Promise(res => {
      db.transaction(store, "readonly").objectStore(store).getAll().onsuccess =
        e => { db.close(); res(e.target.result || []); };
    });
  };

  // ── Descriptors ──────────────────────────────────────────────────
  const idbDescs = await _idbGetAll(STORE_KNOWN_DESCRIPTORS);
  if (idbDescs.length > 0) {
    const current = await _loadDescriptors();
    let added = 0;
    for (const r of idbDescs) { if (!current[r.childId]) { current[r.childId] = r; added++; } }
    if (added > 0) { await _writeDbFile(_DB_FILE_DESCS, current); migrated += added; }
  }

  // ── Negative descriptors ─────────────────────────────────────────
  const idbNeg = await _idbGetAll(STORE_NEGATIVE_DESCRIPTORS);
  if (idbNeg.length > 0) {
    const current = await _loadNegDescriptors();
    let added = 0;
    for (const r of idbNeg) { if (!current[r.childId]) { current[r.childId] = r; added++; } }
    if (added > 0) { await _writeDbFile(_DB_FILE_NEG_DESCS, current); migrated += added; }
  }

  // ── Manifests ─────────────────────────────────────────────────────
  const idbManifests = await _idbGetAll(STORE_DOWNLOADED_STORIES);
  if (idbManifests.length > 0) {
    const current = await _loadManifests();
    let added = 0;
    for (const m of idbManifests) {
      const k = m.key || `${m.childId}_${m.storyId}`;
      if (!current[k]) { current[k] = { ...m, key: k }; added++; }
    }
    if (added > 0) { await _writeDbFile(_DB_FILE_MANIFESTS, current); migrated += added; }
  }

  // ── Fingerprints ─────────────────────────────────────────────────
  const idbPrints = await _idbGetAll(STORE_IMAGE_FINGERPRINTS);
  if (idbPrints.length > 0) {
    const current = await _loadFingerprints();
    let added = 0;
    for (const r of idbPrints) { if (!current[r.key]) { current[r.key] = r; added++; } }
    if (added > 0) {
      await _writeDbFile(_DB_FILE_PRINTS, current);
      migrated += added;
      // Clear from IDB now that data is safely in files
      const db = await openDB();
      await new Promise(res => {
        const tx = db.transaction(STORE_IMAGE_FINGERPRINTS, "readwrite");
        tx.objectStore(STORE_IMAGE_FINGERPRINTS).clear();
        tx.oncomplete = () => { db.close(); res(); };
      });
    }
  }

  return { ok: true, migrated };
}

/* ================================================================== */
/*  fileMovements — File location tracking (v12)                       */
/*                                                                     */
/*  Every file movement is recorded here for audit trail and re-scan.  */
/*  Uses autoIncrement id for cursor-based pagination (OOM-safe).      */
/*  Never call getAll() — use the cursor generator instead.            */
/*                                                                     */
/*  Movement types:                                                     */
/*    "downloaded"  — initial download to Stories/                     */
/*    "rejected"    — moved to Rejected Matches/ (face rec mismatch)   */
/*    "rescued"     — moved back to Stories/ (face rec improved)       */
/*    "deleted"     — permanently deleted                              */
/*    "approved"    — batch download from pending queue                */
/*                                                                     */
/*  Sources:                                                            */
/*    "online_scan" | "download_all" | "offline_scan"                  */
/*    "review_approval" | "cleanup_safe" | "cleanup_destructive"       */
/*    "batch_download"                                                 */
/* ================================================================== */

/**
 * Record a file movement event.
 * Fire-and-forget in hot loops — never await in a per-image loop.
 *
 * @param {import('./types.js').FileMovement} movement
 * @returns {Promise<number>} — auto-increment id of the new record
 */
export async function recordFileMovement(movement) {
  if (!movement?.type || !movement?.childId) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILE_MOVEMENTS, "readwrite");
    tx.objectStore(STORE_FILE_MOVEMENTS).add({
      ...movement,
      ts:      movement.ts      || new Date().toISOString(),
      flushed: movement.flushed ?? false,
    });
    tx.oncomplete = () => { db.close(); resolve(tx.result || 0); };
    tx.onerror    = () => { db.close(); resolve(0); }; // non-fatal — never reject
  });
}

/**
 * Get recent file movements for a child, filtered by type (optional).
 * OOM-safe: returns at most `limit` records using cursor pagination.
 * Does NOT call getAll() — always uses a cursor with a limit.
 *
 * @param {string} childId
 * @param {string|null} [type]   — filter by movement type (null = all)
 * @param {number} [limit=200]  — max records to return
 * @returns {Promise<Array<import('./types.js').FileMovement>>}
 */
export async function getFileMovementsByChild(childId, type = null, limit = 200) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_FILE_MOVEMENTS, "readonly");
    const store = tx.objectStore(STORE_FILE_MOVEMENTS);
    const items = [];

    let req;
    if (type) {
      // Use by_type index: [childId, type]
      const range = IDBKeyRange.only([childId, type]);
      req = store.index("by_type").openCursor(range, "prev"); // newest first
    } else {
      // Use by_child index: childId
      const range = IDBKeyRange.only(childId);
      req = store.index("by_child").openCursor(range, "prev");
    }

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || items.length >= limit) {
        db.close();
        resolve(items);
        return;
      }
      items.push({ id: cursor.primaryKey, ...cursor.value });
      cursor.continue();
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/**
 * Get the most recent movement record for a specific file.
 * Used to determine the current known state of a file.
 *
 * @param {string} childId
 * @param {string} storyId
 * @param {string} filename
 * @returns {Promise<import('./types.js').FileMovement|null>}
 */
export async function getLatestFileMovement(childId, storyId, filename) {
  const movements = await getFileMovementsByChild(childId, null, 1000);
  // Filter by storyId+filename and return the newest
  const matching = movements.filter(
    m => m.storyId === storyId && m.filename === filename
  );
  return matching.length > 0 ? matching[0] : null; // newest first from cursor
}

/**
 * Count total file movement records (for display in Active Database panel).
 * @returns {Promise<number>}
 */
export async function countFileMovements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FILE_MOVEMENTS, "readonly");
    const req = tx.objectStore(STORE_FILE_MOVEMENTS).count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}
