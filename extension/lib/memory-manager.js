/**
 * memory-manager.js — OOM prevention and coordinated cache management
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  Heap pressure monitoring and coordinated "dump and clear" for     │
 * │  all in-memory caches across the extension.  Called between heavy  │
 * │  operations (every N stories in scan loops, every N images in      │
 * │  cleanup/offline-scan loops, between batch downloads).             │
 * │                                                                    │
 * │  With 5,000+ media files the JS heap can grow to 300–400 MB if    │
 * │  routine text, face descriptors, and log buffers are never evicted.│
 * │  This module ensures they are dumped to IDB/disk and cleared       │
 * │  before Chrome kills the service worker process.                   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  The actual flush logic → lib/log-manager.js, lib/data-service.js  │
 * │  The download semaphore → lib/download-pipe.js                     │
 * │  The GC yield primitive → idleYield() (defined inline in callers)  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (in any scan/processing loop):
 *
 *   import { manageMemory } from './lib/memory-manager.js';
 *
 *   // Every N items in the loop:
 *   if (itemIndex % 10 === 0) {
 *     const pressure = await manageMemory({
 *       clearRoutineCache: () => routineCache.clear(),
 *       flushLogBuffer: () => logFlushNow(),
 *       flushMovements: () => flushMovementBuffer(),
 *       sendToOffscreen,
 *       logger,
 *     });
 *     if (pressure === "emergency") break; // let caller decide to abort
 *   }
 *
 * EXPORTS:
 *   OOM_THRESHOLDS         — heap ratio thresholds (60 / 75 / 85 %)
 *   checkMemoryPressure()  — returns "ok"|"warn"|"critical"|"emergency"
 *   manageMemory(ctx)      — check + dump + yield; returns pressure level
 *   shouldRecycleOffscreen(count) — true every 50 items OR at CRITICAL
 *   getHeapStats()         — current { usedMB, limitMB, ratio } for logging
 */

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

/**
 * Heap ratio thresholds (usedJSHeapSize / jsHeapSizeLimit).
 * Chrome service workers typically have a 512 MB soft limit.
 *
 * @readonly
 */
export const OOM_THRESHOLDS = {
  /** Start dumping optional caches (routine text, log buffer). */
  WARN:      0.60,
  /** Dump all dumpable caches including offscreen descriptor cache. */
  CRITICAL:  0.75,
  /** Pause operation until heap drops below 70%, max ~6 seconds. */
  EMERGENCY: 0.85,
};

/** GC yield duration per pressure level (ms). */
const YIELD_MS = { warn: 50, critical: 200, emergency: 500 };

/** How often to recycle the offscreen document (image count). */
const OFFSCREEN_RECYCLE_INTERVAL = 50;

/** Cap for emergency pause retries. */
const EMERGENCY_MAX_RETRIES = 12; // 12 × 500ms = max 6 seconds wait

/* ================================================================== */
/*  Heap monitoring                                                    */
/* ================================================================== */

/**
 * Return current heap statistics.
 * Returns zeros on platforms that don't expose performance.memory.
 *
 * @returns {{ usedMB: number, limitMB: number, ratio: number }}
 */
export function getHeapStats() {
  if (typeof performance === "undefined" || !performance.memory) {
    return { usedMB: 0, limitMB: 0, ratio: 0 };
  }
  const usedMB  = performance.memory.usedJSHeapSize  / 1048576;
  const limitMB = performance.memory.jsHeapSizeLimit / 1048576;
  const ratio   = limitMB > 0 ? usedMB / limitMB : 0;
  return { usedMB: Math.round(usedMB * 10) / 10, limitMB: Math.round(limitMB), ratio };
}

/**
 * Check current heap pressure level.
 * Used by manageMemory() and callers that want to branch on pressure.
 *
 * @returns {"ok"|"warn"|"critical"|"emergency"}
 */
export function checkMemoryPressure() {
  const { ratio } = getHeapStats();
  if (ratio >= OOM_THRESHOLDS.EMERGENCY) return "emergency";
  if (ratio >= OOM_THRESHOLDS.CRITICAL)  return "critical";
  if (ratio >= OOM_THRESHOLDS.WARN)      return "warn";
  return "ok";
}

/* ================================================================== */
/*  Offscreen recycle helper                                           */
/* ================================================================== */

/**
 * Return true if the offscreen document should be recycled.
 * Two conditions trigger a recycle:
 *   1. Every OFFSCREEN_RECYCLE_INTERVAL items (predictable memory flush)
 *   2. Heap pressure is CRITICAL or higher (emergency flush)
 *
 * @param {number} itemsProcessed — running count of images/files processed
 * @returns {boolean}
 */
export function shouldRecycleOffscreen(itemsProcessed) {
  if (itemsProcessed > 0 && itemsProcessed % OFFSCREEN_RECYCLE_INTERVAL === 0) return true;
  const pressure = checkMemoryPressure();
  return pressure === "critical" || pressure === "emergency";
}

/* ================================================================== */
/*  Main entry point                                                   */
/* ================================================================== */

/**
 * Check heap pressure and dump caches as needed.
 * Call this every N iterations in any heavy processing loop.
 *
 * The function is designed to be non-blocking at low pressure and
 * increasingly aggressive as the heap fills.  It never throws —
 * any error in the dump steps is caught and logged, then execution
 * continues so a dump failure doesn't abort a long scan.
 *
 * @param {object} ctx — callbacks supplied by the caller
 * @param {Function}  [ctx.clearRoutineCache]  — () => void  — clears routine text Map
 * @param {Function}  [ctx.flushLogBuffer]     — async () => void — flush activity log buffer
 * @param {Function}  [ctx.flushMovements]     — async () => void — flush file movement buffer
 * @param {Function}  [ctx.sendToOffscreen]    — async (msg) => void — send message to offscreen
 * @param {Function}  [ctx.logger]             — async (level, msg) => void — activity log
 *
 * @returns {Promise<"ok"|"warn"|"critical"|"emergency">} — pressure AFTER dump
 */
export async function manageMemory(ctx = {}) {
  const {
    clearRoutineCache = null,
    flushLogBuffer    = null,
    flushMovements    = null,
    sendToOffscreen   = null,
    logger            = async () => {},
  } = ctx;

  const pressure = checkMemoryPressure();
  if (pressure === "ok") return "ok";

  const { usedMB, limitMB, ratio } = getHeapStats();
  const pctStr = `${(ratio * 100).toFixed(0)}%`;

  // ── WARN: dump optional caches ───────────────────────────────────
  try {
    // 1. Flush activity log buffer → chrome.storage.local
    if (flushLogBuffer) await flushLogBuffer();

    // 2. Flush file movement buffer → IDB
    if (flushMovements) await flushMovements();

    // 3. Clear routine cache — rebuilt on demand from API
    if (clearRoutineCache) clearRoutineCache();
  } catch (err) {
    console.warn("[memory-manager] WARN dump failed (non-fatal):", err.message);
  }

  // Short GC yield
  await new Promise(r => setTimeout(r, YIELD_MS.warn));

  // ── CRITICAL: also drop offscreen descriptor cache ───────────────
  if (pressure === "critical" || pressure === "emergency") {
    try {
      if (sendToOffscreen) {
        await sendToOffscreen({ type: "CLEAR_PROFILE_CACHE" });
      }
    } catch (err) {
      console.warn("[memory-manager] CRITICAL offscreen cache clear failed (non-fatal):", err.message);
    }

    await logger("WARNING",
      `⚠️ Memory pressure ${pctStr} (${usedMB}/${limitMB} MB) — caches cleared to prevent OOM`
    );
    await new Promise(r => setTimeout(r, YIELD_MS.critical));
  }

  // ── EMERGENCY: wait until heap drops below 70% ───────────────────
  if (pressure === "emergency") {
    await logger("ERROR",
      `🛑 Memory EMERGENCY ${pctStr} (${usedMB}/${limitMB} MB) — pausing operation until heap clears`
    );

    let retries = 0;
    while (retries < EMERGENCY_MAX_RETRIES) {
      await new Promise(r => setTimeout(r, YIELD_MS.emergency));
      const newStats = getHeapStats();
      if (newStats.ratio < OOM_THRESHOLDS.CRITICAL) {
        await logger("INFO", `✅ Memory recovered to ${(newStats.ratio * 100).toFixed(0)}% — resuming`);
        break;
      }
      retries++;
    }

    if (retries >= EMERGENCY_MAX_RETRIES) {
      await logger("ERROR", `🛑 Memory did not recover after ${EMERGENCY_MAX_RETRIES} retries — caller should abort and checkpoint`);
      return "emergency"; // Caller should check this and abort
    }
  }

  return checkMemoryPressure(); // Return pressure AFTER dump
}

/* ================================================================== */
/*  Bulk operation helper                                              */
/* ================================================================== */

/**
 * Create a managed loop controller for processing large arrays.
 * Wraps the common pattern of: process item → yield GC → check memory → continue.
 *
 * Usage:
 *   const loop = createManagedLoop({ memCtx, batchSize: 10 });
 *   for (let i = 0; i < items.length; i++) {
 *     await loop.tick(i);  // yields + memory check every batchSize items
 *     // ... process items[i] ...
 *   }
 *
 * @param {object} opts
 * @param {object} opts.memCtx     — context for manageMemory()
 * @param {number} [opts.batchSize=10]  — check memory every N items
 * @param {number} [opts.yieldMs=50]    — GC yield every item
 * @returns {{ tick: (i: number) => Promise<string> }}
 */
export function createManagedLoop({ memCtx = {}, batchSize = 10, yieldMs = 50 } = {}) {
  return {
    /**
     * Called at the start of each loop iteration.
     * @param {number} i — current iteration index
     * @returns {Promise<"ok"|"warn"|"critical"|"emergency">}
     */
    async tick(i) {
      // GC yield every iteration
      if (yieldMs > 0) await new Promise(r => setTimeout(r, yieldMs));
      // Memory check every batchSize iterations
      if (i > 0 && i % batchSize === 0) {
        return manageMemory(memCtx);
      }
      return "ok";
    },
  };
}
