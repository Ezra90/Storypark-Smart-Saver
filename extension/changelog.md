# 📋 What's New

---

## v2.5.0 — April 2026

- ✅ **ETA on all 8 status bars** — every progress bar now shows estimated time remaining (e.g. "⏱ ~12m")
- ✅ **Shared UI helpers** — consistent progress, button state, and GC yield across all operations
- ✅ **User guide loaded from file** — `userguide.md` can be updated without touching any code
- ✅ **Changelog panel** — you're reading it! `changelog.md` is also a separate file
- ✅ **CSS extracted** — `dashboard.css` is now a standalone file for easier styling changes
- ✅ **AI self-maintenance rules** — `AI_RULES.md` updated with canonical patterns for future development

---

## v2.4.0 — March 2026

- ✅ **Offline Facial Scan (Scan tab)** — runs face matching on disk files without internet; works for All Children too
- ✅ **Offline Smart Scan (Settings tab)** — self-improving AI on local files, queues uncertain matches for review
- ✅ **Re-evaluate All Photos** — re-runs face matching on all downloaded photos with the current (improved) model
- ✅ **Clean Up Folder** — removes photos that don't match your child's face; safe mode moves to Rejected Matches
- ✅ **Undo Clean Up** — 60-second window to restore moved files after a cleanup run
- ✅ **Batch PROGRESS ETA** — Download Approved progress bar now shows ETA
- ✅ **Auto-rescue from Rejected Matches** — approving a photo from Rejected Matches automatically moves it back

---

## v2.3.0 — February 2026

- ✅ **Full Backup export/import** — gzip-compressed backup of all face data, scan progress, and settings
- ✅ **Repair Database from Disk** — rebuilds IDB manifests from files already on disk
- ✅ **Sync Scan Progress** — marks all stored stories as processed so Scan Latest only fetches new content
- ✅ **Story card re-generate** — re-render all story JPEG cards (useful after GPS or educator updates)
- ✅ **Active Database panel** — shows IDB database file sizes and last-updated time
- ✅ **Audit & Repair Stories** — classifies every story as complete / missing photos / DB-only and repairs broken ones

---

## v2.2.0 — January 2026

- ✅ **Fix Photo Metadata** — re-embeds GPS, date, IPTC caption, keywords in all downloaded JPEGs
- ✅ **GPS pre-flight check** — warns before Fix Metadata if any centres don't have coordinates
- ✅ **Metadata verification** — optional post-write check to confirm EXIF was correctly written
- ✅ **Date range selector** — limit scans to a custom From/To date range instead of full history
- ✅ **Global stop banner** — Stop Scan button stays visible on all tabs while a scan is running
- ✅ **Video download progress** — live MB counter in scan log for large video downloads

---

## v2.1.0 — December 2025

- ✅ **4-phase face recognition** — Phase 1–4 progression with confidence tracking
- ✅ **Review queue pagination** — shows 10 cards at a time for performance; fills gap on approve/reject
- ✅ **Smart merge** — incremental DOM updates instead of full rebuild on REVIEW_QUEUE_UPDATED
- ✅ **Keyboard shortcuts** — A (approve), R (reject), Z (undo) in Review tab
- ✅ **Resume interrupted scans** — checkpoint saved every 5 stories; purple Resume button appears
- ✅ **Lightbox** — click any review photo to see full-resolution from Storypark

---

## v2.0.0 — November 2025

- ✅ **Unified dashboard** — popup, review, log, and settings merged into one full-page dashboard
- ✅ **Activity log tab** — timestamped log with colour-coded levels (SUCCESS / WARNING / ERROR / INFO)
- ✅ **Scan All Children** — scan or download for all children in one operation
- ✅ **Centre locations** — GPS auto-lookup via OpenStreetMap Nominatim; embedded at download time
- ✅ **Full Backup export v2.1** — year-bucketed descriptors + phase data included
- ✅ **Auto-scroll with follow button** — scan log and activity log pause scrolling when you scroll up
