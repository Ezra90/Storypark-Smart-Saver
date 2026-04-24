/**
 * msg-validator.js — Message input validation helpers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  Lightweight validation utilities for chrome.runtime.onMessage     │
 * │  payloads.  Call these at the start of every message handler to    │
 * │  catch bad inputs early and produce clear error messages instead   │
 * │  of cryptic TypeError deep inside the handler.                     │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Business logic — this file only checks types and required fields. │
 * │  Schema knowledge lives in lib/storypark-api.js.                   │
 * │  Data rules live in lib/data-service.js.                           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * USAGE PATTERN (call at the top of every handler):
 *
 *   case "EXTRACT_LATEST": {
 *     const childId   = requireString(msg.childId,   "childId");
 *     const childName = requireString(msg.childName, "childName");
 *     // ... handler body
 *   }
 *
 * If validation fails, the function throws a plain Error with a helpful
 * message — the switch case wraps it in sendResponse({ ok: false, error }).
 *
 * EXPORTS:
 *   requireString(val, name)       — must be a non-empty string
 *   requireId(val, name)           — must be a non-empty string (alias; semantic sugar)
 *   requireArray(val, name)        — must be an Array
 *   requireObject(val, name)       — must be a plain Object
 *   optionalString(val, fallback)  — string or fallback (default "")
 *   optionalBool(val, fallback)    — boolean or fallback (default false)
 *   optionalNumber(val, fallback)  — number or fallback (default 0)
 *   coerceChildId(val)             — coerces to string, validates non-empty
 *   validateLevel(val)             — must be INFO | SUCCESS | WARNING | ERROR
 */

/* ================================================================== */
/*  String validators                                                  */
/* ================================================================== */

/**
 * Validate that a value is a non-empty string.
 * Trims whitespace before the non-empty check.
 *
 * @param {*}      val  — Value to validate
 * @param {string} name — Field name for the error message
 * @returns {string}    — The trimmed string
 * @throws {Error}      — If val is not a non-empty string
 */
export function requireString(val, name) {
  if (typeof val !== "string") {
    throw new Error(`[msg] "${name}" must be a string, got ${typeof val}${val == null ? "" : ` (${JSON.stringify(val).slice(0, 50)})`}`);
  }
  const trimmed = val.trim();
  if (!trimmed) {
    throw new Error(`[msg] "${name}" must not be empty`);
  }
  return trimmed;
}

/**
 * Alias for requireString — semantic sugar for ID fields.
 * Storypark IDs are always strings (not numbers) in our codebase.
 *
 * @param {*}      val  — Value to validate
 * @param {string} name — Field name for the error message
 * @returns {string}    — The coerced string ID
 */
export function requireId(val, name) {
  // Storypark sometimes returns numeric IDs in older API responses.
  // Coerce to string, but only if it looks like a valid ID (number or string).
  if (typeof val === "number" && Number.isFinite(val)) {
    return String(val);
  }
  return requireString(val, name);
}

/**
 * Return val as a string if it is a string, otherwise return fallback.
 *
 * @param {*}      val
 * @param {string} [fallback=""]
 * @returns {string}
 */
export function optionalString(val, fallback = "") {
  if (typeof val !== "string") return fallback;
  return val; // do NOT trim — callers may need the original whitespace
}

/* ================================================================== */
/*  Array / object validators                                          */
/* ================================================================== */

/**
 * Validate that a value is an Array (may be empty).
 *
 * @param {*}      val
 * @param {string} name
 * @returns {Array}
 * @throws {Error}
 */
export function requireArray(val, name) {
  if (!Array.isArray(val)) {
    throw new Error(`[msg] "${name}" must be an Array, got ${typeof val}`);
  }
  return val;
}

/**
 * Validate that a value is a plain object (not null, not array).
 *
 * @param {*}      val
 * @param {string} name
 * @returns {Object}
 * @throws {Error}
 */
export function requireObject(val, name) {
  if (val == null || typeof val !== "object" || Array.isArray(val)) {
    throw new Error(`[msg] "${name}" must be a plain Object, got ${val === null ? "null" : (Array.isArray(val) ? "Array" : typeof val)}`);
  }
  return val;
}

/* ================================================================== */
/*  Optional / coercion helpers                                        */
/* ================================================================== */

/**
 * Return val as a boolean if it is a boolean, otherwise return fallback.
 *
 * @param {*}       val
 * @param {boolean} [fallback=false]
 * @returns {boolean}
 */
export function optionalBool(val, fallback = false) {
  if (typeof val === "boolean") return val;
  return fallback;
}

/**
 * Return val as a number if it is a finite number, otherwise return fallback.
 *
 * @param {*}     val
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function optionalNumber(val, fallback = 0) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  return fallback;
}

/**
 * Coerce val to a string ID (Storypark-safe — handles both string and number IDs).
 * Returns "" if val is null/undefined/empty.
 *
 * @param {*} val
 * @returns {string}
 */
export function coerceChildId(val) {
  if (val == null) return "";
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  if (typeof val === "string") return val.trim();
  return "";
}

/* ================================================================== */
/*  Enumeration validators                                             */
/* ================================================================== */

/** Valid activity log levels. */
const VALID_LOG_LEVELS = new Set(["INFO", "SUCCESS", "WARNING", "ERROR"]);

/**
 * Validate that val is a valid activity log level.
 * Falls back to "INFO" if invalid (non-fatal — log should not crash the app).
 *
 * @param {*} val
 * @returns {"INFO"|"SUCCESS"|"WARNING"|"ERROR"}
 */
export function validateLevel(val) {
  if (VALID_LOG_LEVELS.has(val)) return val;
  console.warn(`[msg-validator] Unknown log level "${val}" — defaulting to INFO`);
  return "INFO";
}

/* ================================================================== */
/*  Composite validator for common message shapes                      */
/* ================================================================== */

/**
 * Validate that a message has the minimum required fields.
 * Returns a normalised copy of the message (IDs coerced to strings).
 * Throws if any required field is missing or wrong type.
 *
 * @param {Object} msg — Raw message from chrome.runtime.onMessage
 * @param {string[]} requiredStrings — Field names that must be non-empty strings
 * @param {string[]} [requiredIds=[]] — Field names that must be non-empty IDs
 * @returns {Object} — Normalised message (safe to use in handler body)
 * @throws {Error}
 *
 * @example
 * case "EXTRACT_LATEST": {
 *   const { childId, childName } = validateMsg(msg,
 *     ["childName"],     // requiredStrings
 *     ["childId"]        // requiredIds (may be number → coerced to string)
 *   );
 *   // childId is guaranteed to be a non-empty string
 * }
 */
export function validateMsg(msg, requiredStrings = [], requiredIds = []) {
  const result = { ...msg };
  for (const field of requiredStrings) {
    result[field] = requireString(msg[field], field);
  }
  for (const field of requiredIds) {
    const coerced = coerceChildId(msg[field]);
    if (!coerced) {
      throw new Error(`[msg] "${field}" must be a non-empty ID, got ${JSON.stringify(msg[field])}`);
    }
    result[field] = coerced;
  }
  return result;
}
