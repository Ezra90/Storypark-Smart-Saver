# AI_RULES.md — Storypark Smart Saver
> **This is the single source of truth for all AI agents.**  
> `.clinerules` is a short pointer that directs AI to read this file first.  
> The human owner does NOT manually maintain rules — **AI agents must update this file** whenever new patterns, bugs, or invariants are discovered.

---

## ⚡ Section 0 — AI Self-Maintenance (READ THIS FIRST)

This project is designed for **fully AI-driven maintenance**. The human owner relies entirely on AI to keep the codebase, rules, and documentation up to date.

### When AI MUST update this file (AI_RULES.md)
- **New bug discovered and fixed** → add the bug + fix to §8 Common Pitfalls
- **New OOM pattern** → add to §1 OOM Management
- **New anti-abuse pattern** → add to §2 Anti-Abuse
- **New file created** → add to §5 Module Responsibilities + §4 Architecture Map + Directory Structure in ARCHITECTURE.md
- **Root-level file added or removed** → update the Directory Structure section in ARCHITECTURE.md to reflect the change (including annotations for what the file is for)
- **Third-party library added or removed** → update the Third-Party Libraries & Credits table in ARCHITECTURE.md + package.json if applicable
- **New message type added** → add to §6 Message Protocol
- **New invariant established** → add to the relevant section
- **File size limit breached** → update §FILE-SIZES table
- **Status bar or ETA pattern changed** → update §ETA

### How to add a new rule
1. Add it to the relevant section in AI_RULES.md (not .clinerules)
2. Use plain English: WHAT the rule is → WHY → HOW (with code example if needed)
3. Cross-reference related rules with `→ see §SectionName`
4. Never duplicate a rule across sections — link instead
5. Commit AI_RULES.md together with the code that motivated the rule

### You do NOT need permission to update AI_RULES.md
AI agents are expected to update this file as part of normal development. Failure to update it when discovering new invariants is a bug in the AI's behaviour.

### Git operations — USER ONLY
AI agents must NEVER run `git commit`, `git push`, or `git pull`. After making changes:
1. Run `node scripts/verify-imports.js` → must show 0 errors
2. Stop. The user handles all git operations (commit, push, pull) using their own tools or the `.bat` scripts.

Rationale: the user manages when changes are committed and published. The AI's job is to make correct code changes and confirm they are import-clean.

---

## Table of Contents
0. [AI Self-Maintenance](#-section-0--ai-self-maintenance-read-this-first) ← READ FIRST
1. [OOM Management](#1-oom-management)
2. [Anti-Abuse (smartDelay Contract)](#2-anti-abuse-smartdelay-contract)
3. [Database Contract](#3-database-contract)
4. [Architecture Map](#4-architecture-map)
5. [Module Responsibilities](#5-module-responsibilities)
6. [Message Protocol](#6-message-protocol)
7. [4-Phase Face Recognition System](#7-4-phase-face-recognition-system)
8. [Common Pitfalls](#8-common-pitfalls)
9. [Glossary](#9-glossary)
10. [File Size Rules](#10-file-size-rules)
11. [Status Bar ETA Rules](#11-status-bar-eta-rules)

---

## 1. OOM Management

The service worker has a ~512 MB heap limit. A full history scan of 500+ stories with 3–10 photos each = ~2–5 GB of raw image data that must never all be in memory at once.

### Semaphore: MAX_CONCURRENT_DOWNLOADS = 3
Located in `lib/download-pipe.js`. Never bypass this.
- `_enqueueDownload()` enforces the 3-slot semaphore
- Downloads complete asynchronously via `handleDownloadChanged(delta)`
- The semaphore slot is released inside `handleDownloadChanged`
- **Never** call `chrome.downloads.download()` directly — always use `downloadBlob()` or `downloadDataUrl()`

### Blob URL Lifecycle
1. Service worker calls `sendToOffscreen({ type: "CREATE_BLOB_URL", dataUrl })`
2. Offscreen creates `URL.createObjectURL()` and returns `{ blobUrl, blobId }`
3. Service worker passes `blobUrl` to `chrome.downloads.download()`
4. `handleDownloadChanged()` receives `complete` → calls `sendToOffscreen({ type: "REVOKE_BLOB_URL", blobId })`
5. Offscreen calls `URL.revokeObjectURL(blobUrl)` → memory freed

**NEVER** revoke blob URLs manually in the scan loop — only in `handleDownloadChanged`.

### Video OOM Fix (v2.2.x)
Videos can be 50–200 MB. The legacy path (base64 data URL over chrome.runtime message) broke at 48 MB.
- Correct path: `sendToOffscreen({ type: "DOWNLOAD_VIDEO", videoUrl, savePath })`
- Offscreen fetches → Blob → `URL.createObjectURL()` → returns `{ blobUrl, blobId }`
- Service worker calls `downloadVideoFromOffscreen({ blobUrl, blobId, savePath })`
- Same semaphore + onChanged cleanup applies

### GC Yields
```javascript
// In scan loops — yield between each story:
await idleYield(50);   // 50ms — drains microtask queue, allows GC

// Every 10 stories:
await logMemorySnapshot(`after story ${si}/${total} for ${childName}`);
```

`idleYield()` is defined in `background.js`. It is NOT an import — it must remain in background.js.

---

## 2. Anti-Abuse (smartDelay Contract)

Storypark monitors API call frequency. Triggering Cloudflare's WAF (403) or rate limiter (429) mid-scan destroys user experience. The `smartDelay()` system mimics human reading pace.

### Delay Profiles
| Type | Range | Used before |
|------|-------|-------------|
| `FEED_SCROLL` | 800–1500ms | Paginating story feed |
| `READ_STORY` | 2500–6000ms | Fetching a story detail |
| `DOWNLOAD_MEDIA` | 1000–2000ms | Downloading each image/video |

### Coffee Break
Every 15–25 requests, `smartDelay()` pauses for 12–25 seconds.
- Counter stored in `_requestCount` (module-level in `lib/api-client.js`)
- Background.js syncs counter to `chrome.storage.session` so it survives SW sleep
- After a Coffee Break, counter resets to 0 and a new random threshold is set

### Rules
1. `smartDelay("READ_STORY")` before every `apiFetch()` call for story details
2. `smartDelay("FEED_SCROLL")` before every feed pagination call
3. `smartDelay("DOWNLOAD_MEDIA")` before every image/video download sent to offscreen
4. **NEVER** call `apiFetch()` inside `Promise.all()`
5. **NEVER** call multiple `apiFetch()` calls without `await` between them
6. On `RateLimitError` (429 or 403): save checkpoint → set `scanCancelled = true` → break loop

### Error Handling
```javascript
try {
  const story = await apiFetch(url);
} catch (err) {
  if (err.name === "AuthError") {
    await abortAndCheckpoint(si, summaries.length, summaries, "auth");
    break;
  }
  if (err.name === "RateLimitError") {
    await abortAndCheckpoint(si, summaries.length, summaries, "rate_limit");
    break;
  }
  // Non-fatal: log and continue
  await logger("WARNING", `Story ${id} fetch failed: ${err.message}`);
  continue;
}
```

---

## 3. Database Contract

### Storage Layers
| Layer | Owner | Purpose |
|-------|-------|---------|
| `chrome.storage.local` | background.js | Children list, settings, centreLocations (legacy + sync) |
| `chrome.storage.session` | background.js | Volatile scan state (isScanning, cancelRequested, _requestCount) |
| IndexedDB (IDB) | lib/db.js | All persistent app data |
| Disk JSON files | lib/disk-sync.js | Human-readable backup / source of truth |

### IDB Stores and their JSON file equivalents
| IDB Store | JSON File | What it holds |
|-----------|-----------|---------------|
| `descriptors` | `Database/descriptors.json` | Face embeddings per child |
| `negativeDescriptors` | `Database/negative_descriptors.json` | "Not my child" face embeddings |
| `processedStories` | `Database/processed_stories.json` | Story IDs already scanned |
| `reviewQueue` | `Database/review_queue.json` | HITL items awaiting user decision |
| `rejections` | `Database/rejections.json` | storyId+URL pairs user rejected |
| `pendingDownloads` | `Database/pending_downloads.json` | Deferred downloads (Phase 1-3) |
| `downloadedStories` | `Database/manifests.json` | Story manifest (filenames, dates, etc.) |
| `imageFingerprints` | `Database/fingerprints.json` | Face descriptor cache per image URL |
| `storyCache` | _(memory only)_ | Raw API responses for re-scan dedup |
| `childPhases` | `Database/phases.json` | 4-phase progress per child |
| `scanCheckpoints` | _(session storage)_ | Resume position for interrupted scans |
| `childProfiles` | `Database/child_profiles.json` | IDB v11: birthday, regularDays, companies |
| `centreProfiles` | `Database/centre_profiles.json` | IDB v11: GPS coords + address per centre |
| `educators` | `Database/educators.json` | IDB v11: educator names per child+centre |

### Migration Rules
- **Never** rename or restructure an existing IDB store without a migration in `db.js`
- `importLegacyCentreLocations()` migrates chrome.storage.local → IDB on startup
- New IDB stores require a schema version bump in `db.js` (currently v11)
- Backup format (FULL_BACKUP_EXPORT): supports both flat and IDB-v11 structures

### The Dual-Write Rule for centreLocations
`discoverCentres()` in `lib/api-client.js` writes to BOTH:
1. `chrome.storage.local.centreLocations` (legacy, still used by scan engine to look up GPS)
2. IDB `centreProfiles` via `saveCentreProfile()`

Both must be kept in sync. Do NOT change this to single-write without updating all consumers.

---

## 4. Architecture Map

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                                      │
│                                                              │
│  dashboard.html → dashboard.js → chrome.runtime.sendMessage │
│                       │                                      │
│                       ▼                                      │
│  background.js (Service Worker, type: module)               │
│    │  imports: lib/api-client.js                            │
│    │           lib/download-pipe.js                         │
│    │           lib/scan-engine.js                           │
│    │           lib/metadata-helpers.js                      │
│    │           lib/html-builders.js                         │
│    │           lib/db.js                                    │
│    │           lib/matching.js                              │
│    │                                                         │
│    │  chrome.runtime.sendMessage (to offscreen)             │
│    │           ▼                                            │
│    │  offscreen.js (DOM context, hidden)                    │
│    │    - Human AI (face detection + embeddings)            │
│    │    - piexifjs (EXIF writing)                           │
│    │    - Canvas (story card rendering)                     │
│    │    - Blob URL lifecycle management                     │
│    │                                                         │
│    │  chrome.downloads.download()                           │
│    │           ▼                                            │
│    │  User's disk (Storypark Smart Saver/ folder)           │
│    │    ├── {ChildName}/Stories/{date} - {title}/           │
│    │    │     ├── story.html                                │
│    │    │     ├── {date}_{child}_{room}_{file}.jpg         │
│    │    │     └── {date} - Story Card.jpg                  │
│    │    ├── {ChildName}/index.html                         │
│    │    ├── index.html                                      │
│    │    └── Database/                                       │
│    │          ├── manifests.json                            │
│    │          ├── descriptors.json                          │
│    │          ├── rejections.json                           │
│    │          └── ... (see DB contract)                     │
│                                                              │
│  lib/disk-sync.js ← dashboard.js (File System Access API)  │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Module Responsibilities

### background.js (~1,200 lines)
**Owns:** Service worker lifecycle, scan state, message router
- Volatile state: `isScanning`, `cancelRequested`, `lastReviewAction`
- Diagnostic log: `_diagnosticLog`, `_diagLog()`, `debugCaptureMode`
- Activity log: `logger()`, `_logBuffer`, `_scheduleLogFlush()`
- Offscreen lifecycle: `ensureOffscreen()`, `sendToOffscreen()`
- Memory instrumentation: `logMemorySnapshot()`, `idleYield()`
- Profile loading: `loadAndCacheProfile()`, `_fetchAndDiscoverInstitutions()`
- Centre discovery: `fetchAndDiscoverCentresFromApi()`, `fetchAndDiscoverFamilyCentresFromApi()`
- Review approve: `handleReviewApprove()` (uses offscreen + db)
- Message router: `chrome.runtime.onMessage` switch statement
- Startup: `chrome.runtime.onInstalled`, `onStartup`, icon click

### lib/api-client.js (~450 lines)
**Owns:** All Storypark API communication
- Exports: `apiFetch`, `smartDelay`, `AuthError`, `RateLimitError`
- Exports: `discoverCentres`, `geocodeCentre`
- Exports: `STORYPARK_BASE`, `DELAY_PROFILES`
- Exports: `initApiClient(opts)`, `getApiState()`, `syncApiState(state)`
- Internal state: `_requestCount`, `_coffeeBreakAt`, `_debugCaptureMode`
- Depends on: `lib/db.js` (saveCentreProfile, updateCentreGPS)

### lib/download-pipe.js (~280 lines)
**Owns:** All chrome.downloads operations + OOM-safe pipeline
- Exports: `downloadBlob`, `downloadDataUrl`, `downloadHtmlFile`, `downloadVideoFromOffscreen`
- Exports: `MAX_CONCURRENT_DOWNLOADS`, `handleDownloadChanged`
- Exports: `initDownloadPipe({ sendToOffscreen })`
- Internal state: `_activeDownloads`, `_downloadQueue`, `_pendingDownloadIds`
- Depends on: `lib/metadata-helpers.js` (sanitizeSavePath)

### lib/scan-engine.js (~1,600 lines)
**Owns:** Main scan pipeline and all scan helpers
- Exports: `runExtraction(childId, childName, mode, opts)`
- Exports: `initScanEngine({ logger, getCancelRequested, sendToOffscreen })`
- Internal: `fetchStorySummaries`, `fetchRoutineSummary` + helpers
- Internal: `bulkFetchAttendanceDates`, `computeAutoThreshold`
- Internal: `extractRoomFromTitle`, `normaliseRoomName`, `buildRoomMap`, `inferRoom`
- Depends on: all lib/ modules + db.js + matching.js

### lib/metadata-helpers.js (~240 lines)
**Owns:** All pure string/date/EXIF helper functions (no side effects)
- Exports: `formatDateDMY`, `formatETA`
- Exports: `sanitizeName`, `sanitizeSavePath`
- Exports: `stripHtml`, `stripEmojis`
- Exports: `calculateAge`
- Exports: `buildExifMetadata`, `sanitiseForExif`, `sanitiseForIptcCaption`

### lib/html-builders.js (~380 lines)
**Owns:** Story HTML + index page generation (pure functions, no side effects)
- Exports: `buildStoryHtml`, `buildChildrenIndexHtml`, `buildMasterIndexHtml`
- Depends on: `lib/metadata-helpers.js`

### scripts/generate-output-examples.mjs (dev utility)
**Owns:** Optional sample output on the Desktop for demos and template tuning
- Reads existing `story.html` under `%USERPROFILE%\Downloads\Storypark Smart Saver\…` (override with `STORYPARK_DATA_ROOT`), copies a few real JPEGs + `*Story Card*.jpg`, regenerates `story.html` via `buildStoryPage` with default `mergeTemplateSettings`, writes `metadata-exif-preview.html` (resolved EXIF title/subject/comments from default templates)
- Run: `npm run examples:output` or `node scripts/generate-output-examples.mjs`; output dir: `STORYPARK_EXAMPLES_OUT` or `%USERPROFILE%\Desktop\Storypark-Output-Examples`
- Not shipped in the extension

### scripts/rehydrate-manifests-from-details.mjs (one-time repair utility)
**Owns:** One-time repair for older downloaded stories with flattened body text
- Reads `Database/manifests.json` + `Database/story_details.json` under `STORYPARK_DATA_ROOT` (defaults to `%USERPROFILE%\Downloads\Storypark Smart Saver`)
- Rebuilds `storyBody` using `normaliseStoryText` so paragraphs survive; updates `excerpt`; regenerates per-story `story.html` on disk without rescanning API
- Creates timestamped backup of `manifests.json` before write
- Run: `npm run repair:rehydrate` or `node scripts/rehydrate-manifests-from-details.mjs`

### lib/db.js (existing — do NOT restructure)
**Owns:** All IndexedDB read/write operations
- All functions are pure IDB wrappers with no business logic

### lib/handlers-rebuild.js (~280 lines)
**Owns:** Cold-start database rebuild from on-disk story folders + Storypark API
- Exports: `handleRebuildDatabaseFromDisk(msg, ctx)`
- Algorithm: fetch full story feed → match disk folder names to story IDs by date+title → create manifests + mark processed
- Anti-abuse: uses `smartDelay("FEED_SCROLL")` before every feed page API call
- Respects `ctx.getCancelRequested()` and sends PROGRESS messages with ETA
- WHY SEPARATE FILE: `handlers-audit.js` is at its 600-line limit; rebuild is a different domain (cold-start DB repair vs ongoing audit of a populated DB)

### lib/handlers-face-model.js (~450 lines)
**Owns:** Advanced face-model lifecycle operations
- Exports: `handleSelfImproveFaceModel`, `handleRunInitialFaceBootstrap`
- Exports: `handleGetFaceModelHealth`, `handleSetFaceHoldoutSet`
- Exports: `handleGetDecisionAuditSummary`, `handleRunRetentionMaintenance`
- OOM rule: use child-scoped fingerprint reads (`getChildFingerprints`) instead of full-cache reads for long loops
- WHY SEPARATE FILE: keeps `background.js` as a thin router and isolates Google Photos-style model behavior in one domain module

### lib/disk-sync.js (existing — do NOT restructure)
**Owns:** File System Access API operations
- `linkFolder`, `getLinkedFolder`, `clearLinkedFolder`
- `walkFolder`, `readFileAsDataUrl`
- `reconcileWithCache`, `repairManifestFromDisk`
- `moveFileToRejected`, `restoreFromRejected`, `deleteFile`

---

## 6. Message Protocol

All messages from dashboard.js → background.js use `send({ type: "...", ...payload })`.

### Scan Messages
| Type | Sender | Payload | Response |
|------|--------|---------|----------|
| `EXTRACT_LATEST` | dashboard | `{ childId, childName }` | `{ ok, stats }` |
| `DEEP_RESCAN` | dashboard | `{ childId, childName }` | `{ ok, stats }` |
| `EXTRACT_ALL_LATEST` | dashboard | `{ childId }` | `{ ok, stats }` |
| `DEEP_RESCAN_ALL` | dashboard | `{ childId }` | `{ ok, stats }` |
| `CANCEL_SCAN` | dashboard | — | `{ ok }` |
| `RESUME_SCAN` | dashboard | `{ childId, childName }` | `{ ok, stats }` |

### Review Messages
| Type | Sender | Payload | Response |
|------|--------|---------|----------|
| `GET_REVIEW_QUEUE` | dashboard | — | `{ ok, queue }` |
| `REVIEW_APPROVE` | dashboard | `{ id, selectedFaceIndex }` | `{ ok }` |
| `REVIEW_REJECT` | dashboard | `{ id }` | `{ ok }` |
| `REVIEW_TRAIN_ONLY` | dashboard | `{ id, selectedFaceIndex }` | `{ ok }` |
| `UNDO_LAST_REVIEW` | dashboard | — | `{ ok }` |
| `SELF_IMPROVE_FACE_MODEL` | dashboard-settings | `{ childId, childName }` | `{ ok, checked, recoveredRejected, reinforcedApproved, reviewedCandidates }` |
| `RUN_INITIAL_FACE_BOOTSTRAP` | dashboard-settings | `{ childId, childName }` | `{ ok, fingerprints, seededPositive, queuedReview, holdoutCount }` |
| `GET_FACE_MODEL_HEALTH` | dashboard-settings | `{ childId }` | `{ ok, health, holdout }` |
| `GET_DECISION_AUDIT_SUMMARY` | dashboard-settings | `{ childId }` | `{ ok, total, byDecision, latest }` |
| `RUN_RETENTION_MAINTENANCE` | dashboard-settings | `{ maxDecisionEntries, negativeMaxAgeDays, fingerprintMaxAgeDays }` | `{ ok, decision, face }` |

### Database Repair Messages
| Type | Sender | Payload | Response |
|------|--------|---------|----------|
| `REBUILD_DATABASE_FROM_DISK` | dashboard | `{ childId, childName, diskFolders: [{folderName, files[]}] }` | `{ ok, matched, recovered, errors, totalFolders }` |

### Template preview (dashboard-settings)
| Type | Sender | Payload | Response |
|------|--------|---------|----------|
| `PREVIEW_TEMPLATE_SETTINGS` | dashboard-settings | `{ settings, previewMode, targetMode }` | `{ ok, source, sourceNotes, previewNotes, truncationFlags, rawTemplate, rendered: { html, card, exifTitle }, lengths }` |

- **truncationFlags**: `{ html, card, exifTitle }` booleans — whether each rendered string hit its max-length or sanitization path vs an unconstrained render of the same template for that preview.
- **previewNotes**: human-readable notes (brief-mode body trim, general caps, per-flag “this sample was limited” lines).

- **matched**: folders matched to real Storypark story IDs via API + date/title comparison
- **recovered**: folders that couldn't be matched → `recovered_` manifest entries created
- Sets `isScanning=true`, sends PROGRESS messages, broadcasts SCAN_COMPLETE on finish
- Anti-abuse: `smartDelay("FEED_SCROLL")` before every feed page call
- Use-case: Database/ files missing or from an old version; all stories already downloaded

### Background → Dashboard (broadcast)
| Type | When | Payload |
|------|------|---------|
| `LOG_ENTRY` | Every logger() call | `{ entry: { level, message, timestamp } }` |
| `PROGRESS` | Each story processed | `{ current, total, childName, date, eta }` |
| `REVIEW_QUEUE_UPDATED` | Queue changed | — |
| `SCAN_COMPLETE` | Scan ends | — |
| `PHASE_ADVANCED` | Child advances phase | `{ phase }` |

---

## 7. 4-Phase Face Recognition System

```
Phase 1 (Discovery, 0–9 verified)
  autoThreshold = 100% → nothing auto-approves
  ALL face photos → review queue
  No downloads to disk
  
Phase 2 (Validation, 10–49 verified)
  autoThreshold = 95% → only clear matches auto-approve
  Most photos → review queue  
  No downloads to disk

Phase 3 (Confident, 50–99 verified)
  autoThreshold = auto-calibrated from positive/negative descriptors
  Downloads deferred (addPendingDownload) → user clicks "Download Approved"
  
Phase 4 (Production, 100+ verified, 80%+ model confidence)
  Fully hands-off — photos auto-download immediately
  Review queue only for truly ambiguous matches
```

Phase advancement: `advancePhase(childId)` is called after the queue empties or scan completes. The phase badge in the dashboard updates via `loadChildPhase()`.

---

## 8. Common Pitfalls

### `refreshQuickStartStates` early return
`dashboard.js` `refreshQuickStartStates()` must **not** `return` from the whole function when the startup health banner is hidden. That skipped later quick-start updates (e.g. Face Review step). Use `if (showIfNotDismissed) { … paint banner … }` only.

### PowerShell File Encoding
When writing files with emoji or Unicode via PowerShell commands, always specify UTF-8 BOM encoding or the browser will fail to parse the module. Prefer using write_to_file tool directly.

### Double chrome.downloads.onChanged Handler
`chrome.downloads.onChanged.addListener(...)` must be called exactly ONCE in background.js. Adding it in both background.js AND a lib file will cause duplicate slot releases and missing blob URL revocations.

Solution: `lib/download-pipe.js` exports `handleDownloadChanged(delta)`. Background.js registers the listener and delegates: `chrome.downloads.onChanged.addListener(handleDownloadChanged)`.

### Stale Disk Cache on Startup
After a large backup import or manifest repair, IDB hot caches may be stale. Always call `eagerLoadHotCaches()` after bulk IDB writes, or the next operation may see old data.

### sendToOffscreen vs chrome.runtime.sendMessage
`sendToOffscreen()` is a WRAPPER around `chrome.runtime.sendMessage()` with:
- Retry logic (up to 2 retries with backoff)
- Automatic offscreen document creation via `ensureOffscreen()`

**Never** call `chrome.runtime.sendMessage()` directly to communicate with offscreen. Always use `sendToOffscreen()`.

### _pendingDownloadIds Race Condition
Do NOT delete entries from `_pendingDownloadIds` inside `downloadBlob()` or `downloadDataUrl()`. Only `handleDownloadChanged()` should remove them. If you add cleanup in the download functions, you'll get double-releases of the semaphore.

### Story Card JPEGs Must Never Appear in HTML Gallery or as Thumbnails
Story Cards (`*Story Card.jpg`) are generated JPEG assets for Google Photos import.
They are NOT downloaded media files and must NEVER be in `approvedFilenames` or
rendered as gallery images in `story.html` or index page thumbnails.

**Filter pattern:** `/Story Card\.jpg$/i`

Apply this filter in:
1. `handlers-rebuild.js` Phase 2 — when scanning disk files to populate `mediaFiles`
2. `lib/disk-sync.js` `repairManifestFromDisk()` — when scanning story folders
3. `lib/html-builders.js` `buildStoryPage()` — before rendering `<img>` tags
4. `lib/html-builders.js` `buildChildStoriesIndex()` — thumbnail + photo count
5. `background.js` inline `buildStoryHtml()` — same filter (inline copy of buildStoryPage)

**Correct:** `const mediaFiles = files.filter(f => MEDIA_EXT.test(f) && !/Story Card\.jpg$/i.test(f));`

### isScanning Stale State After SW Crash
MV3 service workers cannot resume a scan loop after a restart (OOM crash, Coffee Break
suspension, or browser restart). `chrome.storage.session` persists `isScanning=true` across
SW micro-suspensions — so an OOM crash mid-scan leaves `isScanning=true` in session forever,
locking the dashboard in "Scan in progress" permanently.

**Fix (background.js):** Never restore `isScanning` from session storage. The module-load
restore block explicitly sets `isScanning = false` unconditionally. The IDB `scanCheckpoints`
store (saved every 5 stories) lets the user click Resume to restart the scan.

```javascript
// CORRECT — never restore isScanning:
chrome.storage.session.get(["_requestCount", "_coffeeBreakAt", "lastReviewAction"]).then(data => {
    isScanning = false;          // always false on SW activation
    cancelRequested = false;     // always false on SW activation
    _requestCount = data._requestCount ?? 0;
    ...
});
chrome.storage.session.set({ isScanning: false, cancelRequested: false }).catch(() => {});
```

### Missing yieldForGC() in Face Detection Loops (OOM Risk)
**Bug:** Loops in `dashboard.js` (like `triggerOfflineScan`, `runCleanup`, `runReEvaluateAll`) iterate over local disk files running face detection, but historically missed calling `await yieldForGC()`. This violated the OOM rule and caused the V8 engine to hold base64 data URLs until the tab crashed on large directories.

**Fix:** Add `await yieldForGC(processed, imageFiles.length, $progressText)` immediately after `updateProgressBar()` in EVERY face-detection loop. The rule is: **every loop that calls `detectFaces()` must call `yieldForGC()` every iteration**.

### Rate Limit Ignorance in Background Loops (Anti-Abuse)
**Bug:** Background loops (like `runAuditAndRepair` or `_fetchAllRoutines`) would hit a 429 Rate Limit from Storypark and either silently break out of the loop (leaving data incomplete) or blindly continue firing failing requests.
**Fix:** Every background loop that calls `apiFetch` MUST explicitly catch `RateLimitError` and pause.
```javascript
if (err.name === "RateLimitError" || err.message.includes("429")) {
  await ctx.logger("WARNING", "⏳ Rate limited — pausing 30s…");
  await new Promise(r => setTimeout(r, 30000));
  // Then either continue to retry, or break/abort cleanly
}
```

### Global State Initialization Leaks
**Bug:** Global flags like `humanAvailable` were declared as `let humanAvailable = false;` and only initialized inside lazily-called functions like `initSettingsTab()`. If a user clicked "Offline Scan" on the Scan tab before ever visiting the Settings tab, the operation would fail because the flag was still `false`.
**Fix:** Always initialize global environment state immediately at the module level (e.g., `const humanAvailable = typeof Human !== "undefined";`), never inside a lazy-loaded tab init function.

### humanAvailable const Reassignment in initSettingsTab
**Bug:** `humanAvailable` was declared as `const` at module level (correct), but then `initSettingsTab()` had a redundant `humanAvailable = typeof Human !== "undefined";` assignment inside it. This threw a `TypeError: Assignment to constant variable` at runtime the first time Settings was visited.
**Fix:** Remove the reassignment line from `initSettingsTab()`. The module-level `const humanAvailable = typeof Human !== "undefined";` is sufficient.

### Tools Tab Not Triggering initSettingsTab
**Bug:** The `switchTab()` function only called `initSettingsTab()` + `loadSettingsChildren()` when switching to `"settings"`. Switching directly to `"tools"` would not wire the Tools tab buttons (link folder, cleanup, audit, mass renamer, etc.) because `wireSettingsEvents()` hadn't been called yet.
**Fix:** Update `switchTab()` to call both functions for `tabName === "settings" || tabName === "tools"`:
```javascript
if (tabName === "settings" || tabName === "tools") {
  initSettingsTab();      // one-time: event wiring (guarded by _settingsInited)
  loadSettingsChildren(); // always: refresh child dropdowns on every tab visit
}
```

### Hardcoded Path Index Ignores _sssLinked State
**Bug:** In `triggerOfflineScan()`, the folder name was extracted with a hardcoded index `pathParts[3]`. This is only correct when the parent folder is linked. When the `Storypark Smart Saver` folder itself is linked (`_sssLinked = true`), path depth is one level shorter, so `pathParts[3]` returns the filename instead of the folder name — causing manifest lookup to silently fail for every image.

**Fix:** Compute the index dynamically:
```javascript
const folderIdx  = _sssLinked ? 2 : 3;
const folderName = pathParts.length >= (folderIdx + 2) ? pathParts[folderIdx] : null;
```
The same pattern is already applied correctly in `runCleanup()` (`_sssLinked2`) — always use `_sssLinked ? 2 : 3` when parsing paths in offline scan loops.

### Guided-Step Label Drift Across UI and Runtime Text
**Bug:** Dashboard HTML labels were updated to parent-facing guided steps, but runtime text in `dashboard-settings.js` (status lines/toasts/resume messages) kept older wording. This creates confusing mismatch for users and makes AI edits harder to keep consistent.

**Fix:** Centralize guided-step wording in a shared constant and reuse it for status/toast strings:
```javascript
const GUIDED_STEP_LABELS = Object.freeze({
  syncCheck: "Step 1–2: Sync & Check",
  downloadLatest: "Step 3: Download Latest",
  checkRestore: "Step 4: Check & Restore Missing",
});
```
Rule: do not hardcode step names in multiple places. Use one constant source in the module and reference it everywhere.

### Decision Log Integrity and Atomic DB Writes
**Bug:** Writing large JSON files directly can leave partially-written files after interruption, and missing decision logs makes model behavior impossible to audit.

**Fix:** Critical `Database/` writes must use temp-file commit flow, and every manual/auto/self-improve face decision must append to `Database/decision_log.jsonl` with thresholds/scores/reason code. Never add face decision logic without audit logging.

### Lightbox Blob URL Memory Leak (_fullImageCache Unbounded)
**Bug:** `openLightbox()` in `dashboard.js` created a `URL.createObjectURL()` Blob URL for every unique photo opened and stored it in `_fullImageCache` with no size limit and no `revokeObjectURL()` calls. Reviewing many photos would silently consume the 512 MB heap until the page crashed.

**Fix:** Add a `MAX_LIGHTBOX_CACHE = 15` cap. Before inserting a new entry, evict and revoke the oldest:
```javascript
if (_fullImageCache.size >= MAX_LIGHTBOX_CACHE) {
  const oldestKey = _fullImageCache.keys().next().value;
  URL.revokeObjectURL(_fullImageCache.get(oldestKey));
  _fullImageCache.delete(oldestKey);
}
_fullImageCache.set(originalUrl, blobUrl);
```
Note: this eviction pattern (oldest-first via `Map.keys().next().value`) relies on Maps preserving insertion order, which is guaranteed in all modern JS engines.

### ADD_FILE_TO_MANIFEST Not Removing from rejectedFilenames
**Bug:** The `ADD_FILE_TO_MANIFEST` inline handler in background.js added a rescued filename to `approvedFilenames` but did NOT remove it from `rejectedFilenames`. Since `buildStoryPage` and all HTML builders filter on `rejectedSet.has(f)`, the file remained invisible in story.html and index pages even after being "approved".

**Fix:** When adding a file to `approvedFilenames`, also filter it out of `rejectedFilenames`:
```javascript
const rejected = (manifest.rejectedFilenames || []).filter(f => f !== amFilename);
const current  = manifest.approvedFilenames || [];
const approved = current.includes(amFilename) ? current : [...current, amFilename];
await addDownloadedStory({
  ...manifest,
  approvedFilenames: approved,
  rejectedFilenames: rejected,
  thumbnailFilename: manifest.thumbnailFilename || amFilename,
});
```

### Sync File-Count Mismatch Ignoring rejectedFilenames
**Bug:** Story API sync compared local-vs-API media counts using only `approvedFilenames` (+ queued), ignoring `rejectedFilenames`. If a story had face-rejected files, sync falsely marked it as `requiresRedownload` and could trigger unnecessary full-story rebuild/download flows.

**Fix:** When building `downloadedCountByKey` in `background.js`, include `rejectedFilenames` in the media count used for mismatch detection:
```javascript
const approved = (m.approvedFilenames || []).filter(_isMediaFilenameForApiCompare).length;
const rejected = (m.rejectedFilenames || []).filter(_isMediaFilenameForApiCompare).length;
const queued   = (m.queuedFilenames || []).filter(_isMediaFilenameForApiCompare).length;
downloadedCountByKey.set(key, approved + rejected + queued);
```

**Redownload threshold rule:** set `requiresRedownload` when `localCount !== apiCount`
(both `localCount < apiCount` and `localCount > apiCount`).

**Generated-card exclusion rule:** any generated Story Card filename pattern must be excluded from media-count comparisons, not just legacy `story_card.jpg`.
This includes templated names like `YYYY-MM-DD - {sanitized-title} card.jpg`.

### Story HTML Naming Must Match Folder Base
**Invariant:** Per-story HTML output uses folder-style naming as the primary filename:
`{StoryDate} - {SanitizedTitle}.html`.

Navigation links should target the manifest `storyHtmlFilename` (or computed folder-base HTML name), not hardcoded `story.html`.
Optional legacy `story.html` may be written for compatibility, but it is not the primary path.

### Story Card Naming Must Match Folder Base
**Invariant:** Default Story Card filename must use the same base as the story folder name:
`{StoryDate} - {SanitizedTitle}.jpg` (not `Story Card.jpg`).

Why: keeps exported assets consistent and predictable for manual browsing/desktop workflows.

### Story Card Routine Block Must Mirror HTML Style
**Bug:** Card output could show awkward spacing around routine content (double divider look + large blank gap) and did not visually match the HTML routine treatment.

**Fix:** In `offscreen-card.js`, render routine content inside a rounded, lightly tinted box with a single top separator, then flow directly into footer spacing. Keep the left footer metadata focused on educator/photo/child/centre lines (avoid duplicate Storypark branding text there).

**Rule:** Card visual hierarchy should track HTML structure: full story text first, routine section second (boxed), footer metadata last.

### Classroom Mapping Must Use family_centres Classrooms API
**Invariant:** Room/class mapping should not be inferred from URL slugs or free text alone. Use:
`GET /api/v3/family_centres/{centreId}/classrooms` as the canonical classroom roster.

The response includes `id`, `name`, `child_ids[]`, `room_active`, and classroom permissions.
Build child->room mapping by membership in `child_ids[]`, then apply filters for usable classroom context:
- keep `room_active === true`
- prefer `permissions.community_post.create === true`
- treat admin/info rooms (for example policy/procedure groups) as non-primary unless explicitly requested.

Why: the same child can appear in multiple groups; direct URL/community pages alone are ambiguous.

### Media Reconciliation Must Use storyId + mediaId, Not Position Alone
**Finding:** API media order is mostly stable but not guaranteed to be stable on every repeated fetch.
Probe run showed repeated stories where one story had order drift across observations.

**Rule:** For "what is missing" and re-download decisions:
1. Compare by stable media identity (`storyId` + media item id/key/storypark_id).
2. Use index/order only as a secondary hint for filename mapping.
3. Do targeted per-media repair when IDs differ; reserve full-story rebuild for integrity failures.

Why: CDN URLs can rotate and order can occasionally shift; identity-first avoids unnecessary full-story redownloads.

### Repeated Folder Permission Prompts on Dashboard Load
**Bug:** `getLinkedFolder()` called `verifyPermission()` which unconditionally invoked `requestPermission()` when permission wasn't already granted. Because `getLinkedFolder()` is used in passive UI checks, users could see repeated folder permission prompts even without clicking a folder action.

**Fix:** `verifyPermission(dirHandle, { request })` now defaults to silent `queryPermission` only, and only calls `requestPermission` when explicitly requested by a user-initiated flow.

### API Sync / Scan Proceeding While Database Folder Is Unwritable
**Bug:** Storypark API sync and extraction flows could continue when `Database/` was unavailable (missing link or lost permission), causing file-based stores like `story_catalog.json`, `story_details.json`, and `routine_snapshots.json` to silently miss updates.

**Fix:** Add a preflight write probe (`ensureDatabaseWritable()`) and fail fast before starting sync or extraction. This guarantees API-driven updates are only run when `Database/` is writable.

### Download Started Before API Metadata Sync
**Bug:** A user could start download extraction before running "Sync from Storypark", which means class/location/routine context in local records may be incomplete.

**Fix:** `runExtraction()` now hard-checks sync prerequisites (`sync_state.lastSuccessAt` and child-scoped `story_catalog` rows). If missing, it exits with a clear "Run Sync from Storypark first" error.

### Dead Download State Variables in background.js (logMemorySnapshot Always Shows 0)
**Bug:** After modularising downloads to `lib/download-pipe.js`, background.js still declared its own local `_activeDownloads`, `_downloadQueue`, `_pendingDownloadIds`, and `_releaseDownloadSlot()` that were never updated. `logMemorySnapshot()` referenced these stale locals, always reporting `active=0 queued=0`.

**Fix:** Remove the dead variable declarations from background.js. Export `getDownloadStats()` from `download-pipe.js` and import it in background.js:
```javascript
// download-pipe.js
export function getDownloadStats() {
  return { active: _activeDownloads, queued: _downloadQueue.length };
}
// background.js logMemorySnapshot()
const _dlStats = getDownloadStats();
line += ` — downloads active=${_dlStats.active} queued=${_dlStats.queued}`;
```

### Story Card Filter Missing in REGENERATE_FROM_DISK
**Bug:** `handleRegenerateFromDisk` in `lib/handlers-html.js` and the inline `REGENERATE_FROM_DISK` handler in background.js both filtered disk files with only `MEDIA_EXT.test(f)`. This included `*Story Card.jpg` files in `approvedFilenames`, causing them to appear as gallery images in story.html and in index page thumbnails.

**Fix:** Apply the Story Card filter pattern (documented in §8 "Story Card JPEGs Must Never Appear in HTML Gallery") to the `mediaFiles` filter in both locations:
```javascript
const STORY_CARD_RE = /Story Card\.jpg$/i;
const mediaFiles = diskFiles.filter(f => MEDIA_EXT.test(f) && !STORY_CARD_RE.test(f));
```

### Routine Label 📋 Emoji Inconsistency
**Bug:** `buildStoryPage` in `lib/html-builders.js` was missing the `📋` emoji prefix on the routine label (`<div class="routine-label">Child's Routine</div>`), while the local `buildStoryHtml` copy in background.js had it (`📋 Child's Routine`). Pages generated by different paths had inconsistent styling.

**Fix:** Added `📋` emoji to `buildStoryPage` in html-builders.js to match background.js.

### cancelRequested After Finally Block
Inside `runExtraction`, the `finally` block resets `cancelRequested = false`. Code in the EXTRACT_ALL_LATEST handler that reads `cancelRequested` after `runExtraction` returns will always see `false`. The fix: use `stats.cancelled` returned by `runExtraction`, not `cancelRequested`.

### Background State Persistence
`isScanning` and `cancelRequested` are module-level variables. MV3 service workers can be suspended. Always persist changes to `chrome.storage.session`:
```javascript
isScanning = true;
chrome.storage.session.set({ isScanning: true }).catch(() => {});
```

---

## 9. Glossary

| Term | Definition |
|------|-----------|
| **Phase 1–4** | The 4-stage face recognition learning system (see §7) |
| **deferred downloads** | Photos approved but not yet written to disk (Phase 1-3); stored in `pendingDownloads` IDB store |
| **scan bar** | The progress bar + status text in dashboard Scan tab, driven by `PROGRESS` messages |
| **storyCardsChildSel** | The `<select>` dropdown in Settings tab for generating Story Cards per child |
| **Coffee Break** | Anti-bot 12–25s pause every 15–25 requests in `smartDelay()` |
| **runExtraction** | The main scan loop in `lib/scan-engine.js`; processes each story in order |
| **offscreen document** | A hidden HTML page (offscreen.html) that has DOM access; used for face AI, EXIF, and Canvas |
| **fingerprint cache** | Per-image face descriptor cache (IDB `imageFingerprints`) that speeds up re-scans |
| **centroid** | Average of multiple face descriptors per year-bucket; more robust than individual descriptors |
| **Room map** | Map of year-month → dominant room name, built from story titles by `buildRoomMap()` |
| **checkpoint** | Saved scan position (IDB `scanCheckpoints`) allowing interrupted scans to Resume |
| **manifest** | Per-story record in IDB `downloadedStories` with filenames, dates, educator, etc. |
| **HITL** | Human-in-the-loop: user approves/rejects in Review tab to train the face model |
| **OOM** | Out of memory; the main failure mode for large scans |
| **Hot cache** | In-memory copies of frequently-accessed IDB stores (loaded by `eagerLoadHotCaches()`) |
| **Blob URL revocation** | Calling `URL.revokeObjectURL(url)` to free backing memory after download completes |
| **sanitizeSavePath** | Strips non-ASCII, dashes, etc. from file paths before chrome.downloads |
| **sanitizeName** | Strips filesystem-illegal characters from child/centre/room names |
| **ETA** | Estimated time remaining, displayed in scan progress bar |
| **Recovery story** | Story manifest created from disk files (storyId starts with `recovered_`) |
| **Story template tokens** | HTML/card/EXIF strings use `buildTemplateTokenMap()` + `renderTemplate()` in `metadata-helpers.js`. Canonical names include `[StoryDate]`, `[CentreName]`, `[EducatorName]`; **aliases** `[Date]`, `[Title]`, `[Daycare]`, `[Centre]`, `[Child]`, `[Room]`, `[Educator]` resolve to the same fields. |
| **Disk naming tokens** | Folder/file names use `buildDynamicName()` in `download-pipe.js`. Common tokens include `[Date]`, `[Title]`, `[Daycare]`; **aliases** `[StoryDate]`, `[StoryTitle]`, `[CentreName]`, `[EducatorName]` resolve the same way. |
| **Mass renamer tokens** | Settings → Mass Renamer uses `{CurlyBrace}` placeholders in `dashboard-tools.js` `_renderRenameTemplate()`. Aliases include `{Date}`/`{StoryDate}`, `{Title}`/`{StoryTitle}`, `{Child}`/`{ChildName}`, `{Centre}`/`{Daycare}`/`{CentreName}`, `{Educator}`/`{EducatorName}`; replacements run **longest-token-first** so `{EducatorName}` is not broken by `{Educator}`. |

---

## 10. File Size Rules

These are **soft targets** for AI context friendliness, not hard limits. The goal is to keep individual files small enough that a single AI session can read, understand, and edit the whole file without losing context.

| File | Target lines | Max KB | When to consider splitting |
|------|-------------|--------|---------------------------|
| `background.js` | ~2,500 | 40 KB | Wire more cases to handler files; remove inline duplicates |
| `dashboard.js` | ~800 | 35 KB | Split into dashboard-scan.js, dashboard-review.js, dashboard-settings.js, dashboard-cleanup.js |
| `offscreen.js` | ~1,500 | 65 KB | Split into offscreen-face.js + offscreen-exif.js + offscreen-card.js |
| `lib/scan-engine.js` | ~1,700 | 70 KB | Split at helper/pipeline boundary |
| `lib/db.js` | ~2,500 | 100 KB | Split by store group |
| `lib/handlers-*.js` | ~600 | 25 KB | Split by domain |
| All other lib files | ~400 | 20 KB | Refactor into sub-modules |

### When to split (and when NOT to)
**Split only when** the excess code forms a complete, self-contained domain that makes sense as its own file — e.g., all rebuild logic moved to `handlers-rebuild.js`, all audit logic in `handlers-audit.js`. The new file should be independently readable and understandable.

**Do NOT split** just to hit a line count. Adding a 30-line function does not justify creating a new file. Prefer keeping related logic together.

### Creating new files
New files ARE allowed. When creating a new file:
1. Follow the extension directory structure (lib handlers → `extension/lib/handlers-*.js`, pure helpers → `extension/lib/*.js`)
2. Add a `┌─ WHAT THIS FILE OWNS ─┐` block comment at the top
3. Add to §5 Module Responsibilities in this file
4. Add to ARCHITECTURE.md directory listing + message protocol table (if it handles messages)
5. Run `node scripts/verify-imports.js` → must show 0 errors

### Splitting protocol
1. Create the new file with a `┌─ WHAT THIS FILE OWNS ─┐` header comment
2. Move the relevant code
3. Import in the parent file
4. Run `node scripts/verify-imports.js` → must show 0 errors
5. Update §5 Module Responsibilities in this file

### Current oversized files (as of v3.0)
- `background.js`: ~5,900 lines (target: ~1,000) — handler files exist but not yet wired
- `dashboard.js`: ~4,000 lines (target: ~800) — split into tab modules not yet done

---

## 11. Status Bar ETA Rules

**Every operation that updates a progress bar MUST also calculate and show an ETA.**

This is a UX invariant. Users doing multi-hour scans need time estimates to know whether to wait.

### Background (background.js / scan-engine.js) operations
Use `formatETA(ms)` from `lib/metadata-helpers.js`:
```javascript
// At loop start:
const _loopStart = Date.now();

// Each iteration:
const _done = i - startIndex + 1;
const _left = total - i - 1;
const _elapsed = Date.now() - _loopStart;
const _avgMs = _done > 0 ? _elapsed / _done : 0;
const _eta = (_done >= 3 && _avgMs > 0 && _left > 0) ? formatETA(_avgMs * _left) : "";
chrome.runtime.sendMessage({ type: "PROGRESS", current: i+1, total, eta: _eta, ... });
```

### Dashboard (dashboard.js) operations — Shared UI Helper approach (canonical)
All Settings-tab face-detection loops use the 5 shared UI helpers defined at the top of `dashboard.js`.
**DO NOT** write inline ETA calculations in new code — use the helpers.

#### 5 shared UI helpers (dashboard.js, above `switchTab`)
```javascript
// 1. Disable button + set running label
setOperationRunning($btn, true, "🧹 Idle Label", "⏳ Running…");
setOperationRunning($btn, false, "🧹 Idle Label"); // restore

// 2. Show progress container + reset bar
showOperationProgress($container, $bar, $report, total); // total=null → don't set max yet

// 3. Hide progress container
hideOperationProgress($container);

// 4. Update bar + text with auto-calculated ETA (ONE call per loop iteration)
const loopStart = Date.now();
// ...inside loop:
updateProgressBar($bar, $text, processed, total, loopStart, `Checking ${processed}/${total}: ${filename}`);

// 5. GC yield every 10 + RECYCLE_OFFSCREEN every 50
await yieldForGC(processed, total, $text);
```

#### Canonical Settings-tab operation structure
```javascript
async function runMyOperation() {
  const handle = await getLinkedFolder();
  if (!handle) { toast("Link a folder", "error"); return; }
  // ... prereq checks ...

  setOperationRunning($myBtn, true, "🔧 My Operation", "⏳ Running…");
  showOperationProgress($container, $bar, $report, null);

  // ...build imageFiles...
  $bar.max = imageFiles.length;
  let processed = 0;
  const loopStart = Date.now();

  for (const filePath of imageFiles) {
    processed++;
    updateProgressBar($bar, $text, processed, imageFiles.length, loopStart,
      `Processing ${processed}/${imageFiles.length}: ${filePath.split("/").pop()}`);
    await yieldForGC(processed, imageFiles.length, $text);
    // ...do work...
  }

  setOperationRunning($myBtn, false, "🔧 My Operation");
  hideOperationProgress($container);
  $report.style.display = "block";
  $report.innerHTML = "✅ Done";
}
```

### BATCH_PROGRESS message
The `BATCH_PROGRESS` message from background.js always includes an `eta` field. Dashboard must show it:
```javascript
if (msg.type === "BATCH_PROGRESS") {
  const etaPart = msg.eta ? ` · ⏱ ${msg.eta}` : "";
  $progressText.textContent = `📥 Batch: ${msg.downloaded} downloaded (${pct}%)${etaPart}`;
}
```

### Operations and their ETA status
| Operation | ETA | Where |
|-----------|-----|-------|
| Scan Latest / Scan All | ✅ | `runExtraction()` background.js, PROGRESS message |
| Audit & Repair | ✅ | AUDIT_AND_REPAIR background.js, PROGRESS message |
| Generate HTML / Cards (Post-Processing) | ✅ | `BUILD_HTML_STRUCTURE` in background.js, PROGRESS + SCAN_COMPLETE |
| Fix Photo Metadata | ✅ | dashboard.js `wireSettingsEvents()` |
| Re-evaluate All Photos | ✅ | dashboard.js `runReEvaluateAll()` |
| Download Approved (Batch) | ✅ | background.js broadcasts `eta`; dashboard shows it in BATCH_PROGRESS handler |
| Offline Facial Scan (Scan tab) | ✅ | `triggerOfflineScan()` in dashboard.js |
| Offline Smart Scan (Settings) | ✅ | `runOfflineScan()` in dashboard.js |
| Clean Up Folder | ✅ | `runCleanup()` in dashboard.js |

Post-Processing UX rule: operations triggered from the Post-Processing tab must write start/end/failure entries to the Activity Log, surface live progress on the shared status bar when supported by the backend loop, and honor `CANCEL_SCAN` when the backend loop checks `cancelRequested`.


### 12. Strict UI Decoupling (Manifest V3 Invariant)
1. No Background Logic in UI: The dashboard UI (`dashboard.js` and sub-modules) is strictly a view layer. It must NEVER execute database logic, file system syncs, or API fetches directly. It only sends `chrome.runtime.sendMessage` commands.
2. Decoupled Workflows: The automated scan engine (`scan-engine.js`) must ONLY download raw media (JPG/MP4) and save JSON data. It is strictly forbidden from generating HTML, Story Cards, or rewriting EXIF metadata during the core scan loop.
3. Manual Post-Processing: HTML generation, Story Card generation, and Metadata Application (EXIF/GPS/IPTC) are independent, user-triggered batch processes executed after raw downloads are complete.

## 13. "Disk is Truth" (No Custom Backups)
1. No Import/Export: The extension does not use custom JSON backup export/import functions. The user's local `Storypark Smart Saver/Database/` folder is the canonical backup.
2. State Synchronization: The "Link Folder" / "Verify Disk" functions must reliably read the on-disk JSON files and populate IndexedDB so the background worker knows what has already been downloaded.

## 14. Smart File & Folder Naming (Template Engine)
1. Dynamic Templates: The extension must use a user-defined template system for naming folders, media files, HTML, and Story Cards (e.g., `[Child] - [Class] - [Date]`).
2. Smart Token Filtering: When parsing the template, if a data token (like Class or Routine) is missing or null, the system MUST cleanly remove it and format the delimiters to prevent dangling dashes. 
3. Display Data Preservation: The original, rich text from the Storypark API (including emojis) MUST be preserved in the IndexedDB and JSON files for HTML generation.
4. Strict Filesystem Sanitization: Before writing to disk, the final dynamic string MUST be sanitized to remove illegal Windows characters (`< > : " / \ | ? *`), emojis, and control characters.
5. Length Limits: The final filename string must be truncated to a maximum of 100 characters.