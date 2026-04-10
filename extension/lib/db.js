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

/**
 * Return all processed URLs as a Set.
 * @returns {Promise<Set<string>>}
 */
export async function getAllProcessedUrls() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_PROCESSED_URLS, "readonly");
    const req = tx.objectStore(STORE_PROCESSED_URLS).getAllKeys();
    req.onsuccess = () => { db.close(); resolve(new Set(req.result)); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

/**
 * Mark one or more URLs as processed (idempotent).
 * @param {string[]} urls
 */
export async function markProcessedInDB(urls) {
  if (!urls || urls.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_PROCESSED_URLS, "readwrite");
    const store = tx.objectStore(STORE_PROCESSED_URLS);
    for (const url of urls) store.put(1, url);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

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
 * Append a single face descriptor to a child's stored set.
 * Creates the record if it does not exist.
 *
 * @param {string}                childId
 * @param {string}                childName
 * @param {number[]|Float32Array} descriptor
 */
export async function saveDescriptor(childId, childName, descriptor) {
  const existing    = await getDescriptors(childId);
  const descriptors = existing?.descriptors ?? [];
  descriptors.push(Array.from(descriptor));

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KNOWN_DESCRIPTORS, "readwrite");
    tx.objectStore(STORE_KNOWN_DESCRIPTORS).put({ childId, childName, descriptors });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

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
