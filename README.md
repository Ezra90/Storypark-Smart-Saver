# 📸 Storypark Smart Saver

**Automatically save your child's Storypark photos and stories — right to your computer.**

No servers. No accounts to create. No technical knowledge needed. Just install the extension, log in to Storypark as you normally would, and click a button. Everything runs privately inside your own Chrome browser.

> ⏳ **Chrome Web Store version coming soon!** For now, follow the simple steps below to install directly from GitHub.

---

## ✅ What It Does

- **Downloads all your child's photos and stories** from Storypark automatically
- **Stamps the original date and story text** into each photo so they sort correctly in Apple Photos, Google Photos, or Windows Photos
- **Organises photos into folders** by child name inside your Downloads folder
- **Optional face recognition** — train it with a few photos and it will automatically filter to just your child's photos (runs 100% on your computer — nothing is uploaded anywhere)
- **Smart pacing (Coffee Break)** — mimics natural browsing so Storypark doesn't block your account
- **Colour-coded Activity Log** — see exactly what's happening at every step

---

## 🛡️ Privacy & Safety

- ✅ **Everything stays on your computer.** No data is ever sent to any server.
- ✅ **No passwords are stored.** It uses your existing Storypark login session in Chrome.
- ✅ **Face recognition runs locally.** Your photos never leave your device.
- ✅ **No Google account or extra sign-in required.**

---

## 🚀 How to Install

### What You Need

| Requirement | Details |
|---|---|
| **Google Chrome** | Version 116 or newer |
| **A Storypark account** | You must be logged in at [app.storypark.com](https://app.storypark.com) |

### Step-by-Step Installation

1. **Download the extension** — click the green **Code** button at the top of this page, then choose **Download ZIP**. Save it somewhere easy to find (e.g. your Desktop).
2. **Unzip the folder** — double-click the downloaded ZIP file to extract it.
3. **Open Chrome's extension page** — type `chrome://extensions` into the address bar and press Enter.
4. **Turn on Developer Mode** — flip the toggle in the top-right corner of the page.
5. **Load the extension** — click **Load unpacked**, then select the `extension` folder from inside the unzipped download.
6. **Done!** The 📸 Storypark Smart Saver icon will appear in your Chrome toolbar.

> 💡 **Can't see the icon?** Click the puzzle-piece 🧩 icon in Chrome's toolbar and pin Storypark Smart Saver.

---

## 📖 How to Use

### Basic Download

1. **Log in to Storypark** — open [app.storypark.com](https://app.storypark.com) in Chrome and sign in as normal.
2. **Click the 📸 icon** in your toolbar to open the extension.
3. **Select your child** from the dropdown. Click **↻** to refresh the list if it's empty.
4. Choose how you want to download:
   - **⬇ Download Latest** — downloads only new photos since your last run (great for regular use)
   - **🔁 Full History Scan** — re-downloads and re-processes everything from scratch (use this the first time, or if something went wrong)
5. **Watch the Activity Log tab** to see progress in real time.
6. **Photos appear in your Downloads folder**, organised into a folder named after your child.

### 👨‍👩‍👧 Downloading for Multiple Children

In the child dropdown, you can select **All Children** to download photos for every child in your Storypark account at once — no need to run it separately for each child.

### 🛑 Stopping a Scan

Click the **⏹ Stop Scan** button at any time to safely pause the download. You can resume by clicking Download Latest again — it picks up from where it left off.

---

## 🧒 Face Recognition (Optional)

Face recognition lets the extension automatically identify which photos contain your child's face, so you only download the photos that matter most. **This feature is completely optional** — without it, every photo is downloaded automatically.

### How to Set It Up

1. Click the extension icon → open **⚙ Settings**.
2. Select your child from the list.
3. Under **Face Training Data**, upload 5–10 clear, well-lit photos of your child's face.
4. That's it! The extension will now recognise your child in photos automatically.

### How It Works

- Photos with a **high confidence match** are downloaded automatically. ✅
- Photos the extension is **unsure about** go into a **Pending Review** queue. 🔍
- Photos with a **low match score** are skipped. ❌

### 👀 Reviewing Pending Matches

1. Click the extension icon → open the **Pending Matches** tab.
2. You'll see thumbnail photos waiting for your decision.
3. Click ✅ **Approve** to download the photo, or ❌ **Reject** to skip it.
4. Made a mistake? Click **⤺ Undo** to reverse your last decision.

### Adjusting Sensitivity

In **⚙ Settings**, you can adjust the confidence thresholds:
- **Auto-approve threshold** (default 85%) — photos above this score download automatically.
- **Minimum threshold** (default 50%) — photos below this score are discarded.
- Photos between the two thresholds go to the Pending Review queue.

---

## 📅 EXIF Metadata (Dates & Stories in Your Photos)

Every downloaded JPEG photo has the **original Storypark date and story text stamped directly into the photo file**. This means:

- ✅ Apple Photos, Google Photos, and Windows Photos will sort the photos by their **real date**, not the download date.
- ✅ The story description is saved inside the photo so you can always find the context.
- ✅ The daily routine summary (meals, sleep, activities) is also included if available.

No action is needed — this happens automatically for every photo.

---

## 📍 GPS Location Tagging (Optional)

If your child's daycare or kindergarten location is known, the extension can **embed GPS coordinates into photos** so they appear on the map in your photo library.

To set this up:
1. Open **⚙ Settings** → **Centre Locations**.
2. Your child's centre should appear automatically. If it doesn't, click **Discover Centres**.
3. If the location looks right, you're done. GPS will be embedded automatically.

---

## ☕ Coffee Break — Account Protection

The extension deliberately pauses for short breaks every 15–25 downloads. You'll see a **☕ Coffee Break** message in the Activity Log when this happens.

This is intentional — it mimics natural human browsing behaviour to keep your Storypark account safe. Just leave the browser open and it will resume automatically.

---

## 📋 Activity Log

The Activity Log tab shows a colour-coded live feed of everything the extension is doing:

| Colour | Meaning |
|---|---|
| 🟢 Green | Success — photo downloaded, story processed |
| 🔵 Blue | Info — progress updates, paging through stories |
| 🟡 Yellow | Warning — skipped item, low confidence match |
| 🔴 Red | Error — connection issue, login required |

The log is saved between sessions so you can always look back at previous runs.

---

## 🔌 Test Connection

Before starting a scan, you can click **Test Connection** in the extension popup to verify that you're logged in and the extension can reach Storypark successfully.

---

## 👋 First-Run Welcome

The first time you open the extension, a brief welcome overlay will guide you through the basics. You can dismiss it at any time and re-open it from the Settings page.

---

## ❓ Troubleshooting

| Problem | What to Do |
|---|---|
| "Authentication required" | Make sure you're logged in to [app.storypark.com](https://app.storypark.com) in the same Chrome window |
| "Rate limited by Storypark" | The extension paused automatically — wait a few minutes and try again |
| No children showing in dropdown | Click **↻** to refresh while logged in to Storypark |
| No photos downloading | Check the Activity Log for errors; make sure your child has photo posts |
| Photos going into Review Queue | Lower the confidence thresholds in Settings, or add more face training photos |
| Face recognition not working | Try reinstalling the extension from the latest ZIP download, then reload it |
| Photos have wrong dates | Check that EXIF is enabled; only JPEG files support date stamping |
| Want to start fresh | Use **🔁 Full History Scan** to reprocess everything from scratch |

---

## 🙏 Credits

Built with the help of these amazing open-source projects:

- **[Human](https://github.com/vladmandic/human)** by Vlad Mandic — powers the local, privacy-first face recognition engine
- **[Piexifjs](https://github.com/hMatoba/piexifjs)** by hMatoba — handles writing original dates and story text into photos
- Inspired by **[AustralianSimon's Storypark Scraper](https://github.com/AustralianSimon/storyparkScraper)**

---

## 📄 License

This project is provided as-is for personal use. See the repository for license details.

---

---

## 🛠️ For Developers

> **This section is for contributors only.** Normal users do not need to follow these steps.

The AI model files (`human.js`, `blazeface`, `faceres`) are **automatically kept up-to-date** by the GitHub Actions CI workflow (`.github/workflows/update-libs.yml`), which runs after every merged PR and on a weekly schedule. The built files are committed directly to the repository, so users who download the ZIP get everything they need automatically.

**To set up a local development environment:**

```bash
git clone https://github.com/Ezra90/Storypark-Smart-Saver.git
cd Storypark-Smart-Saver
npm install && npm run setup
```

`npm run setup` downloads the latest `@vladmandic/human` model weights into `extension/lib/` and `extension/models/`. This is only needed for local development — the CI workflow handles this for everyone else.

**To regenerate extension icons:**

```bash
node scripts/generate-icons.js
```
