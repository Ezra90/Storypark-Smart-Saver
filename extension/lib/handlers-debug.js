/**
 * handlers-debug.js — Diagnostic log + debug mode handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All message handlers related to the developer diagnostic log,     │
 * │  debug capture mode, and the attendance diagnostic tool.           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  User-facing activity log → lib/log-manager.js + background.js     │
 * │  debugCaptureMode flag storage → background.js (module-level var)  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ALL HANDLERS: async (msg, ctx) => { ok: true, ...data } | { ok: false, error }
 *
 * HANDLED MESSAGES:
 *   GET_DIAGNOSTIC_LOG, CLEAR_DIAGNOSTIC_LOG, SET_DEBUG_CAPTURE_MODE,
 *   RUN_ATTENDANCE_DIAGNOSTIC
 */

import { apiFetch, smartDelay, STORYPARK_BASE } from "./api-client.js";
import {
  getDiagnosticLog, clearDiagnosticLog, isDebugMode,
} from "./debug.js";

/* ================================================================== */
/*  Diagnostic log                                                     */
/* ================================================================== */

/**
 * GET_DIAGNOSTIC_LOG — Return all captured API responses + centreLocations.
 * Used by the "Download Debug Log" button in Settings → Debug.
 *
 * @param {Object} msg
 * @param {import('./types.js').HandlerContext} ctx
 */
export async function handleGetDiagnosticLog(msg, ctx) {
  try {
    const { centreLocations = {} } = await chrome.storage.local.get("centreLocations");
    return {
      ok: true,
      log: getDiagnosticLog(),
      centreLocations,
      capturedAt: new Date().toISOString(),
      debugCaptureMode: isDebugMode(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * CLEAR_DIAGNOSTIC_LOG — Empty the in-memory diagnostic log.
 * Does NOT affect the disk file (Database/debug_log.json).
 *
 * @param {Object} msg
 */
export async function handleClearDiagnosticLog(msg, ctx) {
  try {
    clearDiagnosticLog();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * SET_DEBUG_CAPTURE_MODE — Toggle verbose API response capture.
 * When enabled, every apiFetch() call is stored in the diagnostic log.
 *
 * IMPORTANT: This handler sets chrome.storage.local.debugCaptureMode
 * but background.js ALSO needs to update its module-level variable.
 * The response includes the new value so background.js can sync it.
 *
 * @param {{ enabled: boolean }} msg
 */
export async function handleSetDebugCaptureMode(msg, ctx) {
  try {
    const enabled = msg.enabled === true;
    await chrome.storage.local.set({ debugCaptureMode: enabled });
    return { ok: true, debugCaptureMode: enabled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Attendance diagnostic                                              */
/* ================================================================== */

/**
 * RUN_ATTENDANCE_DIAGNOSTIC — Compare story dates vs routine dates for
 * each child to help users understand which days the attendance filter
 * would skip.
 *
 * Returns per-child comparison rows: { date, hasStories, hasRoutine, wasPresent }
 *
 * @param {Object} msg — (no required fields)
 */
export async function handleRunAttendanceDiagnostic(msg, ctx) {
  try {
    const { children = [] } = await chrome.storage.local.get("children");
    if (children.length === 0) {
      return { ok: false, error: "No children found. Refresh profile first." };
    }

    const results = [];

    for (const child of children) {
      const childId = child.id;
      const childName = child.name;

      // Fetch first 5 pages of stories (~50 stories)
      const storyDates = new Map(); // date → { titles, storyCount, totalPhotos }
      let pageToken = null;
      for (let page = 0; page < 5; page++) {
        const url = new URL(`${STORYPARK_BASE}/api/v3/children/${childId}/stories`);
        url.searchParams.set("sort_by", "updated_at");
        url.searchParams.set("story_type", "all");
        if (pageToken) url.searchParams.set("page_token", pageToken);
        const data = await apiFetch(url.toString());
        const stories = data.stories || [];
        for (const s of stories) {
          const date = (s.created_at || "").split("T")[0];
          if (!date) continue;
          if (!storyDates.has(date)) storyDates.set(date, []);
          storyDates.get(date).push({
            id: s.id,
            title: s.display_subtitle || s.excerpt || "(untitled)",
            mediaCount: (s.media || []).length,
          });
        }
        pageToken = data.next_page_token;
        if (!pageToken) break;
        await new Promise(r => setTimeout(r, 800));
      }

      // Fetch routine data for each date in storyDates
      const routineByDate = new Map();
      let routinePageToken = "null";
      let routinePages = 0;
      const targetDates = new Set(storyDates.keys());

      while (routinePages < 10 && targetDates.size > 0) {
        try {
          const rUrl = `${STORYPARK_BASE}/api/v3/children/${childId}/daily_routines?page_token=${routinePageToken}`;
          const rData = await apiFetch(rUrl);
          for (const r of (rData.daily_routines || [])) {
            if (targetDates.has(r.date)) {
              const events = (r.events || []).map(e => e.title || e.routine_type || "event");
              routineByDate.set(r.date, events);
              targetDates.delete(r.date);
            }
          }
          routinePageToken = rData.next_page_token;
          if (!routinePageToken) break;
          routinePages++;
          await new Promise(r => setTimeout(r, 800));
        } catch { break; }
      }

      // Build comparison rows
      const dateList = [...storyDates.keys()].sort().reverse();
      const rows = dateList.map(date => {
        const stories  = storyDates.get(date) || [];
        const routine  = routineByDate.get(date) || [];
        return {
          date,
          hasStories:   stories.length > 0,
          storyCount:   stories.length,
          storyTitles:  stories.map(s => s.title).slice(0, 3),
          totalPhotos:  stories.reduce((sum, s) => sum + s.mediaCount, 0),
          hasRoutine:   routine.length > 0,
          routineEvents: routine.slice(0, 5),
          wasPresent:   routine.length > 0,
        };
      });

      results.push({ childId, childName, rows });
    }

    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
