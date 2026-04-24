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

### Database Repair Messages
| Type | Sender | Payload | Response |
|------|--------|---------|----------|
| `REBUILD_DATABASE_FROM_DISK` | dashboard | `{ childId, childName, diskFolders: [{folderName, files[]}] }` | `{ ok, matched, recovered, errors, totalFolders }` |

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

---

## 10. File Size Rules

AI agents must keep files within these limits so smaller models can stay in context for a single file edit.

| File | Max lines | Max KB | Action if exceeded |
|------|-----------|--------|-------------------|
| `background.js` | ~2,500 | 40 KB | Wire more cases to handler files; remove inline duplicates |
| `dashboard.js` | ~800 | 35 KB | Split into dashboard-scan.js, dashboard-review.js, dashboard-settings.js, dashboard-cleanup.js |
| `offscreen.js` | ~1,500 | 65 KB | Split into offscreen-face.js + offscreen-exif.js + offscreen-card.js |
| `lib/scan-engine.js` | ~1,700 | 70 KB | Split at helper/pipeline boundary |
| `lib/db.js` | ~2,500 | 100 KB | Split by store group |
| `lib/handlers-*.js` | ~600 | 25 KB | Split by domain |
| All other lib files | ~400 | 20 KB | Refactor into sub-modules |

### Splitting protocol
1. Create the new file with a `┌─ WHAT THIS FILE OWNS ─┐` header comment
2. Move the relevant code
3. Import in the parent file
4. Run `node scripts/verify-imports.js` → must show 0 errors
5. Commit immediately with message `"refactor: split X into Y"`
6. Update §5 Module Responsibilities in this file

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
| Fix Photo Metadata | ✅ | dashboard.js `wireSettingsEvents()` |
| Re-evaluate All Photos | ✅ | dashboard.js `runReEvaluateAll()` |
| Download Approved (Batch) | ✅ | background.js broadcasts `eta`; dashboard shows it in BATCH_PROGRESS handler |
| Offline Facial Scan (Scan tab) | ✅ | `triggerOfflineScan()` in dashboard.js |
| Offline Smart Scan (Settings) | ✅ | `runOfflineScan()` in dashboard.js |
| Clean Up Folder | ✅ | `runCleanup()` in dashboard.js |
