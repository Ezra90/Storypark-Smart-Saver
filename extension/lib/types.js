/**
 * types.js — JSDoc type definitions for all domain data shapes
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  All @typedef declarations for data objects used across modules.    │
 * │  Zero runtime code — this file only exists for documentation and    │
 * │  IDE/AI type inference.  Import with:                               │
 * │    @import { StoryManifest } from './types.js' (JSDoc only)         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * AI AGENT NOTE: When reading a function that accepts or returns a complex
 * object, search this file first to understand the data shape before
 * reading the implementation.  If a field is missing from a typedef,
 * add it here so all agents benefit.
 *
 * SCHEMA VERSION: IDB v11 (see lib/db.js openDatabase() for upgrade history)
 */

/* ================================================================== */
/*  Core domain types                                                  */
/* ================================================================== */

/**
 * A child as returned by GET /api/v3/users/me or GET_CHILDREN message.
 * Stored in chrome.storage.local.children[].
 *
 * @typedef {Object} Child
 * @property {string} id    — Storypark child ID (always a string)
 * @property {string} name  — Display name (e.g. "Hugo Hill")
 */

/**
 * A story manifest — one record per story with approved photos.
 * IDB store: downloadedStories.  Disk file: Database/manifests.json.
 *
 * @typedef {Object} StoryManifest
 * @property {string}   childId           — Storypark child ID
 * @property {string}   childName         — Child display name
 * @property {string}   storyId           — Storypark story ID
 * @property {string}   storyTitle        — Plain-text title (HTML stripped)
 * @property {string}   storyDate         — YYYY-MM-DD story date
 * @property {string}   folderName        — Folder name on disk: "YYYY-MM-DD - Title"
 * @property {string[]} approvedFilenames — Files on disk (approved + not rejected)
 * @property {string[]} rejectedFilenames — Files in Rejected Matches/ folder
 * @property {string}   storyBody         — Full story text (may contain HTML)
 * @property {string}   storyRoutine      — Timestamped routine text (plain)
 * @property {string}   excerpt           — First 200 chars of storyBody (plain)
 * @property {string}   childAge          — e.g. "1 year 5 months" at story date
 * @property {string}   educatorName      — Educator's display name
 * @property {string}   roomName          — Classroom/room name
 * @property {string}   centreName        — Childcare centre name
 * @property {string}   thumbnailFilename — First approvedFilename for index page thumb
 * @property {MediaUrlEntry[]} mediaUrls  — originalUrl lookup for each filename
 * @property {Object}   [mediaTypes]      — { [filename]: "image"|"video" }
 * @property {string}   [storyHtmlFilename]  — Filename of story.html (default: "story.html")
 * @property {string}   [storyCardFilename]  — Filename of story card JPEG
 */

/**
 * URL mapping entry inside a StoryManifest.
 * Used to rebuild downloads without re-scanning the API.
 *
 * @typedef {Object} MediaUrlEntry
 * @property {string} filename    — File name on disk
 * @property {string} originalUrl — Storypark CDN URL for this file
 */

/**
 * Centre profile — GPS coords + address per childcare centre.
 * IDB store: centreProfiles.  Disk file: Database/centre_profiles.json.
 * Also mirrored in chrome.storage.local.centreLocations (legacy key).
 *
 * INVARIANT: Always write via data-service.saveCentre() to keep both
 * stores in sync.  Always read via data-service.getCentreGPS() for the
 * authoritative GPS value.
 *
 * @typedef {Object} CentreProfile
 * @property {string}      centreName  — Centre name (primary key)
 * @property {number|null} lat         — Latitude (null if not yet geocoded)
 * @property {number|null} lng         — Longitude (null if not yet geocoded)
 * @property {string|null} address     — Street address (from Storypark API or user entry)
 */

/**
 * Child profile — birthday, regular days, centre links.
 * IDB store: childProfiles.  Disk file: Database/child_profiles.json.
 * Refreshed from API every 24 hours (see isChildProfileStale in db.js).
 *
 * @typedef {Object} ChildProfile
 * @property {string}   childId      — Storypark child ID
 * @property {string}   childName    — Display name
 * @property {string|null} birthday  — YYYY-MM-DD (used for age calculation in EXIF)
 * @property {string[]} regularDays  — e.g. ["monday","tuesday","thursday","friday"]
 * @property {string[]} companies    — Centre names from child.companies[].name
 * @property {string[]} centreIds    — Storypark centre IDs from child.centre_ids[]
 * @property {string}   [fetchedAt]  — ISO timestamp of last API fetch
 */

/* ================================================================== */
/*  Face recognition types                                             */
/* ================================================================== */

/**
 * Face descriptor record — stored face embeddings for one child.
 * IDB store: descriptors.  Disk file: Database/descriptors.json.
 *
 * @typedef {Object} DescriptorRecord
 * @property {string}       childId           — Storypark child ID
 * @property {string}       childName         — Display name
 * @property {number[][]}   descriptors        — All face embeddings (flat list)
 * @property {Object}       descriptorsByYear  — { "2025": number[][], "2026": number[][] }
 *                                               Year-bucketed for centroid computation
 */

/**
 * Image fingerprint — cached face detection result per image URL.
 * IDB store: imageFingerprints.  Disk file: Database/fingerprints.json.
 * Used as a fast path to skip re-downloading + re-detecting on deep rescans.
 *
 * @typedef {Object} ImageFingerprint
 * @property {string}   storyId   — Storypark story ID
 * @property {string}   imageUrl  — CDN URL (key for lookup)
 * @property {string}   childId   — Child this fingerprint belongs to
 * @property {boolean}  noFace    — true if no face was detected
 * @property {FaceDescriptorEntry[]} faces  — Detected face descriptors
 */

/**
 * A single detected face with its descriptor.
 *
 * @typedef {Object} FaceDescriptorEntry
 * @property {number[]} descriptor — 512-element float array (face embedding)
 */

/**
 * 4-phase child recognition state.
 * IDB store: childPhases.  Disk file: Database/phases.json.
 *
 * @typedef {Object} ChildPhase
 * @property {string}  childId        — Storypark child ID
 * @property {1|2|3|4} phase          — Current recognition phase
 * @property {number}  verifiedCount  — Number of human-verified approvals
 * @property {boolean} phase1Complete — true when verifiedCount >= 10
 * @property {boolean} phase2Complete — true when verifiedCount >= 50
 */

/* ================================================================== */
/*  Review queue types                                                 */
/* ================================================================== */

/**
 * A review queue item — photo awaiting human approve/reject decision.
 * IDB store: reviewQueue.  Disk file: Database/review_queue.json.
 *
 * @typedef {Object} ReviewQueueItem
 * @property {string}      id                 — UUID (auto-generated by db.js)
 * @property {string}      childId
 * @property {string}      childName
 * @property {StoryRef}    storyData          — Story identity for download
 * @property {string}      savePath           — Relative path for chrome.downloads
 * @property {string}      description        — Full story text (for EXIF UserComment)
 * @property {string}      [exifTitle]        — Short title (for EXIF ImageDescription)
 * @property {string}      [exifSubject]      — Short excerpt (for EXIF XPSubject)
 * @property {string}      [exifComments]     — Full text (for EXIF UserComment)
 * @property {number|null} matchPct           — Raw positive match 0–100
 * @property {number[]|null} descriptor       — Face embedding for the best-match face
 * @property {FacePreview[]} [allFaces]       — All detected faces (multi-face photos)
 * @property {boolean}     [noFace]           — true = activity photo (no face detected)
 * @property {boolean}     [noTrainingData]   — true = no descriptors yet (bootstrap)
 * @property {boolean}     [isOfflineFile]    — true = from offline scan (file already on disk)
 * @property {boolean}     [isFromRejected]   — true = from Rejected Matches folder
 * @property {string}      [originalFilePath] — For isFromRejected: path in Stories/ to restore to
 * @property {string}      [croppedFaceDataUrl] — Cropped face thumbnail (JPEG data URL)
 * @property {string}      [fullPhotoDataUrl]   — Full photo thumbnail (JPEG data URL)
 */

/**
 * Story reference inside a ReviewQueueItem or PendingDownload.
 *
 * @typedef {Object} StoryRef
 * @property {string}      storyId     — Storypark story ID
 * @property {string}      createdAt   — ISO timestamp
 * @property {string|null} originalUrl — CDN URL of the specific image
 * @property {string}      [filename]  — Filename for the specific image
 */

/**
 * A single face preview (for multi-face review cards).
 *
 * @typedef {Object} FacePreview
 * @property {number[]|null} descriptor    — Face embedding
 * @property {string|null}   croppedDataUrl — Cropped face thumbnail
 * @property {number|null}   matchPct       — Match percentage
 */

/* ================================================================== */
/*  Download types                                                     */
/* ================================================================== */

/**
 * A pending download — photo/video approved but not yet written to disk.
 * IDB store: pendingDownloads.  Disk file: Database/pending_downloads.json.
 * Used in Phase 1–3 to defer disk writes until the user clicks "Download Approved".
 *
 * @typedef {Object} PendingDownload
 * @property {number}       [id]         — Auto-increment IDB key (stripped from exports)
 * @property {"image"|"video"} [itemType] — Media type (default: "image")
 * @property {string}       childId
 * @property {string}       childName
 * @property {string}       [storyId]    — Storypark story ID
 * @property {string}       imageUrl     — CDN URL to download from
 * @property {string}       savePath     — Relative path for chrome.downloads
 * @property {string}       [filename]   — Filename portion of savePath
 * @property {string}       description  — Story text (for EXIF UserComment)
 * @property {string}       [exifTitle]
 * @property {string}       [exifSubject]
 * @property {string}       [exifComments]
 * @property {GpsCoords|null} [gpsCoords]  — GPS coordinates (from centre profile)
 * @property {string}       [createdAt]    — ISO timestamp of the story
 * @property {string}       [roomName]
 * @property {string}       [centreName]
 * @property {StoryRef}     [storyData]   — Full story reference (alternative to storyId)
 */

/**
 * GPS coordinates embedded in EXIF metadata.
 *
 * @typedef {Object} GpsCoords
 * @property {number} lat — Latitude (-90 to 90)
 * @property {number} lng — Longitude (-180 to 180)
 */

/* ================================================================== */
/*  Logging types                                                      */
/* ================================================================== */

/**
 * An activity log entry — user-facing operation history.
 * Stored in: chrome.storage.local.activityLog[], and flushed to
 * Database/activity_log.jsonl (one JSON per line, append-only).
 *
 * @typedef {Object} ActivityLogEntry
 * @property {string}   timestamp  — ISO 8601 timestamp
 * @property {"INFO"|"SUCCESS"|"WARNING"|"ERROR"} level
 * @property {string}   message    — Human-readable description
 * @property {string}   [jobName]  — Operation name: "scan", "audit", "fix-metadata", etc.
 * @property {string}   [storyDate] — DD/MM/YYYY (when log line relates to a specific story)
 * @property {LogMeta}  [meta]     — Structured metadata for pill display in Activity Log tab
 */

/**
 * Structured metadata for an ActivityLogEntry.
 * Used to render coloured pill badges in the Activity Log tab.
 *
 * @typedef {Object} LogMeta
 * @property {string}  [childName]
 * @property {string}  [centreName]
 * @property {string}  [roomName]
 * @property {number}  [photoCount]
 * @property {number}  [approved]
 * @property {number}  [queued]
 * @property {number}  [rejected]
 * @property {boolean} [gps]         — true = GPS was embedded, false = GPS missing
 */

/**
 * A diagnostic log entry — developer-facing API capture.
 * Stored in memory only (capped), flushed to Database/debug_log.json
 * when debug mode is active.
 *
 * @typedef {Object} DiagnosticEntry
 * @property {string} url        — The API endpoint URL that was called
 * @property {string} timestamp  — ISO 8601 timestamp
 * @property {*}      data       — Raw parsed JSON response body
 * @property {string} [tag]      — Classification: "room_extraction_miss",
 *                                 "match_borderline", "centre_name_empty", etc.
 */

/* ================================================================== */
/*  Scan/operation types                                               */
/* ================================================================== */

/**
 * Scan checkpoint — saved scan position for Resume support.
 * IDB store: scanCheckpoints.  chrome.storage.session: scanCheckpoint_{childId}.
 *
 * @typedef {Object} ScanCheckpoint
 * @property {string} childId
 * @property {string} childName
 * @property {"EXTRACT_LATEST"|"DEEP_RESCAN"} mode
 * @property {number} storyIndex      — 0-based index into the summaries array
 * @property {number} totalStories    — Total stories in the run
 * @property {string|null} lastStoryId — Last successfully processed story ID
 * @property {string} [abortedReason]  — "rate_limit"|"auth"|"user_cancel"
 * @property {string} [abortedAt]      — ISO timestamp
 */

/**
 * Scan result stats returned by runExtraction().
 *
 * @typedef {Object} ScanStats
 * @property {number}  approved      — Photos downloaded or cached
 * @property {number}  queued        — Photos added to review queue
 * @property {number}  rejected      — Photos below minimum threshold
 * @property {number}  skippedAbsent — Stories skipped (attendance filter)
 * @property {boolean} cancelled     — true if aborted by user or rate limit
 */

/**
 * A story summary from the paginated story feed.
 * Returned by fetchStorySummaries() in storypark-api.js.
 *
 * @typedef {Object} StorySummary
 * @property {string} id          — Storypark story ID (always string)
 * @property {string} created_at  — ISO 8601 timestamp
 * @property {string} [title]     — Story title or excerpt (from feed, may be empty)
 */

/**
 * Parsed story fields — output of storypark-api.parseStoryFields().
 * Used by scan-engine.js; avoids field-name knowledge spreading into the scan loop.
 *
 * @typedef {Object} ParsedStory
 * @property {string}      body          — Story text (always a plain string)
 * @property {string}      centreName    — Centre name (may be "")
 * @property {string}      educatorName  — Educator name (may be "")
 * @property {string}      roomName      — Room from API group_name (may be "")
 * @property {string}      storyTitle    — Plain text title
 * @property {MediaItem[]} images        — Image media items with CDN URLs
 * @property {MediaItem[]} videos        — Video media items with CDN URLs
 * @property {string}      educatorId    — Educator user ID (for saveEducator)
 */

/**
 * A single media item from a story, normalised from multiple API field names.
 *
 * @typedef {Object} MediaItem
 * @property {string} originalUrl  — CDN URL for the full-resolution file
 * @property {string} filename     — Generated filename for disk storage
 * @property {string} contentType  — MIME type (e.g. "image/jpeg", "video/mp4")
 */

/* ================================================================== */
/*  Message handler types                                              */
/* ================================================================== */

/**
 * The context object passed to all message handler functions.
 * Provides access to runtime state from background.js without globals.
 *
 * @typedef {Object} HandlerContext
 * @property {Function} sendToOffscreen    — async (message) => response
 * @property {Function} logger             — async (level, message, storyDate?, meta?) => void
 * @property {Function} getCancelRequested — () => boolean
 */

/**
 * Standard success response from a message handler.
 *
 * @typedef {Object} SuccessResponse
 * @property {true} ok
 */

/**
 * Standard error response from a message handler.
 *
 * @typedef {Object} ErrorResponse
 * @property {false} ok
 * @property {string} error — Human-readable error description
 */
