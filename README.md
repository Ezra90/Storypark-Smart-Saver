# Storypark Smart Saver – Chrome Extension

A **Manifest V3 Chrome Extension** that uses a **Headless API approach** — it calls Storypark's internal v3 JSON APIs directly rather than parsing the DOM — to automatically download your children's daycare photos to your local device.

No server, no Python, no command-line. Install the extension, log in to Storypark, and click **Extract Latest**.

---

## First-time setup after `git clone`

> ⚠️ **New contributors — read this first!**

After cloning the repo you must install dependencies and download the optional AI models and the `@vladmandic/human` library before loading the extension:

```bash
npm install && npm run setup
```

This script:
- Downloads `human.js` into `extension/lib/`
- Downloads the `blazeface` and `faceres` model weights into `extension/models/`

**Important notes:**
- The `extension/models/` folder is intentionally not committed to git (the weights are large binary files).
- If you see a **"human.js not found"** warning in the browser console, you must run `npm run setup`.
- Without `human.js` and the model files, the extension still works — all photos are downloaded automatically without face filtering.

---

## Key Features

| Feature | Details |
|---|---|
| **Headless API** | Calls `https://app.storypark.com/api/v3/*` endpoints with your browser session cookies — no DOM parsing, no content script |
| **EXIF Metadata Injection** | Stamps `DateTimeOriginal` and `ImageDescription` (story body + room + daily routine) into every downloaded JPEG via `lib/exif.js` |
| **Continuous Facial Recognition Learning** | Powered by `@vladmandic/human` (`human.js`) running in an offscreen document. Descriptors are stored in IndexedDB and improve automatically as you approve photos in the Review Queue |
| **Anti-Bot Human Pacing** | `smartDelay(actionType)` replaces naive sleeps — uses action-specific timing profiles and inserts random 12–25 s "Coffee Break" pauses every 15–25 requests |
| **Cloudflare Circuit Breaker** | Throws `AuthError` (401) and `RateLimitError` (403 / 429); immediately stops the extraction loop on either error to protect your account |
| **Persistent Activity Log** | Every log event is stored as a structured entry `{timestamp, level, message}` in `chrome.storage.local` (rolling 200-entry window) and streamed in real-time to the popup's Activity Log tab |

---

## Architecture

### Headless API Approach

Instead of injecting a content script and parsing the rendered HTML, the extension calls Storypark's undocumented internal REST APIs:

```
GET /api/v3/profile                          → children list
GET /api/v3/children/:id/stories             → paginated story feed
GET /api/v3/stories/:id                      → full story with media_items[]
GET /api/v3/children/:id/routines?date=…     → daily routine summary
```

All requests are made with `credentials: "include"` so the browser automatically attaches your logged-in session cookies. **You must be logged in to Storypark in the same Chrome profile.**

### Manifest V3 Compliance

- **Service Worker** (`background.js`, `type: module`) — orchestrates API calls, pacing, circuit-breaking, and logging.
- **Offscreen Document** (`offscreen.html` / `offscreen.js`) — runs `@vladmandic/human` (`human.js`) and EXIF processing, which need DOM/Canvas APIs unavailable in service workers.
- **No persistent background page**, no `XMLHttpRequest`, no remote code evaluation.

### Human Pacing Algorithm

```
FEED_SCROLL     →  800 – 1 500 ms
READ_STORY      → 2 500 – 6 000 ms
DOWNLOAD_IMAGE  → 1 000 – 2 000 ms
Coffee Break    → every 15–25 requests → 12 000 – 25 000 ms
```

A global request counter is incremented on every `smartDelay()` call. When the counter hits a random threshold between 15 and 25, an extended "Coffee Break" pause fires and is logged to the Activity Log.

### Cloudflare Circuit Breaker

`apiFetch()` inspects the HTTP status code before parsing JSON:

| Status | Behaviour |
|---|---|
| `401` | Throws `AuthError` — session expired or not logged in |
| `403` or `429` | Throws `RateLimitError` — Cloudflare / server rate limit |
| Other `!ok` | Throws a generic `Error` |

In the main extraction loops, catching `AuthError` or `RateLimitError` immediately `break`s the loop and logs an `ERROR` entry — no further requests are made.

### Persistent Activity Log

`logger(level, message)` in `background.js`:
1. Creates a `{timestamp, level, message}` entry.
2. Appends it to `activityLog` in `chrome.storage.local`, trimming to the last 200 entries.
3. Broadcasts a `LOG_ENTRY` message to the popup for real-time display.

Levels: `INFO`, `SUCCESS`, `WARNING`, `ERROR` — each rendered in a distinct colour in the terminal-style Activity Log tab.

---

## Quick Start

### Prerequisites

| Requirement | Details |
|---|---|
| **Google Chrome** | Version 116 or later (Manifest V3 support) |
| **Storypark account** | A parent account on [app.storypark.com](https://app.storypark.com) — you must be logged in |

### Install (Developer Mode)

1. Download or clone this repository.
2. Run `npm install && npm run setup` to download the required AI models and libraries into `extension/lib/` and `extension/models/`.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the `extension/` folder.
6. The 📸 Storypark Smart Saver icon will appear in your toolbar.

### Face Recognition Setup (Optional)

Face recognition requires additional files that are not bundled in this repository:

1. Place `human.js` (from `@vladmandic/human`) at `extension/lib/human.js`.
2. Place the `blazeface` and `faceres` model files (`.bin` and `.json`) in `extension/models/` — see `extension/models/README.md` for the full list.
3. Open **⚙ Settings** → **Face Training Data** and upload 5–10 clear reference photos for each child.

Without these files, all photos pass through without face filtering (every image is downloaded automatically).

### Usage

1. Open [app.storypark.com](https://app.storypark.com) in a Chrome tab and log in.
2. Click the extension icon.
3. Select a child from the dropdown (click **↻** to refresh if needed).
4. Click **⬇ Extract Latest** for an incremental fetch, or **🔁 Deep Rescan** to reprocess everything.
5. Monitor progress in the **Activity Log** tab.

---

## Project Structure

```
extension/
├── manifest.json          # Chrome Extension manifest (V3)
├── background.js          # Service worker — API calls, pacing, circuit breaker, logger
├── offscreen.html         # Offscreen document host (@vladmandic/human needs Canvas/DOM)
├── offscreen.js           # Face recognition + EXIF worker (offscreen document)
├── popup.html / popup.js  # Popup UI — Extract, Pending Matches, Activity Log tabs
├── options.html / options.js  # Settings — children, thresholds, face training
├── lib/
│   ├── db.js              # IndexedDB helper — processed-story ledger + face descriptors
│   ├── exif.js            # Pure-JS EXIF writer (DateTimeOriginal + ImageDescription)
│   └── face.js            # Face detection helpers (options page live preview)
├── models/                # @vladmandic/human model weights — blazeface + faceres (.bin + .json, user-supplied — see models/README.md)
└── icons/                 # Extension icons (16 px, 48 px, 128 px)
```

### Module Responsibilities

| Module | Role |
|---|---|
| `background.js` | Service worker: profile fetch, story pagination, `smartDelay`, circuit breaker, `logger`, offscreen coordination, review queue management |
| `offscreen.js` | Offscreen worker: image download, @vladmandic/human recognition, EXIF injection via `lib/exif.js`, `chrome.downloads` save |
| `popup.js` | Popup UI: extraction controls, real-time status, Pending Matches HITL, Activity Log terminal |
| `options.js` | Settings page: children management, confidence thresholds, face descriptor training |
| `lib/db.js` | IndexedDB: processed-story ledger (unlimited capacity) + face descriptor store |
| `lib/exif.js` | Writes `DateTimeOriginal` (0x0132) and `ImageDescription` (0x010E) tags into JPEG blobs; no GPS |

---

## Privacy & Security

- **No external servers.** All processing happens inside Chrome.
- **No passwords stored.** Authentication uses your existing Storypark browser session.
- **Face recognition** runs 100 % client-side via TensorFlow.js — no images leave your device.
- **Face descriptors** are stored in IndexedDB (not transmitted anywhere).
- **Downloaded photos** are saved via `chrome.downloads` to your local filesystem.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Authentication required" in Activity Log | Log in to [app.storypark.com](https://app.storypark.com) in the same Chrome profile |
| "Rate limited by Storypark" in Activity Log | Wait a few minutes; the circuit breaker stopped the scan to protect your account |
| No children in dropdown | Click **↻** while logged in to Storypark; check the Activity Log for errors |
| No photos downloaded | Check the Activity Log for errors; confirm your child has photo posts on Storypark |
| All photos going to Review Queue | Lower thresholds in Settings or add more face training photos |
| Face recognition not working | Ensure `lib/human.js` is present and the `blazeface` + `faceres` model files (`.bin` + `.json`) are in `extension/models/` |
| Want to reprocess everything | Use **🔁 Deep Rescan** — or clear `processedStories` in Chrome DevTools → IndexedDB → `storyparkSyncDB` |

---

## Acknowledgements & Open Source Credits

This extension would not be possible without the incredible work of the open-source community. A massive thank you to the creators of the following libraries:

- **[Human (@vladmandic/human)](https://github.com/vladmandic/human)** — Created by Vlad Mandic. This powers the entirely local, privacy-first facial recognition engine. It allows this extension to learn and identify faces completely offline without ever sending photos to a 3rd party server.

- **[Piexifjs (hMatoba/piexifjs)](https://github.com/hMatoba/piexifjs)** — Created by hMatoba. This robust EXIF library allows the extension to perfectly inject the Storypark dates, routines, and text blurbs directly into the downloaded JPEG metadata so that Google Photos can automatically index them.

A huge thank you to **[AustralianSimon](https://github.com/AustralianSimon/storyparkScraper)** for the original inspiration and foundational concept for scraping Storypark data.

---

## License

This project is provided as-is for personal use. See the repository for license details.
