# DATA_MODEL.md — Storypark Smart Saver Data Files

This document describes the main `Database/` files used by the extension, why each exists, and how migrations are handled.

---

## Storage Design Principles

- Keep **index-style** records separate from **heavy payload** records.
- Prefer deterministic keys (`childId_storyId`, `childId_storyDate`) for idempotent upserts.
- Persist long-running sync progress so crashes/restarts can resume safely.
- Keep user-facing logs in both JSON and human-readable text.

---

## Database Folder Files

The linked folder stores data in:

`Storypark Smart Saver/Database/`

### Core tracking files

- `manifests.json`
  - Local file tracking per story (downloaded/approved/rejected filenames, story metadata used for rebuild and repair).
- `rejections.json`
  - Rejected media ledger (`storyId_originalUrl` keys).
- `fileMovements` (IDB store)
  - File movement history (downloaded/renamed/restored) used for tracking and repair visibility.

### Storypark API sync files

- `story_catalog.json`
  - Lightweight per-story index (counts, status flags, references, centre/class/educator summary).
  - Used for quick comparisons and status metrics.
- `story_details.json`
  - Heavier per-story payloads (body text, richer metadata).
- `routine_snapshots.json`
  - Routine snapshots keyed by `childId_storyDate` (summary + detailed).
- `sync_state.json`
  - Current/last sync state, checkpoint, and run stats.
- `sync_journal.json`
  - Recent sync events (bounded list) for troubleshooting and health reporting.
- `sync_schema.json`
  - Data schema descriptor/version metadata.
- `decision_log.jsonl`
  - Append-only model decision audit stream (manual, auto, self-improve).
- `model_health.json`
  - Per-child model quality/health snapshots.
- `holdout_sets.json`
  - Per-child holdout keys used for validation metrics.
- `jobs_state.json`
  - Idempotency/job lock ledger for long-running maintenance jobs.

### Activity logs

- `activity_log.json`
  - Structured activity log entries.
- `activity_log.txt`
  - Human-readable log lines for quick inspection.

---

## Key Shapes (Simplified)

### `story_catalog.json`

```json
{
  "childId_storyId": {
    "key": "childId_storyId",
    "childId": "123",
    "childName": "Example Child",
    "storyId": "456",
    "storyDate": "2026-04-25",
    "title": "Story title",
    "excerpt": "Brief text",
    "centreName": "Example Centre",
    "className": "Nursery One",
    "educatorName": "Teacher Name",
    "imageCount": 4,
    "videoCount": 1,
    "otherCount": 0,
    "mediaTypes": ["image/jpeg", "video/mp4"],
    "fileCount": 5,
    "downloadedCount": 4,
    "requiresRedownload": true,
    "detailKey": "childId_storyId",
    "routineKey": "childId_2026-04-25",
    "lastSyncedAt": "2026-04-25T12:00:00.000Z"
  }
}
```

### `story_details.json`

```json
{
  "childId_storyId": {
    "key": "childId_storyId",
    "childId": "123",
    "storyId": "456",
    "storyBody": "Longer content...",
    "updatedAt": "2026-04-25T11:59:00.000Z",
    "lastSyncedAt": "2026-04-25T12:00:00.000Z"
  }
}
```

### `routine_snapshots.json`

```json
{
  "childId_2026-04-25": {
    "key": "childId_2026-04-25",
    "childId": "123",
    "storyDate": "2026-04-25",
    "routineSummary": "Drink, Sleep",
    "routineDetailed": "8:30 AM - Drink\n12:00 PM - Sleep",
    "lastSyncedAt": "2026-04-25T12:00:00.000Z"
  }
}
```

### `sync_state.json`

```json
{
  "type": "storypark_api_sync",
  "inProgress": false,
  "startedAt": "2026-04-25T11:50:00.000Z",
  "lastSuccessAt": "2026-04-25T12:10:00.000Z",
  "mode": "full",
  "childrenTotal": 2,
  "checkpoint": {
    "childIndex": 1,
    "childId": "123",
    "childName": "Example Child",
    "pageToken": "107780958",
    "childPage": 3
  },
  "lastRunStats": {
    "children": 2,
    "stories": 520,
    "catalogUpdates": 520,
    "cancelled": false
  },
  "updatedAt": "2026-04-25T12:10:00.000Z"
}
```

---

## Migration Notes

## v1 (current)

- Introduced split sync storage:
  - `story_catalog.json`
  - `story_details.json`
  - `routine_snapshots.json`
- Added sync durability files:
  - `sync_state.json`
  - `sync_journal.json`
  - `sync_schema.json`
- Added dual activity log output:
  - `activity_log.json`
  - `activity_log.txt`

## v2

- Added face-audit and quality files:
  - `decision_log.jsonl`
  - `model_health.json`
  - `holdout_sets.json`
- Added idempotency ledger:
  - `jobs_state.json`
- Expanded `sync_schema.json` to include per-file version metadata and migration entries.

### Compatibility behavior

- Existing manifests remain compatible and are lazily migrated where needed.
- If a file is missing, loaders default to safe empty objects/arrays.
- Upserts are idempotent by key, so re-running sync after interruption is safe.

### Future migration guideline

When changing file schemas:

1. Bump `sync_schema.json` `version`.
2. Add a migration function in `lib/db.js`.
3. Keep backward-compatible reads during rollout.
4. Log migration summary to activity log and sync journal.

