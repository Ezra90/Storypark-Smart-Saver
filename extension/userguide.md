# 📖 User Guide
A guide for mums and dads — no tech knowledge needed!

---

## 🤔 Which approach is right for you?

[option-a]
**🅰 Smart Download** — scans and filters as it goes, only saves your child's photos.
Takes longer to start downloading (need to approve ~100 photos first), but photos are already sorted when they arrive.
[/option-a]

[option-b]
**🅱 Download Everything First** — saves every photo immediately, sort by face later (optional).
Fast! Everything downloads in one run. Great for getting a complete backup quickly.
[/option-b]

---

## 🅰 Smart Download — Step by Step

### 1. One-time Chrome setup
Go to **Chrome Settings → Downloads** and turn **OFF** "Ask where to save each file". This stops the save-file popup appearing for every photo.

### 2. Log in to Storypark
Open [Storypark](https://app.storypark.com) in another tab and sign in as normal.

### 3. Select your child and run Full History Scan
Choose your child from the dropdown, then click **🔁 Scan All Stories**. The extension starts working through all stories. You'll see "☕ Coffee Break" pauses — totally normal!

### 4. Teach the AI your child's face
Photos appear in the **👀 Pending Review** tab as the scan runs. For each one:
- **✅ "This is my child"** — saves the face + trains the AI
- **✗ Reject** — not your child (also teaches the AI)

The more you approve, the smarter it gets! You don't have to review everything right away.

### 5. Photos download automatically after ~100 approvals
Once the AI is confident, photos start downloading on their own. Find them in your **Downloads → Storypark Smart Saver → [Child's Name]** folder.

> 💡 **Optional head start:** Before scanning, go to **Settings → 🧠 Face Training** and upload 10+ clear photos of your child from your phone or computer. The AI learns faster with a head start — but it's not required!

---

## 🅱 Download Everything — Step by Step

### 1. Turn on "Download all photos"
Tick the **📥 Download All Media** checkbox on the Scan tab (or go to **⚙ Settings → Download Settings** and enable "Download all photos (skip face recognition)").

### 2. Run a Full History Scan
Every photo downloads immediately — no reviewing needed. Each photo has full metadata embedded: original date, story text, classroom name, daycare routine (feeds, naps, nappies), GPS location of the daycare, and your child's age.

### 3. Sort by face later (optional — works completely offline!)
- **Settings → 🧠 Face Training** → upload photos of your child from your computer
- **Settings → 📁 Link Download Folder** → select your Downloads folder
- **Settings → 🧹 Clean Up Folder** → moves non-matching photos to a Rejected Matches folder

*The AI model is bundled inside the extension (~7.5 MB). No internet needed — runs 100% on your computer!*

> 💡 **Great for the "Download Everything, Then Sort" approach:** After downloading everything, upload 10 training photos from your phone → run Offline Facial Scan → model improves → photos in Rejected Matches folder get re-evaluated automatically.

---

## 🔍 Offline Facial Scan — Re-scan Without Internet

In the Scan tab, there is a **🔍 Offline Facial Scan** button. This reads your already-downloaded photos directly from your hard drive — no internet needed.

- ✅ **High confidence** → face model learns automatically
- 👀 **Uncertain matches** → go to Review tab for your decision
- ❌ **Low confidence** → model learns what NOT to match
- ⤴ **Also rescans Rejected Matches folder** — photos the AI rejected early may now score better! They appear in Review tab marked "approve to rescue"
- ⚡ **Saves fingerprint cache** → next online scan skips re-downloading photos already analysed offline (up to 20× faster)

---

## ⏸ If the Scan Gets Interrupted

Storypark occasionally slows things down for large accounts. Don't worry:

- Progress is saved automatically every 5 stories
- A purple **▶ Resume from story X (Y remaining)** button will appear
- Click it and the scan picks up exactly where it stopped — even after closing Chrome

---

## 📥 Getting Your Photos (Smart Download mode)

In Smart mode, approved photos are held in a queue. When you're ready, click the **📥 Download N Approved** button in the Review tab to save them all at once — including story pages with the educator's text.

---

## 🧠 The 4 AI Phases (Smart mode)

The AI locks downloads at first to protect against downloading the wrong child's photos. Each time you approve a photo, it gets smarter:

[phase-1]
**Phase 1** (0–10 approvals) — Learning mode. All photos go to review. No downloads yet.
[/phase-1]

[phase-2]
**Phase 2** (10–50 approvals) — Getting better. Most still go to review. No downloads yet.
[/phase-2]

[phase-3]
**Phase 3** (50–100 approvals) — Very accurate. Downloads are deferred to your control.
[/phase-3]

[phase-4]
**Phase 4** (100+ approvals, 80%+ confidence) — Fully automatic! Photos download without any reviewing.
[/phase-4]

---

## 💾 Your Data Stays Private

- Everything runs locally inside Chrome — no data is sent to any server
- Your face training data, scan history, and settings are stored on your own computer
- Storypark photos are downloaded directly from Storypark to your computer
- Use **Settings → 💾 Full Backup** to export everything before reinstalling Chrome
