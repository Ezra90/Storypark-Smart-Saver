/**
 * api-client.js — Storypark API communication layer
 *
 * Owns all network requests to app.storypark.com and Nominatim OSM.
 * Manages the anti-abuse timing system (smartDelay + Coffee Break).
 * Manages centre discovery (discoverCentres + geocodeCentre).
 *
 * IMPORTANT: Never call apiFetch() inside Promise.all() — always await sequentially.
 * IMPORTANT: smartDelay() MUST be called before every API fetch and media download.
 *
 * Exports:
 *   STORYPARK_BASE        — "https://app.storypark.com"
 *   DELAY_PROFILES        — timing ranges per action type
 *   AuthError             — thrown on HTTP 401
 *   RateLimitError        — thrown on HTTP 429 (after retry) or 403
 *   apiFetch(url)         — credentialed fetch with rate-limit handling
 *   smartDelay(type)      — human-paced delay + Coffee Break logic
 *   geocodeCentre(name, address)  — Nominatim OSM geocoding
 *   discoverCentres(centres)      — merge new centres into storage + IDB
 *   initApiClient(opts)   — inject logger, cancelRequested, diagLog callbacks
 *   getApiState()         — get {_requestCount, _coffeeBreakAt} for session persist
 *   syncApiState(state)   — restore from chrome.storage.session after SW restart
 */

import { saveCentreProfile, updateCentreGPS } from "./db.js";

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

export const STORYPARK_BASE = "https://app.storypark.com";

/**
 * Delay profiles (ms ranges) keyed by action type.
 */
export const DELAY_PROFILES = {
  FEED_SCROLL:    [800,  1500],
  READ_STORY:     [2500, 6000],
  DOWNLOAD_MEDIA: [1000, 2000],
};

/** Maximum number of milliseconds to wait before a 429-retry (2 minutes). */
const MAX_RETRY_WAIT_MS = 120_000;

/** Nominatim OSM rate-limit: at most one request per second per their ToS. */
const NOMINATIM_RATE_LIMIT_MS = 1_000;

/** Content-Type substrings that indicate a JSON API response. */
const JSON_CONTENT_TYPES = ["application/json", "text/javascript", "text/plain"];

/* ================================================================== */
/*  Error classes                                                      */
/* ================================================================== */

/** Thrown when the server returns 401 (session expired / not logged in). */
export class AuthError extends Error {
  constructor(url) {
    super(`Authentication required — please log in to Storypark (401) — ${url}`);
    this.name = "AuthError";
  }
}

/** Thrown when Cloudflare / Storypark rate-limits us (429 or 403). */
export class RateLimitError extends Error {
  constructor(status, url) {
    super(`Rate limited by Storypark (${status}) — ${url}`);
    this.name = "RateLimitError";
  }
}

/* ================================================================== */
/*  Module-level state (injectable via initApiClient)                  */
/* ================================================================== */

let _debugCaptureMode = false;
let _diagLogFn        = () => {};
let _loggerFn         = async () => {};
let _getCancelRequested = () => false;

/**
 * Scan request counter — persisted to chrome.storage.session by background.js
 * so it survives service worker suspension between stories.
 */
let _requestCount  = 0;
let _coffeeBreakAt = Math.floor(Math.random() * 11) + 15; // 15–25

/* ================================================================== */
/*  Init / state sync                                                  */
/* ================================================================== */

/**
 * Wire up callbacks from background.js. Call this once at startup, and
 * again after chrome.storage.session restore to update cancelRequested.
 *
 * @param {object} opts
 * @param {boolean}  [opts.debugCaptureMode]
 * @param {Function} [opts.diagLog]           (url, data) => void
 * @param {Function} [opts.logger]            async (level, message) => void
 * @param {Function} [opts.getCancelRequested] () => boolean
 */
export function initApiClient(opts = {}) {
  if (opts.debugCaptureMode !== undefined) _debugCaptureMode = opts.debugCaptureMode;
  if (opts.diagLog)             _diagLogFn          = opts.diagLog;
  if (opts.logger)              _loggerFn           = opts.logger;
  if (opts.getCancelRequested)  _getCancelRequested = opts.getCancelRequested;
}

/**
 * Get the current scan-counter state so background.js can persist it to
 * chrome.storage.session.
 * @returns {{ _requestCount: number, _coffeeBreakAt: number }}
 */
export function getApiState() {
  return { _requestCount, _coffeeBreakAt };
}

/**
 * Restore scan-counter state from chrome.storage.session after a service
 * worker restart.  Call this inside the chrome.storage.session.get().then() handler.
 *
 * @param {{ requestCount?: number, coffeeBreakAt?: number }} state
 */
export function syncApiState(state = {}) {
  if (state.requestCount !== undefined)  _requestCount  = state.requestCount;
  if (state.coffeeBreakAt !== undefined) _coffeeBreakAt = state.coffeeBreakAt;
}

/* ================================================================== */
/*  Anti-bot jitter — Human Pacing Algorithm ("Coffee Break")         */
/* ================================================================== */

/**
 * Smart human-paced delay that replaces the old sleep().
 * Every 15–25 requests forces an extended "Coffee Break" pause.
 *
 * MUST be called before every apiFetch() and every media download.
 *
 * @param {"FEED_SCROLL"|"READ_STORY"|"DOWNLOAD_MEDIA"} actionType
 */
export async function smartDelay(actionType) {
  if (_getCancelRequested()) return;
  _requestCount++;
  // Persist the updated counter so it survives service worker suspension.
  chrome.storage.session.set({ _requestCount }).catch(() => {});

  // Coffee Break when the counter reaches the threshold
  if (_requestCount >= _coffeeBreakAt) {
    const breakMs = Math.floor(Math.random() * (25000 - 12000 + 1)) + 12000;
    await _loggerFn(
      "INFO",
      `Coffee Break — pausing ${(breakMs / 1000).toFixed(1)}s to avoid bot detection (request #${_requestCount})`
    );
    // Reset for next break
    _requestCount  = 0;
    _coffeeBreakAt = Math.floor(Math.random() * 11) + 15; // 15–25
    chrome.storage.session.set({ _requestCount: 0, _coffeeBreakAt }).catch(() => {});
    await new Promise((r) => {
      const handle = setTimeout(() => { clearInterval(poll); r(); }, breakMs);
      const poll   = setInterval(() => {
        if (_getCancelRequested()) { clearTimeout(handle); clearInterval(poll); r(); }
      }, 100);
    });
    return;
  }

  const [minMs, maxMs] = DELAY_PROFILES[actionType] || [1000, 2000];
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((r) => {
    const handle = setTimeout(() => { clearInterval(poll); r(); }, ms);
    const poll   = setInterval(() => {
      if (_getCancelRequested()) { clearTimeout(handle); clearInterval(poll); r(); }
    }, 100);
  });
}

/* ================================================================== */
/*  Storypark API fetch (credentialed, sequential only)                */
/* ================================================================== */

/**
 * Fetch a Storypark API URL using the browser's active session cookies.
 * Never call this inside Promise.all – always await sequentially.
 *
 * Behaviour by HTTP status:
 *   401 → AuthError (session expired)
 *   429 → wait for Retry-After (default 30 s), then retry once; if the
 *          retry also returns 429, throw RateLimitError so the caller can
 *          abort gracefully.
 *   403 → RateLimitError (Cloudflare block — no retry)
 *   2xx with non-JSON body → throw a descriptive error instead of a
 *          cryptic SyntaxError (catches Cloudflare HTML challenge pages)
 *
 * @param {string}  url
 * @param {boolean} [_isRetry=false]  Internal flag — do not pass externally.
 * @returns {Promise<Object>} Parsed JSON response body
 * @throws {AuthError}      on HTTP 401
 * @throws {RateLimitError} on HTTP 403, or on HTTP 429 after one retry
 */
export async function apiFetch(url, _isRetry = false) {
  const res = await fetch(url, { credentials: "include", cache: "no-cache" });

  if (res.status === 401) {
    throw new AuthError(url);
  }

  if (res.status === 429) {
    if (!_isRetry) {
      const retryAfterSec = parseInt(res.headers.get("Retry-After") || "30", 10);
      const waitMs = Math.min(retryAfterSec * 1000, MAX_RETRY_WAIT_MS);
      _loggerFn("WARNING",
        `Rate limited (429) — waiting ${(waitMs / 1000).toFixed(0)}s before retry…`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      return apiFetch(url, true);
    }
    throw new RateLimitError(429, url);
  }

  // 403 = Cloudflare block — abort immediately, no retry.
  if (res.status === 403) {
    throw new RateLimitError(403, url);
  }

  if (!res.ok) {
    throw new Error(`Storypark API ${res.status} ${res.statusText} — ${url}`);
  }

  // Guard against Cloudflare HTML challenge pages that arrive with 200 OK.
  const ct = res.headers.get("content-type") || "";
  if (!JSON_CONTENT_TYPES.some((t) => ct.includes(t))) {
    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      throw new Error(
        `Storypark API returned an HTML page instead of JSON (possible Cloudflare challenge) — ${url}`
      );
    }
    const parsed = JSON.parse(text);
    if (_debugCaptureMode) _diagLogFn(url, parsed);
    return parsed;
  }

  const json = await res.json();
  if (_debugCaptureMode) _diagLogFn(url, json);
  return json;
}

/* ================================================================== */
/*  Nominatim geocoding                                                */
/* ================================================================== */

/**
 * Auto-geocode a centre using its address (preferred) or name via Nominatim OSM.
 * Returns { lat, lng } on success, or null on failure.
 * Nominatim ToS: max 1 request/second; callers must add delays between calls.
 *
 * @param {string} name
 * @param {string|null} address
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
export async function geocodeCentre(name, address) {
  try {
    const query = address
      ? `${name}, ${address}`
      : (/childcare|daycare|kindergarten|preschool|nursery|early learning|child care/i.test(name)
          ? name
          : `${name} childcare`);

    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { "User-Agent": "StoryparkSmartSaver/2.1.0 (contact: github.com/StoryparkSmartSaver)" } }
    );
    const results = await resp.json();
    if (results.length === 0) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch {
    return null;
  }
}

/* ================================================================== */
/*  Centre discovery + geocoding                                       */
/* ================================================================== */

/**
 * Merge newly-discovered centre names (and optional addresses) into the
 * persisted centreLocations map without overwriting existing GPS data.
 * Each key is a centre name; values are { lat, lng, address }.
 *
 * Accepts either:
 *   • string[]               – names only (backward-compatible)
 *   • { name, address? }[]   – with optional address for richer data
 *
 * When an address is available and GPS coordinates are not yet set,
 * auto-geocoding via Nominatim is attempted in the background.
 *
 * @param {(string|{name:string, address?:string})[]} centres
 */
export async function discoverCentres(centres) {
  if (!centres || centres.length === 0) return;
  const { centreLocations = {} } = await chrome.storage.local.get("centreLocations");
  let changed = false;
  const toGeocode = [];

  for (const centre of centres) {
    const name    = (typeof centre === "string" ? centre : centre.name || "").trim();
    const address = typeof centre === "string" ? null : (centre.address || null);
    if (!name) continue;

    if (!(name in centreLocations)) {
      centreLocations[name] = { lat: null, lng: null, address };
      changed = true;
      if (address) toGeocode.push({ name, address });
    } else {
      if (address && centreLocations[name].address == null) {
        centreLocations[name].address = address;
        changed = true;
      }
      if (address && centreLocations[name].lat == null) {
        toGeocode.push({ name, address });
      }
    }
  }

  if (changed) {
    await chrome.storage.local.set({ centreLocations });
    // Also persist to IDB centreProfiles (v11) — richer storage, fully backupable
    for (const name of Object.keys(centreLocations)) {
      const loc = centreLocations[name];
      saveCentreProfile({
        centreName: name,
        address: loc.address || null,
        lat: loc.lat ?? null,
        lng: loc.lng ?? null,
      }).catch(() => {});
    }
  }

  // Auto-geocode new centres that have an address but no GPS coords yet.
  // Runs in the background (fire-and-forget) so it does not block callers.
  if (toGeocode.length > 0) {
    (async () => {
      for (const { name, address } of toGeocode) {
        const { centreLocations: current = {} } = await chrome.storage.local.get("centreLocations");
        if (current[name]?.lat != null) continue; // already geocoded by another path
        await new Promise((r) => setTimeout(r, NOMINATIM_RATE_LIMIT_MS));
        const coords = await geocodeCentre(name, address);
        if (coords) {
          current[name] = { ...(current[name] || {}), lat: coords.lat, lng: coords.lng, address };
          await chrome.storage.local.set({ centreLocations: current });
          // Also update IDB centreProfiles with GPS (v11)
          updateCentreGPS(name, coords.lat, coords.lng).catch(() => {});
          console.debug(`[centres] Auto-geocoded "${name}": ${coords.lat}, ${coords.lng}`);
        }
      }
    })();
  }
}
