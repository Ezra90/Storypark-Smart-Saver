# ARCHITECTURE.md — Storypark Smart Saver
> System overview, module dependency tree, and message protocol table.  
> Full rules → AI_RULES.md | Quick reference → .clinerules

---

## Extension Overview

Storypark Smart Saver is a Chrome MV3 extension that:
1. Calls Storypark's internal JSON API directly (no DOM scraping)
2. Applies face recognition to identify a specific child in daycare photos
3. Downloads matching photos + videos to the user's local disk
4. Generates HTML story pages and JPEG story cards
5. Embeds EXIF metadata (GPS, date, caption) into downloaded images

---

## Module Dependency Tree

```
background.js (Service Worker)
 ├── lib/api-client.js
 │    └── lib/db.js (saveCentreProfile, updateCentreGPS)
 ├── lib/download-pipe.js
 │    └── lib/metadata-helpers.js (sanitizeSavePath)
 ├── lib/scan-engine.js
 │    ├── lib/api-client.js
 │    ├── lib/download-pipe.js
 │    ├── lib/html-builders.js
 │    ├── lib/metadata-helpers.js
 │    ├── lib/db.js (all scan-related DB ops)
 │    └── lib/matching.js (enhancedMatch, buildCentroids, etc.)
 ├── lib/html-builders.js
 │    └── lib/metadata-helpers.js
 ├── lib/metadata-helpers.js (no deps)
 ├── lib/db.js (no lib deps — raw IDB)
 └── lib/matching.js (no deps — pure math)

dashboard.js (Extension Page)
 ├── dashboard-settings.js
 │    ├── lib/db.js (getDescriptors, setDescriptors)
 │    ├── lib/disk-sync.js (FSA operations)
 │    └── lib/face.js (loadModels)
 ├── dashboard-scan.js
 │    ├── lib/disk-sync.js
 │    ├── lib/db.js (getAllDownloadedStories, etc.)
 │    └── lib/face.js (detectFaces, matchEmbedding)
 ├── dashboard-review.js
 │    └── lib/db.js (getDescriptors)
 ├── lib/face.js
 │    └── lib/human.js (Human AI model)
 ├── lib/db.js
 └── lib/disk-sync.js
```

---

## File Size Targets (post-modularization)

| File | Target Lines | Status |
|------|-------------|--------|
| `extension/background.js` | ~1,200 | Refactored |
| `extension/lib/api-client.js` | ~450 | New |
| `extension/lib/download-pipe.js` | ~280 | New |
| `extension/lib/scan-engine.js` | ~1,600 | New |
| `extension/lib/metadata-helpers.js` | ~240 | New |
| `extension/lib/html-builders.js` | ~380 | New |
| `extension/dashboard.js` | ~600 | Refactored |
| `extension/dashboard-settings.js` | ~800 | New |
| `extension/dashboard-scan.js` | ~700 | New |
| `extension/dashboard-review.js` | ~700 | New |
| `extension/lib/db.js` | ~800 | Existing |
| `extension/lib/disk-sync.js` | ~300 | Existing |
| `extension/lib/matching.js` | ~200 | Existing |
| `extension/lib/face.js` | ~150 | Existing |
| `extension/offscreen.js` | ~800 | Existing |

---

## Message Protocol Table (complete)

### dashboard → background (sendMessage)

| Message Type | Key Payload Fields | Response Shape |
|-------------|-------------------|----------------|
| `GET_CHILDREN` | — | `{ ok, children: [{id,name}] }` |
| `REFRESH_PROFILE` | — | `{ ok, children }` |
| `EXTRACT_LATEST` | `childId, childName` | `{ ok, stats }` |
| `DEEP_RESCAN` | `childId, childName` | `{ ok, stats }` |
| `EXTRACT_ALL_LATEST` | `childId` (all) | `{ ok, stats }` |
| `DEEP_RESCAN_ALL` | `childId` (all) | `{ ok, stats }` |
| `RESUME_SCAN` | `childId, childName` | `{ ok, stats }` |
| `CANCEL_SCAN` | — | `{ ok }` |
| `GET_SCAN_STATUS` | — | `{ ok, isScanning, cancelRequested }` |
| `TEST_CONNECTION` | — | `{ ok, email? }` |
| `GET_REVIEW_QUEUE` | — | `{ ok, queue }` |
| `REVIEW_APPROVE` | `id, selectedFaceIndex` | `{ ok }` |
| `REVIEW_REJECT` | `id` | `{ ok }` |
| `REVIEW_TRAIN_ONLY` | `id, selectedFaceIndex` | `{ ok }` |
| `UNDO_LAST_REVIEW` | — | `{ ok }` |
| `GET_ACTIVITY_LOG` | — | `{ ok, activityLog }` |
| `CLEAR_ACTIVITY_LOG` | — | `{ ok }` |
| `DISCOVER_CENTRES` | — | `{ ok }` |
| `GET_DIAGNOSTIC_LOG` | — | `{ ok, log, centreLocations, capturedAt }` |
| `CLEAR_DIAGNOSTIC_LOG` | — | `{ ok }` |
| `SET_DEBUG_CAPTURE_MODE` | `enabled` | `{ ok }` |
| `SAVE_TRAINING_DESCRIPTOR` | `childId, childName, descriptor` | `{ ok }` |
| `PROCESS_TRAINING_IMAGE` | `childId, childName, imageDataUri, faceIndex` | `{ ok }` |
| `GET_CHILD_PHASE` | `childId` | `{ ok, phase }` |
| `ADVANCE_PHASE` | `childId` | `{ ok, advanced?, phase? }` |
| `RESTORE_PHASE` | `childId, phaseData` | `{ ok }` |
| `GET_MODEL_CONFIDENCE` | `childId` | `{ ok, confidence, details }` |
| `RESET_FACE_DATA` | `childId` | `{ ok }` |
| `RE_EVALUATE_QUEUE` | `childId` | `{ ok, autoApproved, autoRejected }` |
| `GET_PENDING_DOWNLOADS_COUNT` | — | `{ ok, count }` |
| `BATCH_DOWNLOAD_APPROVED` | — | `{ ok, downloaded, failed }` |
| `BUILD_HTML_STRUCTURE` | — | `{ ok, storyCount }` |
| `BUILD_INDEX_PAGES` | — | `{ ok }` |
| `FINAL_VERIFICATION` | `childId` | `{ ok, verified, total, rejected, flagged }` |
| `FULL_BACKUP_EXPORT` | — | `{ ok, backup }` |
| `FULL_BACKUP_IMPORT` | `backup, mergeMode` | `{ ok, imported }` |
| `CLEAR_ALL_REJECTIONS` | — | `{ ok }` |
| `SYNC_PROCESSED_FROM_MANIFEST` | `childId?` | `{ ok, synced, byChild }` |
| `SYNC_PROCESSED_FROM_DISK` | `childId, childName, onDiskPaths` | `{ ok, synced, missing }` |
| `REWRITE_EXIF_ONLY` | `imageDataUrl, date, description, ...` | `{ ok, dataUrl, readBack? }` |
| `RECYCLE_OFFSCREEN` | — | `{ ok }` |
| `REGENERATE_FROM_DISK` | `filesByFolder, childId?` | `{ ok, rebuilt, updated, errors }` |
| `REBUILD_DATABASE_FROM_DISK` | `childId, childName, diskFolders: [{folderName, files[]}]` | `{ ok, matched, recovered, errors, totalFolders }` |
| `ACTIVE_DATABASE_INFO` | — | `{ ok, info }` |
| `AUDIT_STORIES` | `childId?, onDiskPaths, rejectedFilesByChild?` | `{ ok, summary, stories }` |
| `REPAIR_STORY` | `childId, storyId, onlyFilenames?, options?` | `{ ok, downloaded, failed, skipped }` |
| `AUDIT_AND_REPAIR` | `onDiskPaths, rejectedFilesByChild?` | `{ ok, started }` (async) |
| `REBUILD_REJECTIONS_FROM_FOLDERS` | `rejectedFilesByChild` | `{ ok, added }` |
| `GENERATE_STORY_CARDS_ALL` | `childId?` | `{ ok, generated, skipped, errors }` |
| `GENERATE_STORY_CARD` | `title, date, body, ...` | (routed to offscreen) |
| `ADD_FILE_TO_MANIFEST` | `childId, storyId, filename` | `{ ok }` |
| `LOG_TO_ACTIVITY` | `level, message, meta?` | `{ ok }` |
| `GET_SCAN_CHECKPOINT` | `childId` | `{ ok, checkpoint? }` |

### background → dashboard (broadcast sendMessage)

| Message Type | When Sent | Key Payload Fields |
|-------------|-----------|-------------------|
| `LOG` | Legacy scan log message | `{ message }` |
| `LOG_ENTRY` | Every `logger()` call | `{ entry }` |
| `PROGRESS` | Each story loop iteration | `{ current, total, childName, date, eta, childIndex, childCount }` |
| `BATCH_PROGRESS` | During batch download | `{ done, total, downloaded, failed }` |
| `REVIEW_QUEUE_UPDATED` | Review queue changes | — |
| `SCAN_COMPLETE` | Scan finishes (any reason) | — |
| `PHASE_ADVANCED` | Child advances phase | `{ phase }` |
| `AUDIT_REPAIR_DONE` | AUDIT_AND_REPAIR finishes | `{ summary }` |
| `VIDEO_DOWNLOAD_PROGRESS` | Video streaming progress | `{ savePath, percent, mb, totalBytes }` |
| `REFRESH_PROFILES` | Descriptors updated (to offscreen) | — |

### background → offscreen (sendToOffscreen)

| Message Type | Purpose | Response |
|-------------|---------|----------|
| `PROCESS_IMAGE` | Face detect + match + EXIF + download | `{ result, dataUrl?, savePath?, matchPct?, detectedFaces? }` |
| `DOWNLOAD_APPROVED` | Fetch + EXIF stamp + return as dataUrl | `{ dataUrl, savePath }` |
| `DOWNLOAD_VIDEO` | Stream video → Blob URL | `{ blobUrl, blobId, savePath, size?, contentType? }` |
| `DOWNLOAD_TEXT` | Encode text → dataUrl | `{ dataUrl, savePath }` |
| `CREATE_BLOB_URL` | Convert dataUrl → Blob URL | `{ ok, blobUrl, blobId }` |
| `REVOKE_BLOB_URL` | Free blob URL memory | `{ ok }` |
| `REFRESH_PROFILES` | Reload face descriptors from IDB | `{ ok }` |
| `RE_EVALUATE_BATCH` | Batch face-match against fresh model | `{ results: [{id, decision}] }` |
| `GENERATE_STORY_CARD` | Render story card JPEG via Canvas | `{ ok, dataUrl }` |
| `REWRITE_EXIF_ONLY` | Re-stamp EXIF on existing JPEG | `{ ok, dataUrl, readBack? }` |

---

## Scan Pipeline Flow

```
chrome.runtime.onMessage EXTRACT_LATEST / DEEP_RESCAN
  │
  ▼
isScanning = true (set synchronously before first await)
  │
  ▼
runExtraction(childId, childName, mode)  [lib/scan-engine.js]
  │
  ├── Read settings from chrome.storage.local
  ├── getChildPhase(childId)             [lib/db.js]
  ├── computeAutoThreshold(childId)      [lib/scan-engine.js]
  ├── apiFetch(/api/v3/children/{id})    [lib/api-client.js]
  │     ← smartDelay("FEED_SCROLL")
  ├── fetchStorySummaries(childId, mode) [lib/scan-engine.js]
  │     ← paginate via apiFetch
  ├── buildRoomMap(summaries)            [lib/scan-engine.js]
  ├── bulkFetchAttendanceDates(childId)  [if attendanceFilter]
  │
  └── for each story:
        ├── cancelRequested check
        ├── saveScanCheckpoint() every 5 stories
        ├── smartDelay("READ_STORY")
        ├── apiFetch(/api/v3/stories/{id})
        ├── fetchRoutineSummary(childId, date)
        ├── buildExifMetadata(...)        [lib/metadata-helpers.js]
        │
        └── for each image:
              ├── isRejected() check
              ├── getImageFingerprint() → fast path (Phase 3+)
              ├── smartDelay("DOWNLOAD_MEDIA")
              ├── sendToOffscreen(PROCESS_IMAGE)   → offscreen
              │     └── face detect → match → EXIF → blob
              ├── result handling:
              │     approve → downloadDataUrl() or addPendingDownload()
              │     review  → addToReviewQueue()
              │     reject  → appendNegativeDescriptor()
              └── saveImageFingerprint()
        │
        ├── [videos] sendToOffscreen(DOWNLOAD_VIDEO) → downloadVideoFromOffscreen()
        ├── [HTML] buildStoryHtml() → sendToOffscreen(DOWNLOAD_TEXT) → downloadHtmlFile()
        ├── [Card] sendToOffscreen(GENERATE_STORY_CARD) → downloadDataUrl()
        ├── addDownloadedStory()          [lib/db.js]
        ├── markStoryProcessed()          [lib/db.js]
        └── idleYield(50)                 [background.js]
```

---

## Download Pipeline (OOM-safe)

```
downloadDataUrl(dataUrl, savePath)        [lib/download-pipe.js]
  │  _dataUrlToBlob(dataUrl)
  ▼
downloadBlob(blob, savePath)
  │  _enqueueDownload(task)     ← 3-slot semaphore
  ▼
FileReader → readAsDataURL
  │
  ▼
sendToOffscreen(CREATE_BLOB_URL, dataUrl) → { blobUrl, blobId }
  │
  ▼
chrome.downloads.download({ url: blobUrl, filename: savePath })
  │  → returns downloadId
  │  → registers _pendingDownloadIds.set(downloadId, { resolve, reject, blobId })
  │
  ▼  [async: when file writes to disk]
chrome.downloads.onChanged → handleDownloadChanged(delta)
  │  state === "complete"
  ├── _pendingDownloadIds.delete(downloadId)
  ├── sendToOffscreen(REVOKE_BLOB_URL, blobId)  ← free memory
  ├── resolve(downloadId)                       ← unblocks await
  └── _releaseDownloadSlot()                    ← next queued download starts
```

---

## Phase System State Machine

```
[install]
    │
    ▼
Phase 1: Discovery
  verifiedCount < 10
  autoThreshold = 100%
  deferDownloads = true
    │
    │ verifiedCount >= 10 AND queue empties
    ▼
Phase 2: Validation  
  verifiedCount 10–49
  autoThreshold = 95%
  deferDownloads = true
    │
    │ verifiedCount >= 50 AND queue empties
    ▼
Phase 3: Confident
  verifiedCount 50–99
  autoThreshold = auto-calibrated
  deferDownloads = true
    │
    │ verifiedCount >= 100 AND modelConfidence >= 80%
    ▼
Phase 4: Production
  Fully automated
  deferDownloads = false
  Immediate downloads
```

Phase transitions are checked by `advancePhase(childId)` in `lib/db.js`.
Model confidence is computed by `computeModelConfidence(childId)` in `lib/db.js`.

---

## Third-Party Libraries & Credits

| Library | Version | Used as | Purpose |
|---------|---------|---------|---------|
| **[Human.js](https://github.com/vladmandic/human)** by Vladimir Mandić | ^3.3.6 | `extension/lib/human.js` | Face detection, landmark extraction, and embedding generation. The core AI engine behind all face recognition in this extension. Installed via npm → copied into extension by `scripts/setup-libs.js`. |
| **[piexifjs](https://github.com/hMatoba/piexifjs)** by Hiroyuki Matoba | vendored | `extension/lib/exif.js` | EXIF and IPTC metadata writer. Stamps GPS coordinates, date/time, captions, and copyright into downloaded JPEG images. Vendored directly (not in package.json). |
| **[acorn](https://github.com/acornjs/acorn)** | ^8.16.0 | dev script only | JavaScript parser used by `scripts/verify-imports.js` to statically check that all `import` statements reference files that exist. Not shipped in the extension. |
| **[puppeteer-core](https://github.com/puppeteer/puppeteer)** | ^23.11.1 | dev script only | Headless browser used by `scripts/capture-storypark-api.js` to capture live Storypark API responses into `STORYPARK_API_REF.md`. Not shipped in the extension. |

---

## Directory Structure

```
Storypark-Smart-Saver/
├── .clinerules              ← AI agent rules (Cline auto-injects)
├── .github/                 ← GitHub Actions / workflows
├── .gitignore               ← Git ignore rules
├── .human-version           ← Tracks the bundled Human.js version (used by setup-libs.js)
├── AI_RULES.md              ← Full AI reference
├── ARCHITECTURE.md          ← This file
├── README.md
├── STORYPARK_API_REF.md     ← Captured Storypark API response reference (used by AI agents)
├── package.json             ← npm dev-dependency manifest (Human.js, acorn, puppeteer-core)
├── package-lock.json        ← npm lockfile — exact pinned versions of all dev deps (auto-generated, do not edit)
├── scripts/
│   ├── verify-imports.js    ← Import checker (run: node scripts/verify-imports.js)
│   ├── generate-icons.js
│   └── setup-libs.js
└── extension/
    ├── manifest.json
    ├── background.js        ← Service worker (MV3, type: module)
    ├── dashboard.html       ← Full-page dashboard
    ├── dashboard.js         ← Dashboard tab router + init
    ├── dashboard-settings.js← Settings tab logic
    ├── dashboard-scan.js    ← Scan tab + cleanup + offline scan
    ├── dashboard-review.js  ← Review tab logic
    ├── offscreen.html
    ├── offscreen.js         ← Face AI + EXIF + Canvas (DOM context)
    ├── review.html          ← (legacy, not used)
    ├── options.html         ← (redirects to dashboard#settings)
    └── lib/
        ├── api-client.js    ← Storypark API + smartDelay + discoverCentres
        ├── db.js            ← IndexedDB layer (DO NOT RESTRUCTURE)
        ├── disk-sync.js     ← File System Access API (DO NOT RESTRUCTURE)
        ├── download-pipe.js ← Download semaphore + blob URL pipeline
        ├── exif.js          ← EXIF/IPTC writer (piexifjs wrapper)
        ├── face.js          ← Face detection API (Human.js wrapper)
        ├── html-builders.js ← Story HTML + index HTML generators
        ├── human.js         ← Human AI model loader
        ├── matching.js      ← Pure-math face matching (SW-safe)
        ├── handlers-rebuild.js ← REBUILD_DATABASE_FROM_DISK handler (cold-start DB repair via API)
        ├── metadata-helpers.js ← Pure string/date/EXIF helpers
        └── scan-engine.js   ← Main scan pipeline (runExtraction)
```
