/**
 * handlers-backup.js — Full backup export/import handlers
 *
 * ┌─ WHAT THIS FILE OWNS ──────────────────────────────────────────────┐
 * │  FULL_BACKUP_EXPORT and FULL_BACKUP_IMPORT message handlers.       │
 * │  Serialises / restores all IDB stores + chrome.storage.local.      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ WHAT THIS FILE DOES NOT OWN ──────────────────────────────────────┐
 * │  Individual profile exports → handlers-phase.js (export descriptor)│
 * │  Disk file I/O → dashboard.js (FSA access) / chrome.downloads      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * BACKUP FORMAT (version 3):
 *   {
 *     version: 3,
 *     type: "storypark_smart_saver_full_backup",
 *     exportDate: ISO string,
 *     children: Child[],
 *     profiles: { [childId]: ChildBackupProfile },
 *     settings: { autoThreshold, minThreshold, ... },
 *     activityLog: ActivityLogEntry[],
 *     imageFingerprints: ImageFingerprint[],
 *     cachedStories: StoryCacheEntry[],
 *     childProfiles: ChildProfile[],    // IDB v11
 *     centreProfiles: CentreProfile[],  // IDB v11
 *     educators: EducatorEntry[],       // IDB v11
 *     _meta: { childCount, totalDescriptors, ... }
 *   }
 *
 * Merge modes (msg.mergeMode):
 *   "merge"   — union of existing + imported (default)
 *   "replace" — import overwrites all existing data
 */

import {
  getAllDescriptors, getDescriptors, setDescriptors,
  getChildPhase, setChildPhase, getAllChildPhases,
  getNegativeDescriptors, appendNegativeDescriptor,
  getProcessedStories, markStoryProcessed,
  getAllScanCheckpoints, saveScanCheckpoint,
  getAllPendingDownloads, addPendingDownload,
  getAllDownloadedStories, addDownloadedStory,
  getAllRejections, addRejection,
  saveImageFingerprint, getAllImageFingerprints, countImageFingerprints,
  cacheStory, getAllCachedStories, countCachedStories,
  saveChildProfile, getAllChildProfiles,
  getAllCentreProfiles, importLegacyCentreLocations,
  getAllEducators, saveEducator,
  eagerLoadHotCaches,
} from "./db.js";
import { getSettings, saveCentre } from "./data-service.js";

/* ================================================================== */
/*  Export                                                             */
/* ================================================================== */

/**
 * FULL_BACKUP_EXPORT — Serialise all application data to a JSON object.
 * The returned backup object is sent to dashboard.js which offers it as
 * a .json.gz download (Gzip compressed via CompressionStream API).
 *
 * @param {Object} msg — (no required fields)
 * @param {import('./types.js').HandlerContext} ctx
 * @returns {Promise<{ ok: true, backup: Object } | { ok: false, error: string }>}
 */
export async function handleFullBackupExport(msg, ctx) {
  try {
    const { children = [] } = await chrome.storage.local.get("children");
    const allDescs       = await getAllDescriptors();
    const allPhases      = await getAllChildPhases();
    const allProcessed   = await getProcessedStories();
    const allCheckpoints = await getAllScanCheckpoints();
    const allPending     = await getAllPendingDownloads();
    const { activityLog = [] } = await chrome.storage.local.get("activityLog");

    // Build per-child profiles
    const profiles = {};
    for (const child of children) {
      const cid        = child.id;
      const desc       = allDescs.find(d => String(d.childId) === String(cid));
      const phase      = allPhases.find(p => String(p.childId) === String(cid));
      const negDescs   = await getNegativeDescriptors(cid).catch(() => []);
      const processed  = allProcessed.filter(s => String(s.childId) === String(cid));
      const checkpoint = allCheckpoints.find(c => String(c.childId) === String(cid)) || null;
      const pending    = allPending.filter(p => String(p.childId) === String(cid));
      const downloaded = await getAllDownloadedStories()
        .then(all => all.filter(m => String(m.childId) === String(cid)))
        .catch(() => []);

      // Gather rejection keys for this child's stories
      const allRejectionKeys = await getAllRejections().catch(() => []);
      const childStoryIds = new Set([
        ...processed.map(s => String(s.storyId || s)),
        ...downloaded.map(d => String(d.storyId)),
      ].filter(Boolean));
      const childRejections = allRejectionKeys.filter(k => {
        const uIdx = k.indexOf("_");
        return uIdx > 0 && childStoryIds.has(k.substring(0, uIdx));
      });

      profiles[cid] = {
        childName: child.name,
        descriptors:         desc?.descriptors || [],
        descriptorsByYear:   desc?.descriptorsByYear || {},
        negativeDescriptors: negDescs,
        rejectedImageKeys:   childRejections,
        phase:               phase || { phase: 1, verifiedCount: 0 },
        processedStoryIds:   processed,
        scanCheckpoint:      checkpoint,
        pendingDownloads:    pending.map(({ id: _id, ...rest }) => rest), // strip auto-increment id
        downloadedStories:   downloaded.map(({ key: _k, ...rest }) => rest),
      };
    }

    const settings = await getSettings();

    const backup = {
      version:  3,
      type:     "storypark_smart_saver_full_backup",
      exportDate: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      children,
      profiles,
      settings,
      activityLog: activityLog.slice(-50), // last 50 entries only
      imageFingerprints: await getAllImageFingerprints().catch(() => []),
      cachedStories:     await getAllCachedStories().catch(() => []),
      childProfiles:     await getAllChildProfiles().catch(() => []),
      centreProfiles:    await getAllCentreProfiles().catch(() => []),
      educators:         await getAllEducators().catch(() => []),
      _meta: {
        childCount:             children.length,
        totalDescriptors:       allDescs.reduce((s, d) => s + (d.descriptors?.length || 0), 0),
        totalNegativeDescriptors: Object.values(profiles).reduce((s, p) => s + p.negativeDescriptors.length, 0),
        totalProcessedStories:  allProcessed.length,
        totalPendingDownloads:  allPending.length,
        totalFingerprints:      await countImageFingerprints().catch(() => 0),
        totalCachedStories:     await countCachedStories().catch(() => 0),
      },
    };

    return { ok: true, backup };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ================================================================== */
/*  Import                                                             */
/* ================================================================== */

/**
 * FULL_BACKUP_IMPORT — Restore all application data from a backup object.
 *
 * @param {{ backup: Object, mergeMode?: "merge"|"replace" }} msg
 * @param {import('./types.js').HandlerContext} ctx
 * @returns {Promise<{ ok: true, imported: Object } | { ok: false, error: string }>}
 */
export async function handleFullBackupImport(msg, ctx) {
  const { backup, mergeMode = "merge" } = msg;
  if (!backup || backup.type !== "storypark_smart_saver_full_backup") {
    return { ok: false, error: "Invalid backup file. Expected a Storypark Smart Saver full backup." };
  }

  try {
    const imported = { children: 0, descriptors: 0, phases: 0, stories: 0, pending: 0 };

    // 1. Restore children list
    if (backup.children?.length > 0) {
      await chrome.storage.local.set({ children: backup.children });
      imported.children = backup.children.length;
    }

    // 2. Restore settings
    if (backup.settings && typeof backup.settings === "object") {
      await chrome.storage.local.set(backup.settings);
    }

    // 3. Restore per-child profiles
    if (backup.profiles) {
      for (const [childId, profile] of Object.entries(backup.profiles)) {
        // Descriptors
        if (profile.descriptors?.length > 0) {
          if (mergeMode === "merge") {
            const existing = await getDescriptors(childId).catch(() => null);
            const existingDescs = existing?.descriptors || [];
            const existingSet = new Set(existingDescs.map(d => JSON.stringify(d)));
            const newDescs = profile.descriptors.filter(d => !existingSet.has(JSON.stringify(d)));
            if (newDescs.length > 0) {
              await setDescriptors(childId, profile.childName || "", [...existingDescs, ...newDescs]);
            }
          } else {
            await setDescriptors(childId, profile.childName || "", profile.descriptors);
          }
          imported.descriptors += profile.descriptors.length;
        }

        // Negative descriptors
        if (profile.negativeDescriptors?.length > 0) {
          for (const desc of profile.negativeDescriptors) {
            await appendNegativeDescriptor(childId, desc).catch(() => {});
          }
        }

        // Phase data
        if (profile.phase) {
          if (mergeMode === "merge") {
            const existing = await getChildPhase(childId);
            if (profile.phase.phase > existing.phase ||
                (profile.phase.phase === existing.phase && profile.phase.verifiedCount > existing.verifiedCount)) {
              await setChildPhase(childId, profile.phase);
            }
          } else {
            await setChildPhase(childId, profile.phase);
          }
          imported.phases++;
        }

        // Processed stories (both legacy string[] and new object[] formats)
        if (profile.processedStoryIds?.length > 0) {
          for (const entry of profile.processedStoryIds) {
            if (typeof entry === "string") {
              await markStoryProcessed(entry, "", childId).catch(() => {});
            } else if (entry?.storyId) {
              await markStoryProcessed(entry.storyId, entry.date || "", entry.childId || childId).catch(() => {});
            }
          }
          imported.stories += profile.processedStoryIds.length;
        }

        // Scan checkpoint
        if (profile.scanCheckpoint) {
          await saveScanCheckpoint(profile.scanCheckpoint).catch(() => {});
        }

        // Pending downloads
        if (profile.pendingDownloads?.length > 0) {
          for (const item of profile.pendingDownloads) {
            await addPendingDownload(item).catch(() => {});
          }
          imported.pending += profile.pendingDownloads.length;
        }

        // Rejection keys
        if (profile.rejectedImageKeys?.length > 0) {
          for (const key of profile.rejectedImageKeys) {
            const uIdx = key.indexOf("_");
            if (uIdx > 0) {
              await addRejection(key.substring(0, uIdx), key.substring(uIdx + 1)).catch(() => {});
            }
          }
        }

        // Downloaded story manifests
        if (profile.downloadedStories?.length > 0) {
          for (const manifest of profile.downloadedStories) {
            await addDownloadedStory(manifest).catch(() => {});
          }
        }
      }
    }

    // 4. Caches
    if (backup.imageFingerprints?.length) {
      for (const fp of backup.imageFingerprints) {
        await saveImageFingerprint(fp).catch(() => {});
      }
    }
    if (backup.cachedStories?.length) {
      for (const sc of backup.cachedStories) {
        if (sc.storyId && sc.data) await cacheStory(sc.storyId, sc.data).catch(() => {});
      }
    }

    // 5. IDB v11 rich data stores
    if (backup.childProfiles?.length) {
      for (const p of backup.childProfiles) {
        await saveChildProfile(p).catch(() => {});
      }
    }
    if (backup.centreProfiles?.length) {
      for (const c of backup.centreProfiles) {
        // saveCentre is now statically imported at the top of this file
        await saveCentre(c.centreName, { lat: c.lat, lng: c.lng, address: c.address }).catch(() => {});
      }
    } else if (backup.settings?.centreLocations) {
      // v2 backup: migrate centreLocations to IDB
      await importLegacyCentreLocations(backup.settings.centreLocations).catch(() => {});
    }
    if (backup.educators?.length) {
      for (const edu of backup.educators) {
        await saveEducator(edu).catch(() => {});
      }
    }

    // 6. Refresh offscreen profiles
    ctx.sendToOffscreen({ type: "REFRESH_PROFILES" }).catch(() => {});

    // 7. Record import date
    await chrome.storage.local.set({ lastBackupImport: new Date().toISOString() });

    // 8. Warm up hot caches after bulk IDB writes
    await eagerLoadHotCaches().catch(() => {});

    return { ok: true, imported };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
