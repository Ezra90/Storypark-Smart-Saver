# 📸 Storypark Smart Saver

**Save all your child's Storypark photos and stories — straight to your computer. No technical knowledge needed.**

> ⏳ **Chrome Web Store version coming soon!** For now, follow the simple installation steps below.

Everything happens privately inside your Chrome browser. No accounts to create. No data sent anywhere. No subscriptions. Just your photos, saved safely on your own computer.

---

## ✅ What It Does

- **Saves every photo and story** from your child's Storypark account to your computer
- **Embeds the original date, story text, and daycare routine** into every photo — so they sort perfectly in Apple Photos, Google Photos, or Windows Photos
- **Organises photos into folders** by child name, story date, and classroom room name
- **Optional face recognition** — teach it what your child looks like, and it automatically filters to only your child's photos (runs entirely on your computer — nothing is ever uploaded)
- **Works completely offline** — once photos are downloaded, face sorting runs without any internet connection
- **Safe pacing** — mimics natural browsing so Storypark doesn't flag your account
- **Picks up where it left off** — if the scan is interrupted, just click Resume

---

## 🛡️ Privacy & Safety

| | |
|---|---|
| ✅ | **Everything stays on your computer.** No photos, names, or data ever leave your device. |
| ✅ | **No passwords stored.** Uses your existing Storypark login in Chrome. |
| ✅ | **Face recognition runs 100% offline.** The AI model is bundled inside the extension. |
| ✅ | **No accounts to create.** No Google sign-in. No subscriptions. |
| ✅ | **Open source.** You can see exactly how it works. |

---

## 🚀 How to Install

### What You Need
- **Google Chrome** (version 116 or newer)
- **A Storypark account** — you must be logged in at [app.storypark.com](https://app.storypark.com)

### Installation Steps

1. **Download the extension** — click the green **Code** button at the top of this page, then **Download ZIP**. Save it to your Desktop.
2. **Unzip the folder** — double-click the ZIP file to extract it.
3. **Open Chrome's extension page** — type `chrome://extensions` in your address bar and press Enter.
4. **Turn on Developer Mode** — flip the toggle in the top-right corner.
5. **Load the extension** — click **Load unpacked**, then select the **`extension`** folder from inside the unzipped download.
6. **Done!** The 📸 icon will appear in your Chrome toolbar.

> 💡 **Can't see the icon?** Click the puzzle-piece 🧩 icon in your toolbar and pin Storypark Smart Saver.

> 💡 **One-time Chrome setting:** Go to Chrome Settings → Downloads and turn **OFF** "Ask where to save each file" — this lets photos save silently without a popup every time.

---

## 📖 Three Ways to Use It

You can use Storypark Smart Saver in three ways — choose whichever suits you!

---

### 🅰 Option A — Smart Download (Best for most families)
*The extension learns your child's face while scanning, and only downloads matching photos.*

**Best when:** You want only your child's photos, don't want group photos of other children, and are happy to review a few photos to teach the AI.

**How long until photos download:** Usually a few hours of reviewing photos (10–100 approvals needed to unlock automatic downloads).

---

### 🅱 Option B — Download Everything, Sort Later
*Download every single photo immediately, then optionally sort by face recognition later.*

**Best when:** You just want to grab everything as fast as possible and don't mind sorting later. Great for parents who want a complete backup right now.

**How long until photos download:** Immediately — the very first scan downloads everything.

---

## 📖 Step-by-Step Instructions

### Option A — Smart Download (teaches the AI your child's face)

**Step 1 — Log in to Storypark**
Open [app.storypark.com](https://app.storypark.com) in Chrome and sign in as normal. Keep this tab open.

**Step 2 — Open the extension**
Click the 📸 icon in your Chrome toolbar. A dashboard will open in a new tab.

**Step 3 — Select your child and scan**
Choose your child from the dropdown list, then click **🔁 Full History Scan**. The extension will start reading through all your child's stories.

> 💡 You'll see "☕ Coffee Break" messages occasionally — this is normal! The extension pauses briefly to avoid looking like a robot.

**Step 4 — Review the photos**
As the scan runs, photos appear in the **👀 Pending Review** tab. For each photo:
- Click **✅ "This is my child"** — confirms it's your child and teaches the AI
- Click **✗ Reject** — not your child (teaches the AI what to ignore)

You don't need to review everything immediately — the scan runs in the background.

**Step 5 — Photos download automatically**
After you've approved enough photos (usually 100+), the AI becomes confident and **photos start downloading automatically** during future scans. You'll see them in your Downloads folder under `Storypark Smart Saver → [Child's Name]`.

> 💡 **Optional head start:** Before scanning, go to **Settings → Face Training** and upload 10+ clear photos of your child from your phone or computer. This gives the AI a head start so it learns faster.

---

### Option B — Download Everything, Sort Later

**Step 1 — Turn off face recognition**
Click **⚙ Settings** in the sidebar. Under **Download Settings**, turn on **"Download all photos (skip face recognition)"**.

**Step 2 — Run a Full History Scan**
Go back to the Scan tab, select your child, and click **🔁 Full History Scan**. Every photo will download immediately — no reviewing needed.

Every photo is saved with full metadata embedded:
- 📅 Original date of the story
- 📝 What the educator wrote about the day
- 🏠 Which classroom/room (e.g. "Nursery One")
- 🏫 The daycare centre name
- 📋 The daily routine (feeds, naps, nappies)
- 📍 GPS location of the daycare (if you add it in Settings → Centre Locations)
- 🎂 Your child's age at the time

> 💡 **GPS tip:** If you want the GPS location stamped into the actual photo files (so they show up on a map in Apple Photos or Google Photos), add your daycare's location in **Settings → 📍 Centre Locations** *before* clicking Download. You can paste a Google Maps link or coordinates — the extension can also try to look it up automatically using your daycare's name. If you forgot, the story HTML pages will still show the centre name correctly after a Build HTML — only the JPEG GPS needs to be set up early.

**Step 3 — Sort by face recognition later (optional)**
Once everything is downloaded, you can clean up the photos using the built-in face recognition — all without internet:

1. Go to **Settings → Face Training** and upload 10+ clear photos of your child from your own computer (no internet needed — reads your local files)
2. Go to **Settings → 📁 Link Download Folder** and select your Downloads folder
3. Go to **Settings → 🧹 Clean Up Folder** and run a scan of your saved photos

> ✅ **Completely offline!** The face recognition model is built into the extension. No photos leave your computer at any point.

---

## 👨‍👩‍👧 Downloading for Multiple Children

Select **👨‍👩‍👧‍👦 All Children** from the child dropdown to scan all your children at once.

---

## 🔍 Offline Facial Scan

After downloading your photos, you can run face recognition entirely offline — no internet, no Storypark connection needed. This is the most powerful way to improve your face model over time.

**Where to find it:** Scan & Download tab → **🔍 Offline Facial Scan** button (alongside Download Latest and Full History Scan)

**What it does:**
- Reads your actual JPEG files from disk — **fresh face detection every time** (not cached descriptors)
- High confidence matches → face model learns automatically
- Uncertain matches → sent to Review tab for your decision
- Low confidence → face model learns what NOT to match
- **Also rescans your "Rejected Matches" folder** — photos the AI previously rejected may now score higher with your improved model. If they qualify, they appear in the Review tab marked "⤴ From Rejected Matches — approve to rescue"
- **Saves fingerprint cache** — next online scan is up to 20x faster because it can skip re-downloading photos it already analysed offline

**Supports All Children mode** — select "👨‍👩‍👧‍👦 All Children" and it scans all children's folders sequentially.

**Works with zero training data** — if you haven't trained any photos yet, everything with a detected face goes to Review tab automatically (Phase 1 mode).

---

## 🔄 Re-scanning Rejected & Approved Photos

As your face model improves, you can re-evaluate previously rejected or approved photos to improve accuracy.

| Goal | How |
|------|-----|
| Re-scan ALL local photos (approved + rejected) with fresh detection | **🔍 Offline Facial Scan** (reads actual JPEG files) |
| Re-evaluate items in Review tab against improved model | AI does this automatically after every 10 approvals |
| Re-check approved pending downloads | Review tab → **✅ Final Verification** |
| Rescue photos the early AI rejected incorrectly | **🔍 Offline Facial Scan** automatically scans "Rejected Matches" folder |
| Re-evaluate ALL rejected photos (fetch from Storypark) | Settings → **🔄 Reset Rejected Images** → run Full History Scan |

**Why offline re-scanning is better than online:** Reading actual JPEG files from disk gives **higher quality re-evaluation** than cached face fingerprints. Fresh face detection on the real image can catch faces the original scan missed, especially as your model matures.

**How they work together:**
1. Run **🔍 Offline Facial Scan** → AI learns from local files → fingerprints saved to database
2. Next **⬇ Download Latest** (online) → uses new fingerprints → skips re-downloading those photos → faster!
3. The model keeps improving whether you're online or offline — it's the same brain.

---

## ⏸ If the Scan Gets Interrupted

Storypark sometimes rate-limits requests, especially for large accounts. If this happens:

- The extension **automatically saves your progress** every 5 stories
- You'll see a **⏸ Scan Paused** warning in the log
- A purple **▶ Resume from story X (Y remaining)** button appears
- Just click Resume — it picks up exactly where it stopped, even if you close and reopen Chrome

---

## 📥 Downloading Your Approved Photos

If you're using face recognition (Option A), approved photos are held in a queue until you download them:

1. Click the **👀 Pending Review** tab
2. You'll see a **📥 Download N Approved** button
3. Click it — all approved photos download at once, complete with story HTML pages and index pages

---

## 💾 Saving a Backup (Highly Recommended!)

The extension stores your progress (face model, approved photos list, scan position) in Chrome's internal storage. To protect against losing this if you reinstall Chrome:

1. Go to **Settings → 💾 Full Backup**
2. Click **📤 Export Full Backup**
3. Save the file somewhere safe (e.g. an external drive or cloud storage)

To restore: click **📥 Import Full Backup** and select your saved file.

> ⚠️ **Do this regularly!** If Chrome is uninstalled or data is cleared, your face model and approval history will be lost. A backup lets you restore everything in seconds.

---

## 📁 Link Download Folder (Verify Your Files)

This feature lets the extension check which photos are already saved on your computer.

1. Go to **Settings → 📁 Link Download Folder**
2. Click **📁 Link Download Folder** and select your **Downloads** folder (NOT the Storypark Smart Saver subfolder — select Downloads itself)
3. Click **🔍 Verify On Disk** to see a report of what's saved vs what's missing

> 💡 The extension saves files into `Downloads → Storypark Smart Saver → [Child's Name] → Stories`. Link the **Downloads** folder so the extension can find them.

---

## 🧹 Clean Up Folder (Remove Non-Matching Photos)

After downloading everything, use Clean Up to remove photos that don't contain your child's face.

**Requirements:** Linked download folder (above) + face training (10+ photos approved or uploaded)

1. Go to **Settings → 🧹 Clean Up Folder**
2. Select the child to clean up for
3. Choose a mode:
   - **🔍 Dry-run** — preview only, no files moved (try this first!)
   - **🛡 Safe** — moves non-matching photos to a `_rejected` folder (can be undone for 60 seconds)
   - **🗑 Destructive** — permanently deletes non-matching photos (use with caution)
4. Set the **Keep threshold** — photos with a face match score above this % are kept (default 40% is a good starting point)
5. Click **🧹 Run Clean Up**

> ✅ **Completely offline!** This reads your local files and runs the AI on your computer — no internet, no Storypark API calls.

---

## 🔄 Reset Rejected Images

If you accidentally rejected some photos and want to re-evaluate them on the next scan:

Go to **Settings → 🔄 Reset Rejected Images** → click the button.

This doesn't affect your face model or downloads — it just means those photos will be checked again next time you scan.

---

## 🧠 Understanding the AI Phases

When using face recognition, the AI gains confidence in 4 stages before it automatically downloads photos. This protects you from accidentally downloading the wrong child's photos.

| Phase | What's happening | Photos downloaded? |
|-------|-----------------|-------------------|
| 🔍 **Phase 1** (0–10 approvals) | Learning what your child looks like | ❌ No — all go to review |
| ✅ **Phase 2** (10–50 approvals) | Getting more accurate | ❌ No — most go to review |
| 📊 **Phase 3** (50–100 approvals) | Building confidence | ❌ No — using your thresholds |
| 🚀 **Phase 4** (100+ approvals) | Fully confident | ✅ Yes — downloads automatically! |

> **Want to skip this entirely?** Turn on "Download all photos" in Settings and you'll be in Phase 4 mode immediately — every photo downloads without any reviewing.

---

## ❓ Common Questions

**Q: Is this legal?**
You're downloading your own child's photos from an account you pay for. The photos are yours. This tool simply automates what you could do manually by clicking "Save image" on every photo.

**Q: Will Storypark know I'm using this?**
The extension uses the same login session as your browser. The built-in "Coffee Break" feature mimics natural browsing speed so it doesn't look automated.

**Q: My child goes to daycare 4 days a week — will it skip the other days?**
Yes! The "Only download from attended days" setting (on by default) checks daycare attendance records and skips stories from days your child wasn't there. This filters out other children's stories.

**Q: Can I use this on a Mac?**
Yes — it works on any computer running Chrome (Windows, Mac, Linux).

**Q: My scan stopped at story 100 of 500. Will it lose my progress?**
No. Your progress is saved every 5 stories. When you click the Resume button, it continues from exactly where it stopped — even if you closed Chrome in between.

**Q: The photos are downloading but I can't see the extension window anymore.**
The extension runs in the background. You can close the dashboard tab and the scan will keep going. Check the Activity Log tab to see what's happening.

**Q: Can I run this without the internet once photos are downloaded?**
Yes! The face recognition AI is bundled inside the extension (~7.5MB). Once your photos are downloaded, the Clean Up Folder feature and all face matching runs completely offline.

**Q: How do I find my downloaded photos?**
Look in your Downloads folder for a folder called **Storypark Smart Saver**, then your child's name, then **Stories**. Each story has its own folder with the date and story title.

**Q: I uploaded everything to Google Photos and deleted my local copies. Will "Download Latest" still work?**
Yes — completely. The extension tracks which stories have been scanned inside Chrome's own database (separate from your Downloads folder). Deleting local files has no effect on that record. Run "⬇ Download Latest" and it will only fetch new stories that appeared after your last scan. **Tip:** Export a Full Backup before deleting your local files — that way, even if Chrome is reinstalled, you can restore the backup and Download Latest still knows exactly where you got up to.

**Q: Something went wrong. How do I start fresh for one child?**
Go to **Settings → Face Training**, select the child, and click **🗑 Reset Face Data**. This resets the AI back to Phase 1 for that child only.

---

## 📂 Where Your Photos Are Saved

```
Downloads/
  Storypark Smart Saver/
    index.html                 ← Browse all children
    Alice Hill/
      Stories/
        2024-01-15 — Fun Day in Nursery One/
          story.html           ← The story text + photos together
          2024-01-15_Alice_Nursery-One_photo1.jpg
          2024-01-15_Alice_Nursery-One_photo2.jpg
        2024-01-22 — Painting in Nursery One/
          ...
    Hugo Hill/
      Stories/
        ...
```

Each folder is named by date so they sort chronologically. Open `index.html` in your browser for a beautiful photo gallery of all your child's stories.

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| Child list is empty | Click ↻ Refresh, then make sure you're logged in to Storypark in another tab |
| Scan stops with a rate-limit warning | Normal — click **▶ Resume** to continue |
| Photos aren't downloading | Check you're in Phase 4, or enable "Download all photos" in Settings |
| Face recognition isn't available | The AI models may not be loaded — try reloading the extension page |
| Download button keeps spinning | Chrome downloads might be paused — check your Chrome downloads panel |
| I accidentally rejected photos | Go to Settings → Reset Rejected Images → try again |

---

## 🌟 Feature Overview

| Feature | What it does | Optional? |
|---------|-------------|-----------|
| Full History Scan | Downloads all stories (first run) | — |
| Download Latest | Downloads only new stories since last run | — |
| **Offline Facial Scan** | **Re-runs face matching on disk files — no internet — rescues rejected photos** | ✓ |
| All Children | Scan all children at once | ✓ |
| Face Recognition | Filters to only your child's photos | ✓ |
| Skip Face Rec | Downloads every photo without filtering | ✓ |
| Attendance Filter | Skips stories from days your child was absent | ✓ |
| Resume | Continues an interrupted scan | Auto |
| Download Approved | Saves your approved photos to disk | — |
| Full Backup | Saves/restores all your progress | ✓ Recommended |
| Link Download Folder | Verifies what's saved on your computer | ✓ |
| Clean Up Folder | Removes non-matching photos from disk | ✓ |
| Reset Rejected Images | Re-evaluates previously rejected photos | ✓ |
| Centre Locations | Adds GPS coordinates for daycare (for EXIF) | ✓ |
| Save Story Pages | Creates browseable HTML pages with story text | ✓ |

---

*Made with ❤️ for parents who want to keep their children's memories safe.*
