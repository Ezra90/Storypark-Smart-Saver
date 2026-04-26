# Storypark Smart Saver Guide

This guide is written for mums and dads. Follow the Quick Start order in the app.

---

## Quick Start (Recommended)

Use the **Quick Start** strip at the top of the dashboard to run each step directly.
Each step also shows where to find the same action in the menu.

### 1) Link Folder
Go to **Step 1–2: Sync & Check** and click **Link Folder**.

- Choose your Downloads folder (or the parent folder that contains `Storypark Smart Saver`).
- This lets the app compare what is already on disk against Storypark.

#### Folder structure and restore behavior

- Set the **parent folder** that contains `Storypark Smart Saver`.
- Expected structure:
  - `Parent folder` -> `Storypark Smart Saver/Database/`
  - `Parent folder` -> `Storypark Smart Saver/{Child}/Stories/{Story Folder}/...`
- `Verify Directory` checks story folders that contain `metadata.json` (usually newer installs).
- `Verify Files on Disk` compares actual files against expected records and is best for restored/older libraries.
- If you move `Storypark Smart Saver` to a different parent folder (for example Desktop -> Downloads), re-link the new parent once; existing `Database/` state is reused.

### Before you start (important setup)

For smooth unattended downloads:

- In Chrome, open **Settings → Downloads** and turn off **“Ask where to save each file before downloading”**.
  - Direct link: `chrome://settings/downloads`
  - This prevents a save popup for every file.
- Ensure your computer does **not sleep** during long runs.
  - Keep power settings on while plugged in for the expected sync/download window.
  - Large full-history libraries can take many hours.

### 2) Sync Storypark Info
Open **Settings** and click **Sync Information From Storypark**.

- Pulls story metadata to local `Database/` files.
- Supports multiple daycares and long histories.
- Saves checkpoints so long syncs can safely resume.

### 3) Download Latest
Go to **Step 3: Download Latest** and click **Scan for Missing Media**.

- Downloads only what is missing/new.
- Shows progress, ETA, and live activity log.
- For first-time full history libraries, this can take several hours.
  - Example: a 3-year history may take around 12 hours depending on media volume, internet speed, and Storypark response time.
- You can watch the floating status bar for **overall time remaining** and use **Stop Scan** if needed.

### 4) Check & Restore Missing
Go to **Step 4: Check & Restore Missing**.

- Use this if files were deleted/moved after cloud upload.
- Compares local files against expected API counts and offers restore.

---

## Face Review (How it improves over time)

When the app is not sure, photos go to **Face Review**.

- **Yes, this is my child** improves matching for that child.
- **Not my child** teaches what to avoid.
- **Improve Face Review Now** re-checks older decisions with the latest model.
- **Build Face Review Starting Point** creates a first pass from your existing saved library.

You can see progress in **Face Review Health** (examples saved, recovered skipped photos, trend).

---

## If a scan pauses or stops

- Your progress is checkpointed.
- Resume options appear in the UI.
- Activity logs are saved in `Database/activity_log.json` and `Database/activity_log.txt`.

---

## Privacy and safety

- Face matching runs locally on your machine.
- Data is stored in your linked `Storypark Smart Saver/Database/` folder.
- No extra cloud service is required for face review.

---

## Tips for best results

- Add 10+ clear face examples per child in **Settings → Face Review Training**.
- Keep centre locations set correctly for metadata accuracy.
- Run **Refresh Stats** and **Check & Restore Missing** after large cleanups.
- Use **Run Retention Now** occasionally if your library is very large.
