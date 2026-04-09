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
| **Google account** | The Google account you want to save photos to |

### 1. Install the Extension

1. Open the [Chrome Web Store listing](#) *(link will be available once the extension is published — ask whoever shared this with you for the install link)*.
2. Click **Add to Chrome** → **Add extension**.
3. The Storypark Photo Sync icon will appear in your Chrome toolbar. 🎉

### 2. Connect Your Google Account

1. Click the extension icon in your toolbar.
2. Click **Connect to Google** and sign in with the Google account you want photos saved to.
3. Grant the requested permissions (the extension only accesses Google Photos).

### 3. Open Storypark

Open a new tab, go to [app.storypark.com](https://app.storypark.com), and log in to your account. The extension needs this tab open to find new photos.

### 4. Configure Your Settings (Optional)

Click **⚙ Settings** (or right-click the extension icon → **Options**) to personalise:

- **Children**: Add your child's name and a clear reference photo so the extension can recognise them.
- **Daycare Location**: Enter your daycare's name and GPS coordinates so photos sort correctly on the Google Photos map. ([Find coordinates on Google Maps](https://www.google.com/maps) — right-click any location → "What's here?")
- **Face Recognition Strictness**: Choose how carefully the extension checks faces (Normal is recommended for most families).
- **Album**: Choose or create a Google Photos album for uploads.

Click **💾 Save Settings** when done.

### 5. Sync!

Click the extension icon → **🔄 Sync Now**. The extension will find new daycare photos and save them straight to your Google Photos. Progress appears in the popup — sit back and enjoy! ☕

---

## Usage

### First-Time Setup

1. Click the extension icon → **Connect to Google** → authorize with your Google account.
2. Click **⚙ Settings** (or right-click the icon → Options) to open the Settings page.
3. Configure:
   - **Children**: Add names and upload a clear reference photo for each child.
   - **Daycare Location**: Enter your daycare's name and GPS coordinates (latitude/longitude). [Find on Google Maps](https://www.google.com/maps) — right-click any location → "What's here?" to get coordinates.
   - **Face Recognition Strictness**: Choose how carefully the extension checks faces (Normal is recommended).
   - **Album**: Choose an existing Google Photos album or create a new one.
4. Click **💾 Save Settings**.
5. *(Optional)* In the **Face Training Data** section, upload 5–10 clear face photos of each child to build the recognition model. A live match % is shown for each photo to help you choose high-quality training images. You can also import photos directly from a Google Photos album.

### Syncing Photos

1. Open a tab with [app.storypark.com](https://app.storypark.com) and log in.
2. Click the extension icon → **🔄 Sync Now**.
3. The extension will:
   - Scroll your Storypark feed to discover photos
   - Download new images
   - Apply facial recognition (if configured) and classify photos:
     - **Auto-approved** (match ≥ Auto-Approve threshold) → uploaded immediately
     - **Review Queue** (match between thresholds) → held for manual review
     - **Discarded** (match below Minimum threshold) → skipped
   - Stamp EXIF date, GPS, and daycare name into each photo
   - Upload approved photos to Google Photos
4. Progress is shown in the popup's log panel.

### Face Recognition Strictness

The **Settings** page lets you choose how carefully the extension checks that a photo contains your child's face:

| Setting | Auto-Approve | Minimum Review | Behaviour |
|---|---|---|---|
| **Strict** | 90% | 60% | Fewer mistakes, might miss some photos |
| **Normal** *(recommended)* | 85% | 50% | Balanced for most families |
| **Loose** | 70% | 30% | Catches everything, might include other kids |

> **Tip:** Start with **Normal**. If too many wrong kids appear, switch to **Strict**. If you're missing photos of your child, try **Loose**.

### Review Queue

When a sync runs, photos that fall between the two thresholds appear in the **Review Queue** at the bottom of the popup. For each photo you can:
- **✅ Approve** — stamps EXIF data and uploads it to Google Photos immediately.
- **❌ Reject** — discards the photo (it will not be processed again).

### Incremental Sync

The extension remembers which images have already been processed. On subsequent syncs, it stops scrolling early once it encounters previously-seen photos, making follow-up syncs much faster.

---

## Project Structure

```
extension/
├── manifest.json          # Chrome Extension manifest (V3)
├── background.js          # Service worker – orchestrates the sync pipeline
├── content.js             # Content script – injected into Storypark, scrapes the feed
├── offscreen.html         # Offscreen document host (face-api.js needs Canvas/DOM)
├── offscreen.js           # Face recognition worker (runs in offscreen document)
├── popup.html / popup.js  # Popup UI – Connect, Sync, progress log, Review Queue
├── options.html / options.js  # Settings page – children, thresholds, GPS, album, training
├── lib/
│   ├── db.js              # IndexedDB helper – processed-URL ledger (unlimited storage)
│   ├── utils.js           # Shared constants and helpers
│   ├── exif.js            # EXIF metadata writer (date + GPS)
│   └── face.js            # Face detection/recognition helpers (used by options page)
├── models/                # face-api.js model weights (user-supplied)
└── icons/                 # Extension icons
```

### Module Responsibilities

| Module | Role |
|---|---|
| `background.js` | Service worker: Google OAuth, image download, offscreen face filtering, EXIF stamping, Google Photos upload, review queue management |
| `content.js` | Content script: scrolls Storypark feed, extracts image URLs and post dates from the DOM |
| `offscreen.js` | Offscreen document worker: face-api.js face recognition (requires Canvas/DOM APIs unavailable in service worker) |
| `popup.js` | Popup UI: 1-click sync, connection status, live progress log, Review Queue HITL |
| `options.js` | Settings page: children, daycare name/GPS, confidence thresholds, album selection, face training |
| `lib/db.js` | IndexedDB helper: stores the processed-URL ledger with virtually unlimited capacity |
| `lib/exif.js` | Pure-JS EXIF writer — stamps DateTimeOriginal and GPS into JPEG blobs |
| `lib/face.js` | Face detection/recognition via face-api.js (TensorFlow.js, runs 100% client-side) |
| `lib/utils.js` | Shared selectors, timing constants, logging, date parsing |

---

## Architecture Notes

### Manifest V3 Compliance

- Uses a **service worker** (`background.js`) instead of a persistent background page.
- All network requests use `fetch()` (no XMLHttpRequest).
- OAuth handled through `chrome.identity.getAuthToken()`.
- User settings, thresholds, and face descriptors stored in `chrome.storage.local`.
- The **processed-URL ledger** (history of every image already handled) is stored in **IndexedDB** via `lib/db.js`. This provides virtually unlimited capacity and avoids the 5 MB hard limit that `chrome.storage.local` would hit for users with years of Storypark history.

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
| No photos uploaded | Check that your Storypark feed has images; try scrolling manually first to confirm they load |
| All photos going to Review Queue | Change Face Recognition Strictness to **Normal** or **Loose** in Settings |
| Too many wrong photos uploaded | Change Face Recognition Strictness to **Strict** and/or add more training photos |
| Face recognition not working | Add training photos in Settings → Face Training Data |
| "Daily quota reached" | Google Photos limits uploads per day; wait 24 hours and sync again |
| Want to reprocess everything | Open Chrome DevTools → Application → Storage → IndexedDB → `storyparkSyncDB` → `processedUrls` → clear the object store |
| Review Queue not clearing | Use ✅ Approve or ❌ Reject buttons in the popup for each item |

---

## License

This project is provided as-is for personal use. See the repository for license details.