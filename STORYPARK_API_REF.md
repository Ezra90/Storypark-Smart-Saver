# Storypark API Reference — Smart Saver Extension

> **Internal reference** for `background.js` and the extension pipeline.  
> All endpoints are undocumented Storypark internals and may change without notice.

---

## Base URL

```
https://app.storypark.com
```

---

## Authentication

All requests are made with the browser's active session cookies — **no API key or OAuth token is required**.

```ts
fetch(url, { credentials: "include" })
```

### Required Headers

| Header | Value | Notes |
|---|---|---|
| `Cookie` | _(browser session)_ | Injected automatically by `credentials: "include"` |
| `X-CSRF-Token` | _(session token)_ | Required for state-changing requests |
| `X-Spa-Session-Id` | _(session ID)_ | Identifies the SPA session |
| `Accept` | `application/json` | Ensures JSON responses |

### Error Handling

| HTTP Status | Meaning | Extension Behaviour |
|---|---|---|
| `401` | Session expired / not logged in | Throws `AuthError` — stops scan immediately |
| `403` | Cloudflare / server block | Throws `RateLimitError` — stops scan immediately |
| `429` | Rate limited | Throws `RateLimitError` — stops scan immediately |
| Other `!ok` | Generic API error | Throws `Error` — skips the current story |

---

## Endpoints

### 1. Current User Profile

```
GET /api/v3/users/me
```

Returns the logged-in user's profile, including all linked children and community/daycare information.

**Response shape (relevant fields):**

```jsonc
{
  "user": {
    "id": 12345,
    "email": "parent@example.com",
    "administered_family_children_teacher_stories": 516,   // total story count
    "communities": [                                        // daycare centres
      {
        "id": 99,
        "name": "Bahrs Scrub Early Learning",              // daycare name
        "display_name": "Bahrs Scrub Early Learning"
      }
    ],
    // Alternative top-level keys also checked:
    "community_name": "Bahrs Scrub Early Learning",
    "service_name":   "...",
    "centre_name":    "...",
    "children": [
      {
        "id": 3814824849872783328,
        "name": "Olivia Smith",
        "display_name": "Olivia Smith"
      }
    ]
  }
}
```

**Extension usage:** `loadAndCacheProfile()` — cached in `chrome.storage.local` as `{ children: [{id, name}] }`.

**Total story count field:** `administered_family_children_teacher_stories` (integer, e.g. `516`).

**Daycare / centre name resolution order:**
1. `user.communities[].name`
2. `user.community_name`
3. `user.service_name`
4. `user.centre_name`

---

### 2. Child Profile

```
GET /api/v3/children/{child_id}
```

Returns detailed profile data for a single child.

**Response shape (relevant fields):**

```jsonc
{
  "child": {
    "id": 3814824849872783328,
    "first_name": "Olivia",
    "last_name":  "Smith",
    "groups": [                    // room names within the daycare
      {
        "id": 77,
        "name": "Butterflies Room"
      }
    ],
    "companies": [                 // daycare / organisation
      {
        "id": 99,
        "name": "Bahrs Scrub Early Learning"
      }
    ]
  }
}
```

**Room name:** `child.groups[].name`  
**Daycare name:** `child.companies[].name`

---

### 3. Story Feed (Paginated)

```
GET /api/v3/children/{child_id}/stories
    ?sort_by=updated_at
    &story_type=all
    [&next_page_token={token}]
```

Returns a paginated list of story summaries for a child.

**Query parameters:**

| Parameter | Value | Notes |
|---|---|---|
| `sort_by` | `updated_at` | Sort order |
| `story_type` | `all` | Include all story types |
| `next_page_token` | _(from previous response)_ | Omit for the first page |

**Response shape:**

```jsonc
{
  "stories": [
    {
      "id": "9876543210",
      "created_at": "2024-03-15T08:30:00.000Z"  // ISO 8601
    }
  ],
  "next_page_token": "eyJh..."   // null or absent on the last page
}
```

**Extension usage:** `fetchStorySummaries(childId, mode)` — paginates until `next_page_token` is absent or a known story ID is encountered (EXTRACT_LATEST mode).

---

### 4. Story Detail

```
GET /api/v3/stories/{story_id}
```

Returns the full story object including body text, media items, and metadata.

**Response shape:**

```jsonc
{
  "story": {
    "id": "9876543210",
    "created_at": "2024-03-15T08:30:00.000Z",   // ISO 8601 — used for EXIF DateTimeOriginal
    "body":       "<p>Had a great day at kindy…</p>",  // story text (may contain HTML)
    "group_name":     "Butterflies Room",              // room name
    "community_name": "Bahrs Scrub Early Learning",    // centre name (preferred)
    "centre_name":    "...",                            // fallback
    "service_name":   "...",                            // fallback
    "media_items": [
      {
        "id":           "media-abc123",
        "token":        "rrWEbXgHajurHQUj8PVuSXmNvh",
        "original_url": "https://assets.storypark.com/…/original/photo.jpg",
        "filename":     "photo.jpg"
      }
    ],
    // Alternative media container keys also checked:
    "assets": [...],
    "media":  [...]
  }
}
```

**Body / blurb field:** `story.body` (may contain HTML — strip with `stripHtml()`).  
**Centre name resolution order:** `community_name` → `centre_name` → `service_name` → `activeCentreName` (stored setting).

---

### 5. Media Download URL

Media items expose a direct CDN URL via `original_url`. The URL format follows this pattern:

```
/media_items/{token}/{id}/original/{filename}
```

Example using token and id from the media item:

```
https://assets.storypark.com/media_items/rrWEbXgHajurHQUj8PVuSXmNvh/media-abc123/original/photo.jpg
```

In practice, the extension uses `media_items[].original_url` directly — no URL construction needed.

---

### 6. Daily Routines

```
GET /children/{child_id}/routines.json?date={YYYY-MM-DD}
```

> **Note:** This endpoint does **not** use the `/api/v3/` prefix.

Returns the day's routine events (sleep, meals, bottles, nappy changes, etc.) for a child.

**Query parameters:**

| Parameter | Format | Example |
|---|---|---|
| `date` | `YYYY-MM-DD` | `2024-03-15` |

**Known child IDs with routine data:** `3814824849872783328`, `3206581817603786511`

**Response shape:**

```jsonc
{
  "sleeps": [
    { "description": "Slept 12:00 PM – 1:30 PM", "type": "sleep" }
  ],
  "meals": [
    { "description": "Ate lunch — pasta", "summary": "Good appetite" }
  ],
  "bottles": [
    { "description": "200ml formula at 10:00 AM" }
  ],
  "nappy_changes": [
    { "type": "wet" }
  ]
  // Any number of top-level array keys may be present
}
```

**Extension usage:** `fetchRoutineSummary(childId, dateStr)` — iterates **all** top-level array keys, extracts `description || summary || type || name` from each item, and joins with `, `.

**EXIF format:** `Routine: Slept 12:00 PM – 1:30 PM, Ate lunch — pasta, ...`

---

### 7. Web Activity Feed (Alternative)

```
GET /api/v3/web_activity
```

An alternative feed that returns combined activity across all linked children. Contains the same `media` array structure as the stories endpoint.

**Response shape:**

```jsonc
{
  "activity": [
    {
      "id": "9876543210",
      "created_at": "2024-03-15T08:30:00.000Z",
      "content": "Had a great day…",   // story text (alternative to body)
      "body":    "<p>…</p>",
      "media": [
        {
          "id":    "media-abc123",
          "token": "rrWEbXgHajurHQUj8PVuSXmNvh"
        }
      ]
    }
  ]
}
```

---

## TypeScript Interfaces

```ts
// User profile (from GET /api/v3/users/me)
interface StoryparkUser {
  id: number;
  email: string;
  administered_family_children_teacher_stories: number; // total story count
  communities?: StoryparkCommunity[];
  community_name?: string;
  service_name?: string;
  centre_name?: string;
  children: StoryparkChildSummary[];
}

interface StoryparkCommunity {
  id: number;
  name: string;
  display_name?: string;
}

interface StoryparkChildSummary {
  id: number | string;
  name: string;
  display_name?: string;
}

// Detailed child profile (from GET /api/v3/children/{id})
interface StoryparkChild {
  id: number | string;
  first_name: string;
  last_name: string;
  groups: Array<{ id: number; name: string }>;    // room names
  companies: Array<{ id: number; name: string }>; // daycare centres
}

// Full story object (from GET /api/v3/stories/{id})
interface StoryparkStory {
  id: string | number;
  created_at: string;          // ISO 8601
  body?: string;               // story text (may contain HTML)
  content?: string;            // alternative text field (web_activity)
  group_name?: string;         // room name
  community_name?: string;     // centre name (preferred)
  centre_name?: string;        // centre name (fallback)
  service_name?: string;       // centre name (fallback)
  media_items?: StoryparkMedia[];
  assets?: StoryparkMedia[];
  media?: StoryparkMedia[];
}

// Media item (inside story.media_items)
interface StoryparkMedia {
  id: string;
  token: string;               // e.g. "rrWEbXgHajurHQUj8PVuSXmNvh"
  original_url: string;        // direct CDN URL for the original image
  filename?: string;
}

// Daily routine response (from GET /children/{id}/routines.json)
// Top-level keys vary; each value is an array of routine events.
interface StoryparkRoutineResponse {
  sleeps?: StoryparkRoutineEvent[];
  meals?: StoryparkRoutineEvent[];
  bottles?: StoryparkRoutineEvent[];
  nappy_changes?: StoryparkRoutineEvent[];
  [key: string]: StoryparkRoutineEvent[] | undefined;
}

interface StoryparkRoutineEvent {
  description?: string;
  summary?: string;
  type?: string;
  name?: string;
}

// Story summary (from paginated feed)
interface StoryparkStorySummary {
  id: string;
  created_at: string; // ISO 8601
}

// Paginated stories response
interface StoryparkStoriesPage {
  stories: StoryparkStorySummary[];
  items?: StoryparkStorySummary[]; // alternative key
  next_page_token?: string | null;
}
```

---

## EXIF Metadata Template

The extension embeds the following structured string in the JPEG `ImageDescription` (tag `0x010E`) field:

```
{story body, HTML stripped}
------------------------------
Routine: {comma-separated routine events}   ← omitted if no routine data
------------------------------
{Room Name}
{Centre Name}
Storypark
```

**Example:**

```
Had a wonderful day at kindy. We made paper boats and floated them in the water tray.
------------------------------
Routine: Slept 12:00 PM – 1:30 PM, Ate lunch well
------------------------------
Butterflies Room
Bahrs Scrub Early Learning
Storypark
```

`DateTimeOriginal` (tag `0x0132`) is set from `story.created_at` (falls back to `12:00:00` for date-only values).

---

## Storage Keys (`chrome.storage.local`)

| Key | Type | Description |
|---|---|---|
| `children` | `Array<{id, name}>` | Cached children list from profile |
| `activityLog` | `Array<{timestamp, level, message}>` | Rolling 200-entry activity log |
| `centreLocations` | `Record<string, {lat, lng}>` | GPS coords keyed by centre name |
| `activeCentreName` | `string` | First discovered centre name (fallback) |
| `autoThreshold` | `number` (default 85) | Face match % for auto-approve |
| `minThreshold` | `number` (default 50) | Face match % below which photos are discarded |
| `reviewQueue` | `StoryparkReviewItem[]` | HITL pending review queue |

---

## Anti-Bot Pacing

All API calls go through `smartDelay(actionType)` before firing:

| Action | Delay Range | Notes |
|---|---|---|
| `FEED_SCROLL` | 800 – 1 500 ms | Between story feed pages |
| `READ_STORY` | 2 500 – 6 000 ms | Before fetching full story detail |
| `DOWNLOAD_IMAGE` | 1 000 – 2 000 ms | Before each image download |
| Coffee Break | 12 000 – 25 000 ms | Auto-fires every 15–25 requests |

---

## Identified Centre & Child Data

The following values were observed in network logs and are noted here for reference:

| Field | Value |
|---|---|
| Daycare centre | Bahrs Scrub Early Learning |
| Total stories | 516 (`administered_family_children_teacher_stories`) |
| Child ID (example 1) | `3814824849872783328` |
| Child ID (example 2) | `3206581817603786511` |
| Media token (example) | `rrWEbXgHajurHQUj8PVuSXmNvh` |
