/**
 * lib/db.js – IndexedDB helper for the processed-URL ledger.
 *
 * Stores the history of every Storypark image URL that has already been
 * handled (uploaded, queued for review, or discarded). Using IndexedDB
 * instead of chrome.storage.local avoids the 5 MB hard storage limit,
 * providing virtually unlimited capacity for users with years of history.
 *
 * Database   : storyparkSyncDB  (version 1)
 * Object store: processedUrls  (out-of-line keys – the URL string is the key)
 *
 * All functions are async and safe to call from the service worker context.
 */

const DB_NAME = "storyparkSyncDB";
const DB_VERSION = 1;
const STORE_NAME = "processedUrls";

/**
 * Open (or upgrade) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Keys are the URL strings themselves (out-of-line keys).
        db.createObjectStore(STORE_NAME);
      }
    };

    req.onsuccess = (event) => resolve(event.target.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Return all processed URLs as a Set.
 * Used to pass the known-URL list to the content script for incremental sync.
 *
 * @returns {Promise<Set<string>>}
 */
export async function getAllProcessedUrls() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => {
      db.close();
      resolve(new Set(req.result));
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/**
 * Mark one or more URLs as processed.
 * Existing entries are silently overwritten (idempotent).
 *
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
export async function markProcessedInDB(urls) {
  if (!urls || urls.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const url of urls) {
      // Value is 1 (a minimal placeholder); the key carries all the information.
      store.put(1, url);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
