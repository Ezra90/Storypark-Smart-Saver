# 📋 What's New

---

## v3.5.0 — April 2026

- ✅ **PDF story pages now downloaded** — HAR analysis confirmed `story_pdf_*` files are JPEG images (HTTP 200, accessible to family accounts). SSS now downloads all PDF pages as `pdf_page_01.jpg`, `pdf_page_02.jpg`, etc.
- ✅ **Second daycare centre name pre-populated** — `group_name` from the story list feed is now used to discover ALL daycares during pagination, fixing the bug where a child's second daycare did not appear in Centre Locations
- ✅ **Educator-set event date** — SSS now uses `story.date` (the educator-set event date) instead of `created_at` for filenames, EXIF DateTimeOriginal, and manifests
- ✅ **Custom Filename & Mass Renamer** — Tools tab: build a `{StoryDate}_{ChildName}_{Room}_{OriginalName}` template, preview all renames, then apply with on-disk file rename + database update + story HTML rebuild
- ✅ **STORYPARK_API_REF.md updated** — added learning tags endpoint, moments endpoint, CDN URL patterns, HTTP 206 video streaming note, PDF page clarification, educator-set date field

---

## v3.4.0 — April 2026

- ✅ **Story numbers** — every story gets a sequential number (oldest = 1) assigned automatically after each scan; can be triggered manually from Tools tab
- ✅ **Centre-aware room tracking** — prevents a room name from an old daycare bleeding into stories from a new daycare when a child attends multiple centres
- ✅ **Fix Story Metadata** — Tools tab: bulk-correct centre name and/or room name for a date range of stories, then regenerate HTML + Story Cards
- ✅ **Delete log file** — Activity Log tab: delete the `Database/activity_log.jsonl` file from your linked folder
- ✅ **Export log for AI** — Activity Log tab: export the current activity log as JSON for AI analysis of issues
- ✅ **HAR capture tools** — `SSS-Junk-Backup/` analysis scripts to examine `.har` captures from browser sessions

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
