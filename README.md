# Storypark Photo Sync – Chrome Extension

A Google Chrome extension that automatically syncs your children's daycare photos from [Storypark](https://app.storypark.com) to your [Google Photos](https://photos.google.com) account.

**What it does:**

1. **Scrapes** your Storypark activity feed for photos.
2. **Filters** photos using client-side facial recognition (only keeps pictures of *your* children).
3. **Stamps EXIF metadata** — embeds the original Storypark post date and your daycare's GPS coordinates so photos sort correctly in Google Photos.
4. **Uploads** directly to Google Photos (optionally into a specific album).

No server, no Python, no command-line — just install the extension and click **Sync Now**.

---

## Quick Start

### Prerequisites

| Requirement | Details |
|---|---|
| **Google Chrome** | Version 116 or later (Manifest V3 support) |
| **Storypark account** | You must already have a parent account on [app.storypark.com](https://app.storypark.com) |
| **Google Cloud OAuth Client ID** | Required so the extension can authenticate with Google Photos (see [Setup](#1-create-a-google-cloud-oauth-client-id) below) |

### 1. Create a Google Cloud OAuth Client ID

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Navigate to **APIs & Services → Library** and enable the **Google Photos Library API**.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
5. Set the application type to **Chrome Extension**.
6. Enter your extension's ID (found on `chrome://extensions` after loading it — see step 3 below).
7. Download the client ID. You'll need the **Client ID** string (e.g. `123456.apps.googleusercontent.com`).

### 2. Configure the Extension

1. Clone or download this repository.
2. Open `extension/manifest.json` and replace `YOUR_CLIENT_ID.apps.googleusercontent.com` in the `oauth2.client_id` field with your actual Client ID from step 1.

### 3. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` folder from this repository.
4. The Storypark Photo Sync icon will appear in your toolbar.

> **Tip:** After loading, copy the extension's **ID** from the extensions page and paste it into your Google Cloud OAuth credentials (step 1.6) if you haven't already.

### 4. Set Up Face Recognition Models (Optional)

To enable facial recognition filtering:

1. Download the face-api.js model weights from [justadudewhohacks/face-api.js/weights](https://github.com/justadudewhohacks/face-api.js/tree/master/weights).
2. You need these three models:
   - `ssd_mobilenetv1_model-weights_manifest.json` + shard files
   - `face_landmark_68_model-weights_manifest.json` + shard files
   - `face_recognition_model-weights_manifest.json` + shard files
3. Place all downloaded files into the `extension/models/` directory.
4. Download [`face-api.min.js` (v0.22.2)](https://raw.githubusercontent.com/justadudewhohacks/face-api.js/v0.22.2/dist/face-api.min.js) and place it in `extension/lib/`.

> Without these models, the extension will still scrape and upload **all** photos from your feed (no filtering).

---

## Usage

### First-Time Setup

1. Click the extension icon → **Connect to Google** → authorize with your Google account.
2. Click **⚙ Settings** (or right-click the icon → Options) to open the Settings page.
3. Configure:
   - **Children**: Add names and upload a clear reference photo for each child.
   - **Daycare Location**: Enter your daycare's GPS coordinates (latitude/longitude). [Find on Google Maps](https://www.google.com/maps) — right-click any location → "What's here?" to get coordinates.
   - **Album**: Choose an existing Google Photos album or create a new one.
4. Click **💾 Save Settings**.

### Syncing Photos

1. Open a tab with [app.storypark.com](https://app.storypark.com) and log in.
2. Click the extension icon → **🔄 Sync Now**.
3. The extension will:
   - Scroll your Storypark feed to discover photos
   - Download new images
   - Apply facial recognition (if configured)
   - Stamp EXIF date & GPS metadata
   - Upload matching photos to Google Photos
4. Progress is shown in the popup's log panel.

### Incremental Sync

The extension remembers which images have already been processed. On subsequent syncs, it stops scrolling early once it encounters previously-seen photos, making follow-up syncs much faster.

---

## Project Structure

```
extension/
├── manifest.json          # Chrome Extension manifest (V3)
├── background.js          # Service worker – orchestrates the sync pipeline
├── content.js             # Content script – injected into Storypark, scrapes the feed
├── popup.html / popup.js  # Popup UI – Connect, Sync, progress log
├── options.html / options.js  # Settings page – children, GPS, album
├── lib/
│   ├── utils.js           # Shared constants and helpers
│   ├── exif.js            # EXIF metadata writer (date + GPS)
│   └── face.js            # Face detection/recognition via face-api.js
├── models/                # face-api.js model weights (user-supplied)
└── icons/                 # Extension icons
```

### Module Responsibilities

| Module | Role |
|---|---|
| `background.js` | Service worker: Google OAuth, image download, EXIF stamping, Google Photos upload, state tracking |
| `content.js` | Content script: scrolls Storypark feed, extracts image URLs and post dates from the DOM |
| `popup.js` | Popup UI: 1-click sync, connection status, live progress log |
| `options.js` | Settings page: children management, GPS input, album selection |
| `lib/exif.js` | Pure-JS EXIF writer — stamps DateTimeOriginal and GPS into JPEG blobs |
| `lib/face.js` | Face detection/recognition via face-api.js (TensorFlow.js, runs 100% client-side) |
| `lib/utils.js` | Shared selectors, timing constants, logging, date parsing |

---

## Architecture Notes

### Manifest V3 Compliance

- Uses a **service worker** (`background.js`) instead of a persistent background page.
- All network requests use `fetch()` (no XMLHttpRequest).
- OAuth handled through `chrome.identity.getAuthToken()`.
- State stored in `chrome.storage.local` (replaces the Python app's SQLite database and config.json).

### Anti-Bot Measures

The content script mimics human browsing to avoid triggering Storypark's rate limiting:
- Random delays (1.5–3.5 seconds) between scroll actions.
- Prefers clicking "Load more" buttons over infinite scroll.
- Stops early during incremental syncs.

### EXIF Metadata

Every uploaded photo is stamped with:
- **DateTimeOriginal / DateTimeDigitized** → the Storypark post date (so photos sort chronologically).
- **GPS coordinates** → your daycare's location (so photos appear on the Google Photos map).

### Quota Handling

Google Photos API has daily upload limits. If the quota is reached mid-sync, the extension:
- Saves progress (already-uploaded images are marked as processed).
- Displays a friendly message: *"Daily quota reached. Try again tomorrow."*
- The next sync picks up where it left off.

---

## Privacy & Security

- **No external servers.** Everything runs locally in your browser.
- **No passwords stored.** Storypark login happens in your existing browser session; the extension reads the DOM while you're logged in.
- **Google OAuth tokens** are managed by Chrome's built-in `chrome.identity` API and are never exposed to the extension's code as raw strings on disk.
- **Face recognition** runs entirely client-side via TensorFlow.js — no images are sent to any remote service.
- **Reference photos** are stored in `chrome.storage.local` (encrypted at rest by Chrome).

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "No Storypark tab found" | Open [app.storypark.com](https://app.storypark.com) in a tab and log in before syncing |
| "Not connected to Google" | Click **Connect to Google** in the popup |
| Google connection fails | Verify your OAuth Client ID is correct in `manifest.json` and the Photos Library API is enabled |
| No photos uploaded | Check that your Storypark feed has images; try scrolling manually first to confirm they load |
| Face recognition not working | Ensure model weight files are in `extension/models/` (see [Setup](#4-set-up-face-recognition-models-optional)) |
| "Daily quota reached" | Google Photos limits uploads per day; wait 24 hours and sync again |
| Want to reprocess everything | Open Chrome DevTools → Application → Storage → Clear `processedUrls` from extension storage |

---

## License

This project is provided as-is for personal use. See the repository for license details.