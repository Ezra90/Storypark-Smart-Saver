# Storypark API Reference — Smart Saver Extension

> **Internal reference** for `background.js` and the extension pipeline.  
> All endpoints are undocumented Storypark internals derived from captured API traffic and may change without notice.

---

## Base URL

```
https://app.storypark.com
```

---

## Authentication

All requests use the browser's active session cookies — **no API key or OAuth token is required**.

```ts
fetch(url, { credentials: "include", cache: "no-cache" })
```

`cache: "no-cache"` forces the browser to revalidate with the server on every request, preventing 304 empty-body responses that break JSON parsing.

### `apiFetch()` behaviour

1. `cache: "no-cache"` — prevents 304 empty-body responses.
2. Sequential-only usage — **never** call inside `Promise.all`; always `await`.
3. Automatic 429 retry — honours `Retry-After` header (default 30 s), retries once, then throws `RateLimitError`.
4. Cloudflare detection — a 200 OK that returns HTML instead of JSON throws a descriptive error.

### Error Handling

| HTTP Status | Meaning | Extension Behaviour |
|---|---|---|
| `401` | Session expired / not logged in | Throws `AuthError` — stops scan immediately |
| `403` | Cloudflare / server block | Throws `RateLimitError` — stops scan immediately |
| `429` | Rate limited | Retries once after `Retry-After`, then throws `RateLimitError` |
| Other `!ok` | Generic API error | Throws `Error` — skips the current story |

---

## Endpoints

### 1. Current User Profile

```
GET /api/v3/users/me
```

Returns the logged-in user's profile, including all linked children.

**Response shape (verified from captures):**

```jsonc
{
  "user": {
    "id": "1234567890123456789",        // string, not integer
    "account_state": "active",
    "email": "parent@example.com",
    "children": [
      {
        "id": "9876543210987654321",     // string
        "display_name": "Alex Smith",    // NOTE: field is display_name, NOT name
        "first_name": "Alex",
        "last_name": "Smith",
        "birthday": "2023-07-29",
        "centre_ids": ["176910"],
        "organisations": []              // often empty for family accounts
      }
    ],
    // NOTE: communities[], community_name, service_name, centre_name are
    // NOT present on all account types. For family accounts, centre info
    // comes from /api/v3/family/centres instead.
    "administered_family_children_teacher_stories": 123
  }
}
```

**Extension usage:** `loadAndCacheProfile()` — cached in `chrome.storage.local` as `{ children: [{id, name}] }`.

**Important:** Children use `display_name` (not `name`). The extension maps: `c.name || c.display_name`.

---

### 2. Child Profile

```
GET /api/v3/children/{child_id}
```

Returns detailed profile data for a single child.

**Response shape (verified from captures):**

```jsonc
{
  "child": {
    "id": "9876543210987654321",
    "first_name": "Alex",
    "last_name": "Smith",
    "display_name": "Alex Smith",
    "birthday": "2023-07-29",           // used for age calculation in EXIF
    "centre_ids": ["176910"],
    "storypark_id": "6296375",          // numeric ID used in web URLs
    "regular_days": ["monday", "tuesday", "thursday", "friday"],
    // NOTE: companies[] and services[] are NOT present on all accounts.
    // For family accounts, use centre_ids + /api/v3/family/centres instead.
    "permissions": { ... },
    "profile_medium": { ... }
  }
}
```

**Centre name discovery:** When `companies[]` is empty, the extension matches `child.centre_ids` against `/api/v3/family/centres` response to find the centre name.

**Age calculation:** `child.birthday` + `story.created_at` → "Alex @ 2 years 3 months"

---

### 3. Centres (Dedicated Endpoint)

```
GET /api/v3/centres
```

Returns centres directly associated with the user. **Often returns empty for family accounts.**

```jsonc
{
  "centres": [],                         // empty for family accounts
  "meta": { "status": "success" }
}
```

### 4. Family Centres

```
GET /api/v3/family/centres
```

> **Note:** The URL uses a forward slash (`family/centres`), not an underscore.
> The extension tries both `/api/v3/family/centres` and `/api/v3/family_centres`.

Returns the centres linked to the family account. **This is the primary source of centre names for family accounts.**

**Response shape (verified from captures):**

```jsonc
{
  "centres": [
    {
      "id": "176910",                    // string
      "name": "My Early Learning Centre",
      "country": "Australia",
      "tzdb_time_zone": "Australia/Brisbane",
      "educators_count": 54,
      "family_admins_count": 245,
      "plan_active": true,
      "permissions": { ... },
      "profile_medium": { ... }
    }
  ]
}
```

---

### 5. Story Feed (Paginated)

```
GET /api/v3/children/{child_id}/stories
    ?sort_by=updated_at
    &story_type=all
    [&next_page_token={token}]
```

Returns a paginated list of story summaries for a child. Each page contains full story data (not just IDs).

**Response shape (verified from captures):**

```jsonc
{
  "stories": [
    {
      "id": "108400285",                 // string
      "created_at": "2026-04-17T02:06:24.594Z",
      "date": "2026-04-17",
      "excerpt": "Hello families...",
      "group_id": "176910",
      "group_name": "My Early Learning Centre",  // NOTE: this is the CENTRE name, not room
      "display_subtitle": "Group Story for Child1, Child2...",
      "media": [                          // NOTE: field is "media", NOT "media_items"
        {
          "id": "0a606aca-e683-4ebf-95a1-042b92e716a0",
          "type": "image",
          "content_type": "image/jpeg",
          "original_url": "https://app.storypark.com/media_items/.../original/...",
          "token": "9ce7f7",
          "original_width": 1536,
          "original_height": 2048
        }
      ]
    }
  ],
  "next_page_token": "107780958"          // null or absent on the last page
}
```

**Extension usage:** `fetchStorySummaries(childId, mode)` — paginates until `next_page_token` is absent or a known story ID is encountered.

---

### 6. Story Detail

```
GET /api/v3/stories/{story_id}
```

Returns the full story object. The Storypark web app calls this with `?comments_count=10&show_approval_permissions=true`, but the extension calls it without those params.

**Response shape (verified from captures):**

```jsonc
{
  "story": {
    "id": "107780958",
    "created_at": "2026-03-31T01:01:25.914Z",
    "date": "2026-03-31",
    "display_content": "Full story text here...",  // NOTE: NOT "body" — use display_content
    "excerpt": "Shortened version...",
    "group_id": "176910",
    "group_name": "My Early Learning Centre",      // centre name (NOT room name)
    // NOTE: community_name, centre_name, service_name are NOT present in captures.
    // Centre name comes from group_name or the /api/v3/family/centres endpoint.
    "children": [
      {
        "id": "1234567890987654321",
        "display_name": "Alex",
        "first_name": "Alex",
        "last_name": "Smith"
      }
    ],
    "learning_tags": [ ... ],
    "media": [                            // NOTE: field is "media", NOT "media_items"
      {
        "id": "2b6b5264-5746-4b37-a8ad-cab0c1621ea3",
        "type": "image",
        "content_type": "image/jpeg",
        "original_url": "https://app.storypark.com/media_items/.../original/...",
        "resized_url": "https://app.storypark.com/media_items/.../640_wide/...",
        "token": "50eada",
        "file_name": "story_image_v2_..._original",
        "original_width": 1536,
        "original_height": 2048
      }
    ]
  }
}
```

**Key differences from API_REF v1:**
- Story text is in `display_content`, **not** `body`
- Media items are in `media[]`, **not** `media_items[]`
- `group_name` is the **centre name**, not a room name
- `community_name` / `centre_name` / `service_name` may not be present on stories

**Extension fallback chain for body text:** `display_content` → `body` → `excerpt` → `content`

**Extension fallback chain for centre name:** `community_name` → `centre_name` → `service_name` → `group_name` → `childCentreFallback` (from profile)

**Room name deduplication:** If `group_name` equals the resolved centre name, it's treated as the centre (not duplicated as a room).

---

### 7. Daily Routines (v3 API — Paginated)

```
GET /api/v3/children/{child_id}/daily_routines?page_token=null
```

Returns paginated daily routine records. Each record contains a date and an array of events.

**Response shape (verified from captures):**

```jsonc
{
  "daily_routines": [
    {
      "id": "3876841049154389661",
      "child": { ... },
      "date": "2026-04-17",
      "events": [
        {
          "id": "3877071787321722055",
          "title": "Drink",                    // most human-readable field
          "routine_type": "feed",
          "event_type": "bottle",
          "description": "Educator Name",      // who logged it, NOT what happened
          "full_description": "Educator Name",
          "notes": "",
          "occurred_at": "2026-04-17T05:16:32.577Z",
          "bottle": { "measurement": "mls", "quantity": null }
        },
        {
          "title": "Nappy • Wet",
          "routine_type": "toilet",
          "event_type": "nappy",
          "nappy": { "status": "wet" }
        },
        {
          "title": "Sleep",
          "routine_type": "sleep",
          "event_type": "sleep"
        }
      ]
    }
  ],
  "next_page_token": "38645217078385069"   // null on last page
}
```

**Available routine event types** (from `/api/v3/children/{id}/daily_routine_events/types`):
`feed`, `incident`, `other`, `sleep`, `sunscreen`, `toilet`

**Extension usage:** `_fetchRoutineV3(childId, dateStr)` — paginates to find the matching date, extracts `event.title` from each event.

**Legacy fallback:** The extension also tries `/children/{id}/routines.json?date=YYYY-MM-DD` if the v3 endpoint fails.

---

### 8. Media Download

Media items in story responses include `original_url` for full-resolution downloads. The URL pattern:

```
https://app.storypark.com/media_items/{token}/{id}/original/{account_id}/{expiry}/{signature}
```

Resized versions use `640_wide` or `large` instead of `original` in the path.

The extension downloads using `original_url` directly — no URL construction needed.

---

## EXIF Metadata Template

The extension embeds the following in JPEG `ImageDescription` (tag `0x010E`):

```
{childFirstName} @ {age at story date}
{story display_content, HTML stripped, emojis removed}
------------------------------
{childFirstName}'s Routine: {comma-separated routine events}   ← omitted if no data
------------------------------
{Room Name}                                                     ← omitted if same as centre
{Centre Name}
Storypark
```

**Example:**

```
Alex @ 2 years 8 months
Had a wonderful day at kindy. We made paper boats and floated them in the water tray.
------------------------------
Alex's Routine: Drink, Nappy - Wet, Sleep
------------------------------
My Early Learning Centre
Storypark
```

**Emoji handling:** All emojis are stripped from EXIF text to prevent corruption (EXIF uses ASCII/Latin-1 encoding).

`DateTimeOriginal` and `DateTime` are set from `story.created_at`.

---

## Photo & Video Filename Convention

All photos and videos use date-prefixed filenames for chronological sorting in file managers and Google Photos timeline compatibility:

```
YYYY-MM-DD_ChildName[_RoomName]_originalname.ext
```

**Photo example:** `2026-04-17_Alex_Smith_Kangaroo_Room_story_image_v2_abc123_original.jpg`
**Video example:** `2026-04-17_Alex_Smith_Kangaroo_Room_49e4a13c.mp4`

- JPEG photos also have EXIF date metadata embedded (Google Photos prefers EXIF over filename).
- Non-JPEG images (PNG, WebP, GIF) and MP4 videos rely on the filename date signal.
- Room name is included when it differs from the centre name; omitted when they're the same.

---

## Download Pipeline Architecture

Manifest V3 offscreen documents do NOT have access to `chrome.downloads`. The extension uses a two-stage pipeline:

1. **Offscreen document** (`offscreen.js`) — fetches the media via `fetch()`, processes it (face detection, EXIF stamping), and converts the result to a base64 **data URL** via `FileReader.readAsDataURL()`.
2. **Service worker** (`background.js`) — receives the data URL via `sendResponse()` and calls `chrome.downloads.download({ url: dataUrl, filename: savePath })` to trigger the actual file save.

This applies to all download types: `PROCESS_IMAGE`, `DOWNLOAD_APPROVED`, `DOWNLOAD_VIDEO`, and `DOWNLOAD_TEXT`.

---

## Storage Keys (`chrome.storage.local`)

| Key | Type | Description |
|---|---|---|
| `children` | `Array<{id, name}>` | Cached children list from profile |
| `activityLog` | `Array<{timestamp, level, message, storyDate?}>` | Rolling 200-entry log |
| `centreLocations` | `Record<string, {lat, lng, address}>` | GPS coords keyed by centre name |
| `activeCentreName` | `string` | First discovered centre name (fallback) |
| `autoThreshold` | `number` (default 85) | Face match % for auto-approve |
| `minThreshold` | `number` (default 50) | Face match % below which photos are discarded |
| `totalStoryCount` | `number` | Total stories from user profile |

---

## Anti-Bot Pacing

| Action | Delay Range | Notes |
|---|---|---|
| `FEED_SCROLL` | 800 – 1,500 ms | Between story feed pages |
| `READ_STORY` | 2,500 – 6,000 ms | Before fetching full story detail |
| `DOWNLOAD_MEDIA` | 1,000 – 2,000 ms | Before each image/video download |
| Coffee Break | 12,000 – 25,000 ms | Every 15–25 requests |

---

## Face Recognition

- **Year-bucketed descriptors:** Face descriptors are stored per calendar year per child (max 100/year, 1000 total).
- **Rolling improvement:** As photos are approved during review, descriptors are added to the matching year's bucket.
- **Legacy migration:** Existing flat descriptor arrays are automatically migrated to year-bucket format.
