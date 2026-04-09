/**
 * Shared constants and utility helpers for the Storypark Photo Sync extension.
 */

/* ---------- Storypark selectors (cascading fallbacks) ---------- */
export const SELECTORS = {
  postContainer:
    "article, [class*='story'], [class*='post'], [class*='activity']",
  postImage:
    "img[src*='storypark'], img[src*='amazonaws'], img[src*='cloudfront']",
  postDate: "time[datetime], [class*='date'], [class*='time']",
  loadMore: "[class*='load-more'], button",
};

/* ---------- Google Photos API ---------- */
export const GOOGLE_PHOTOS_API = "https://photoslibrary.googleapis.com/v1";

/* ---------- Timing / anti-bot ---------- */
export const SCROLL_DELAY_MIN_MS = 1500;
export const SCROLL_DELAY_MAX_MS = 3500;
export const INCREMENTAL_STOP_THRESHOLD = 5;
export const MAX_STALLED_SCROLLS = 500;

/* ---------- Helpers ---------- */

/**
 * Returns a random integer between min (inclusive) and max (inclusive).
 */
export function randomDelay(min = SCROLL_DELAY_MIN_MS, max = SCROLL_DELAY_MAX_MS) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for the given number of milliseconds.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse an ISO-8601 date string (or common Storypark variants) into a Date.
 * Returns null on failure.
 */
export function parseDate(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Derive a safe filename from a URL.
 */
export function safeFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").pop() || "image";
    return base.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "image_" + Date.now() + ".jpg";
  }
}

/**
 * Log a message to the extension's local log (stored in chrome.storage.local).
 * Also dispatched as a runtime message so the popup can listen in real-time.
 */
export async function log(message) {
  const entry = `[${new Date().toISOString()}] ${message}`;
  console.log("[StoryparkSync]", message);

  const { syncLog = [] } = await chrome.storage.local.get("syncLog");
  syncLog.push(entry);
  // Keep only the last 500 entries
  if (syncLog.length > 500) syncLog.splice(0, syncLog.length - 500);
  await chrome.storage.local.set({ syncLog });

  try {
    chrome.runtime.sendMessage({ type: "LOG", message: entry });
  } catch {
    /* popup may not be open */
  }
}
