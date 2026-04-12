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
const DB_VERSION = 2;

/** Maximum number of face descriptors kept per child (global fallback). */
export const MAX_DESCRIPTORS_PER_CHILD = 1000;

/** Maximum number of face descriptors kept per year per child. */
const MAX_DESCRIPTORS_PER_YEAR = 100;

const STORE_PROCESSED_URLS    = "processedUrls";
const STORE_PROCESSED_STORIES = "processedStories";
const STORE_REVIEW_QUEUE      = "reviewQueue";
const STORE_KNOWN_DESCRIPTORS = "knownDescriptors";

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
export async function getDescriptors(childId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_KNOWN_DESCRIPTORS, "readonly");
    const req = tx.objectStore(STORE_KNOWN_DESCRIPTORS).get(childId);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Return all known-descriptor records (all children).
 * @returns {Promise<Array<{childId, childName, descriptors}>>}
 */
export async function getAllDescriptors() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_KNOWN_DESCRIPTORS, "readonly");
    const req = tx.objectStore(STORE_KNOWN_DESCRIPTORS).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Append a single face descriptor to a child's stored set, bucketed by year.
 * Each year's bucket is capped at 100 descriptors (oldest are dropped first).
 * The flat `descriptors` array (all years combined) is maintained for the
 * existing matching logic that expects a single array.
 *
 * @param {string}                childId
 * @param {string}                childName
 * @param {number[]|Float32Array} descriptor  Plain array or typed array –
 *                                            both are normalised to number[].
 * @param {string}                [year]      Four-digit year string (e.g. "2024")
 *                                            or "unknown". Defaults to "unknown".
 */
export async function appendDescriptor(childId, childName, descriptor, year = "unknown") {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_KNOWN_DESCRIPTORS, "readwrite");
    const store = tx.objectStore(STORE_KNOWN_DESCRIPTORS);
    const req   = store.get(childId);
    req.onsuccess = () => {
      const existing = req.result ?? null;

      // Migrate legacy flat-array records into the year-bucket structure.
      let descriptorsByYear = existing?.descriptorsByYear || {};
      if (existing && existing.descriptors && !existing.descriptorsByYear) {
        descriptorsByYear["unknown"] = existing.descriptors;
      }

      // Ensure the bucket for this year exists.
      if (!descriptorsByYear[year]) {
        descriptorsByYear[year] = [];
      }

      // Append to this year's bucket and cap at MAX_DESCRIPTORS_PER_YEAR.
      descriptorsByYear[year].push(Array.from(descriptor));
      if (descriptorsByYear[year].length > MAX_DESCRIPTORS_PER_YEAR) {
        descriptorsByYear[year].splice(0, descriptorsByYear[year].length - MAX_DESCRIPTORS_PER_YEAR);
      }

      // Flatten all year buckets so the existing matching logic (which reads
      // the flat `descriptors` array) continues to work without modification.
      const flatDescriptors = Object.values(descriptorsByYear).flat();

      const putReq = store.put({ childId, childName, descriptorsByYear, descriptors: flatDescriptors });
      putReq.onerror = () => reject(putReq.error);
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Append a single face descriptor to a child's stored set.
 * Alias for {@link appendDescriptor} — kept for backwards compatibility.
 *
 * @param {string}                childId
 * @param {string}                childName
 * @param {number[]|Float32Array} descriptor
 */
export const saveDescriptor = appendDescriptor;

/**
 * Replace all face descriptors for a child with a new set.
 * Used when saving a fresh batch of training photos.
 *
 * @param {string}     childId
 * @param {string}     childName
 * @param {number[][]} descriptors
 */
export async function setDescriptors(childId, childName, descriptors) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KNOWN_DESCRIPTORS, "readwrite");
    tx.objectStore(STORE_KNOWN_DESCRIPTORS).put({
      childId,
      childName,
      descriptors: descriptors.map((d) => Array.from(d)),
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}
