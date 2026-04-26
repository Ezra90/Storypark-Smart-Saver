/**
 * lib/disk-sync.js – File System Access API helpers for folder linking and
 * reconciliation with on-disk downloads.
 *
 * Allows the user to link a local download folder so Storypark Smart Saver
 * can verify which files are actually on disk, avoid re-downloading existing
 * files, and generate reports of missing or orphaned media.
 *
 * All functions use the File System Access API (Chrome 86+) and MUST be
 * called from a page context (dashboard.html) — NOT the service worker.
 *
 * Functions:
 *   linkFolder()                            – prompt user to pick a folder
 *   getLinkedFolder()                       – retrieve + verify the stored handle
 *   verifyPermission(dirHandle, options?)   – check permission (optionally request)
 *   walkFolder(dirHandle, prefix)           – recursively list all files
 *   fileExists(dirHandle, relativePath)     – check if a specific file exists
 *   reconcileWithCache(dirHandle, stories)  – compare manifests vs disk
 *   syncDiskToDatabase(dirHandle)           – COUNT-BASED VERIFICATION (Rule 13)
 *
 * File operation helpers (for Clean Up Folder feature):
 *   readFileAsDataUrl(dirHandle, relativePath)           – read image as data URL
 *   moveFileToRejected(dirHandle, relativePath)          – move to _rejected/ subfolder
 *   restoreFromRejected(dirHandle, originalRelativePath) – undo a move
 *   deleteFile(dirHandle, relativePath)                  – permanently delete a file
 */

import {
  saveLinkedFolderHandle,
  getLinkedFolderHandle,
  clearLinkedFolderHandle,
  migrateLargeStoresToFiles,
  addDownloadedStory,
} from "./db.js";

/* ================================================================== */
/*  Folder linking                                                     */
/* ================================================================== */

/**
 * Prompt the user to select a local download folder and persist the
 * FileSystemDirectoryHandle in IndexedDB for future verification.
 *
 * @param {Object}  [options]
 * @param {string}  [options.startIn="downloads"]  Starting directory hint
 * @returns {Promise<{handle: FileSystemDirectoryHandle, name: string}>}
 * @throws {Error} if the user cancels or the API is unavailable
 */
export async function linkFolder(options = {}) {
  if (!("showDirectoryPicker" in window)) {
    throw new Error(
      "File System Access API not available in this browser. " +
      "Please use Chrome 86+ or another Chromium-based browser."
    );
  }
  const handle = await window.showDirectoryPicker({
    mode: "readwrite",
    startIn: options.startIn ?? "downloads",
  });
  await saveLinkedFolderHandle(handle);
  // Migrate any existing IDB data to Database/ files (non-blocking)
  migrateLargeStoresToFiles().catch(() => {});
  return { handle, name: handle.name };
}

/**
 * Retrieve the persisted directory handle from IndexedDB and verify that
 * the user has granted (or re-grants) read+write permission.
 *
 * Returns null if no handle has been stored or permission is denied.
 *
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function getLinkedFolder() {
  const handle = await getLinkedFolderHandle();
  if (!handle) return null;
  const ok = await verifyPermission(handle);
  if (!ok) return null;
  return handle;
}

/**
 * Remove the stored directory handle from IndexedDB.
 * After calling this, getLinkedFolder() will return null until the user
 * links a new folder via linkFolder().
 */
export async function clearLinkedFolder() {
  await clearLinkedFolderHandle();
}

/* ================================================================== */
/*  Permission                                                         */
/* ================================================================== */

/**
 * Check whether the user has granted read+write permission to a directory
 * handle. By default this is a silent check only; opt in to prompting when
 * the action is explicitly user-initiated.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {Object} [options]
 * @param {boolean} [options.request=false]  true to call requestPermission()
 * @returns {Promise<boolean>} true if permission is granted
 */
export async function verifyPermission(dirHandle, options = {}) {
  const { request = false } = options;
  const opts = { mode: "readwrite" };
  try {
    if ((await dirHandle.queryPermission(opts)) === "granted") return true;
    if (!request) return false;
    return (await dirHandle.requestPermission(opts)) === "granted";
  } catch {
    return false;
  }
}

/* ================================================================== */
/*  Folder traversal                                                   */
/* ================================================================== */

/**
 * Recursively list every file under a directory, returning relative paths
 * separated by "/" (e.g. "Alice/Stories/2024-01-15 — Story/photo.jpg").
 *
 * Skips hidden files and system folders (names starting with ".").
 *
 * @param {FileSystemDirectoryHandle} dirHandle  Root (or sub-) directory
 * @param {string}                    [prefix=""] Path prefix accumulated during recursion
 * @returns {Promise<string[]>}  All relative file paths under dirHandle
 */
export async function walkFolder(dirHandle, prefix = "", options = {}) {
  const { skipRejected = false } = options;
  const files = [];
  for await (const [name, entry] of dirHandle.entries()) {
    // Skip hidden/system entries (e.g. .DS_Store, Thumbs.db)
    if (name.startsWith(".")) continue;
    // Skip "Rejected Matches" folders when the offline scan option is set
    if (skipRejected && entry.kind === "directory" && name.endsWith(" Rejected Matches")) continue;
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === "file") {
      files.push(relPath);
    } else if (entry.kind === "directory") {
      try {
        const subFiles = await walkFolder(entry, relPath, options);
        files.push(...subFiles);
      } catch {
        // Skip unreadable subdirectories
      }
    }
  }
  return files;
}

/* ================================================================== */
/*  File existence check                                               */
/* ================================================================== */

/**
 * Check whether a file exists at the given relative path within a root
 * directory. Navigates sub-directories as needed.
 *
 * @param {FileSystemDirectoryHandle} dirHandle     Root directory handle
 * @param {string}                    relativePath  e.g. "Alice/Stories/…/photo.jpg"
 * @returns {Promise<boolean>}
 */
export async function fileExists(dirHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  let current = dirHandle;
  try {
    // Traverse all directory segments
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i]);
    }
    // Try to get the final file
    await current.getFileHandle(parts[parts.length - 1]);
    return true;
  } catch {
    return false;
  }
}

/* ================================================================== */
/*  COUNT-BASED DISK VERIFICATION (AI_RULES.md Rule 13)               */
/* ================================================================== */

/**
 * "Disk is Truth" sync strategy — recursively walk the local filesystem,
 * find folders containing metadata.json, extract storyId, count raw media
 * files (excluding generated artifacts), and update IndexedDB with
 * localMediaCount and status VERIFIED_ON_DISK.
 *
 * This eliminates the amnesia bug: if a story folder exists on disk with
 * the correct number of media files, the scan engine will skip re-downloading it.
 *
 * @param {FileSystemDirectoryHandle} dirHandle  Root linked folder
 * @param {Function} [onProgress]  Optional callback (processed, total, storyTitle)
 * @returns {Promise<{verified: number, errors: number, skipped: number}>}
 */
export async function syncDiskToDatabase(dirHandle, onProgress = null) {
  const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;
  const STORY_CARD_RE = /Story Card\.jpg$/i;
  
  let verified = 0, errors = 0, skipped = 0;

  /**
   * Recursively walk directories looking for metadata.json files.
   * When found, parse it, count media files, and update IDB.
   */
  async function walkAndVerify(handle, pathPrefix = "") {
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith(".")) continue;
      if (name === "Database") continue; // Skip Database folder
      if (name.endsWith(" Rejected Matches")) continue;

      const currentPath = pathPrefix ? `${pathPrefix}/${name}` : name;

      if (entry.kind === "directory") {
        // Check if this directory contains metadata.json
        try {
          const metadataFileHandle = await entry.getFileHandle("metadata.json");
          const metadataFile = await metadataFileHandle.getFile();
          const text = await metadataFile.text();
          const metadata = JSON.parse(text);
          
          const storyId = metadata.storyId;
          if (!storyId) {
            console.warn(`[disk-sync] metadata.json missing storyId in ${currentPath}`);
            errors++;
            continue;
          }

          // Count raw media files in this folder
          let mediaCount = 0;
          for await (const [fname, fentry] of entry.entries()) {
            if (fentry.kind === "file" && MEDIA_EXT.test(fname)) {
              // Exclude Story Card JPEGs and HTML files
              if (!STORY_CARD_RE.test(fname) && !/\.html$/i.test(fname)) {
                mediaCount++;
              }
            }
          }

          // Build minimal manifest for IDB update
          const manifest = {
            storyId: metadata.storyId,
            childId: metadata.childId || "",
            childName: metadata.childName || "",
            storyTitle: metadata.storyTitle || "",
            storyDate: metadata.storyDate || "",
            folderName: metadata.folderName || name,
            localMediaCount: mediaCount,
            status: "VERIFIED_ON_DISK",
            verifiedAt: new Date().toISOString(),
            // Preserve other fields if they exist in metadata.json
            approvedFilenames: metadata.approvedFilenames || [],
            thumbnailFilename: metadata.thumbnailFilename || "",
            excerpt: metadata.excerpt || "",
            storyBody: metadata.storyBody || "",
            storyRoutine: metadata.storyRoutine || "",
            educatorName: metadata.educatorName || "",
            roomName: metadata.roomName || "",
            centreName: metadata.centreName || "",
            childAge: metadata.childAge || "",
          };

          // Update IndexedDB
          await addDownloadedStory(manifest);
          verified++;

          if (onProgress) {
            onProgress(verified + errors + skipped, null, metadata.storyTitle || name);
          }

        } catch (err) {
          // No metadata.json in this folder - recursively check subdirectories
          if (err.name !== "NotFoundError") {
            console.warn(`[disk-sync] Error processing ${currentPath}:`, err.message);
            errors++;
          }
          // Recurse into subdirectories
          try {
            await walkAndVerify(entry, currentPath);
          } catch (e) {
            // Skip unreadable subdirectories
          }
        }
      }
    }
  }

  await walkAndVerify(dirHandle);

  return { verified, errors, skipped };
}

/* ================================================================== */
/*  Reconciliation                                                     */
/* ================================================================== */

/**
 * Compare the IDB download manifests against actual files on disk and
 * return a reconciliation report.
 *
 * ── Folder linking note ──
 * Chrome's folder picker does not allow selecting library roots like Downloads.
 * Users must link the "Storypark Smart Saver" folder itself. When that folder
 * is the dirHandle, paths from walkFolder() are already relative to it
 * (e.g. "Hugo Hill/Stories/2024-01-15 — Story/photo.jpg"). The path prefix
 * is auto-detected by comparing dirHandle.name to rootFolder so the report
 * works correctly regardless of which level the user linked.
 *
 * Report structure:
 *   present        – files referenced in manifests that EXIST on disk ✅
 *   missing        – files referenced in manifests that are NOT on disk ❌
 *   orphaned       – image/video files on disk NOT referenced by any manifest ⚠
 *   linkedFolderName – name of the linked folder (for display in the UI)
 *
 * @param {FileSystemDirectoryHandle} dirHandle          Linked folder handle
 * @param {Array<Object>}             downloadedStories  From getAllDownloadedStories()
 * @param {string}  [rootFolder="Storypark Smart Saver"] Root sub-folder name used during saving
 * @returns {Promise<{
 *   present:  string[],
 *   missing:  string[],
 *   orphaned: string[],
 *   totalExpected: number,
 *   totalOnDisk: number,
 *   linkedFolderName: string,
 * }>}
 */
export async function reconcileWithCache(
  dirHandle,
  downloadedStories,
  rootFolder = "Storypark Smart Saver"
) {
  if (!dirHandle || typeof dirHandle.name !== "string") {
    throw new Error("No linked folder provided for reconciliation.");
  }
  if (!Array.isArray(downloadedStories)) {
    throw new Error("Invalid manifest list for reconciliation.");
  }

  // ── 1. Detect link depth ──
  // If the user linked "Storypark Smart Saver" directly (the recommended way),
  // walkFolder paths start at the child level (e.g. "Hugo Hill/Stories/...").
  // If they linked a parent folder (e.g. Downloads), the root folder name is
  // included in the walkFolder paths, so we prepend it to expected paths too.
  const linkedFolderIsRoot = dirHandle.name === rootFolder;
  const prefix = linkedFolderIsRoot ? "" : (rootFolder + "/");

  const INVALID_CHARS = /[/\\:*?"<>|]/g;
  const sanitize = (s) => (s || "Unknown").replace(INVALID_CHARS, "_").trim() || "Unknown";

  // ── 2. Build the expected file set from IDB manifests ──
  const expectedFiles = new Set();
  for (const story of downloadedStories || []) {
    const childSafe = sanitize(story.childName);
    const storyPath = `${prefix}${childSafe}/Stories/${story.folderName}`;
    for (const filename of story.approvedFilenames || []) {
      expectedFiles.add(`${storyPath}/${filename}`);
    }
    // story.html and story-card.jpg are also expected if the folder exists
    if (story.folderName) {
      expectedFiles.add(`${storyPath}/story.html`);
    }
  }
  // Add per-child index pages
  const childNames = new Set((downloadedStories || []).map(s => s.childName).filter(Boolean));
  for (const childName of childNames) {
    expectedFiles.add(`${prefix}${sanitize(childName)}/Stories/index.html`);
  }
  if (childNames.size > 0) {
    // Root index.html only expected if we linked a parent folder
    if (!linkedFolderIsRoot) expectedFiles.add(`${rootFolder}/index.html`);
    else expectedFiles.add(`index.html`);
  }

  // ── 3. Walk the actual folder on disk ──
  let actualFiles;
  try {
    const allFiles = await walkFolder(dirHandle);
    actualFiles = new Set(allFiles);
  } catch (err) {
    console.warn("[disk-sync] walkFolder failed:", err.message);
    actualFiles = new Set();
  }

  // ── 4. Compute present, missing, orphaned ──
  const present = [];
  const missing = [];

  for (const expected of expectedFiles) {
    if (actualFiles.has(expected)) {
      present.push(expected);
    } else {
      missing.push(expected);
    }
  }

  // Orphaned: media files on disk not referenced by any manifest.
  // Exclude files inside "Rejected Matches" folders — they are intentionally there.
  const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv)$/i;
  const orphaned = [];
  for (const actual of actualFiles) {
    if (!expectedFiles.has(actual) && MEDIA_EXT.test(actual)) {
      if (!actual.includes(" Rejected Matches/")) {
        orphaned.push(actual);
      }
    }
  }

  return {
    present,
    missing,
    orphaned,
    totalExpected:    expectedFiles.size,
    totalOnDisk:      actualFiles.size,
    linkedFolderName: dirHandle.name,
    linkedFolderIsRoot,
  };
}

/* ================================================================== */
/*  Manifest recovery — repair IDB from actual disk contents           */
/* ================================================================== */

/**
 * Scan the linked folder for a child and reconcile what's actually on disk
 * back into the IDB downloadedStories manifest. Useful after a backup restore
 * where IDB was wiped but files are still on disk.
 *
 * For each on-disk file, the function:
 *   1. Parses the child name and story folder name from the path.
 *   2. Looks up the story in the existing manifest (by folderName).
 *   3. If the story exists, ensures the filename is in approvedFilenames.
 *   4. If the story does NOT exist, creates a minimal manifest entry so
 *      the reconciliation report can track it.
 *
 * Returns a summary of what was repaired.
 *
 * If the child was renamed in Storypark, the folder on disk may still use
 * the old sanitised name. This function automatically tries all known old
 * names from existing manifests as fallback paths so the repair succeeds
 * even when the child's display name has changed.
 *
 * @param {FileSystemDirectoryHandle} dirHandle        Linked "Storypark Smart Saver" folder
 * @param {Array<Object>}             existingManifests From getAllDownloadedStories()
 * @param {string} childName    Child's current display name
 * @param {string} childId      Child's IDB ID (used as key prefix)
 * @returns {Promise<{repaired: number, newStories: number, alreadyTracked: number, errors: number}>}
 */
export async function repairManifestFromDisk(dirHandle, existingManifests, childName, childId) {
  const INVALID_CHARS = /[/\\:*?"<>|]/g;
  const sanitize = (s) => (s || "Unknown").replace(INVALID_CHARS, "_").trim() || "Unknown";
  const childSafe = sanitize(childName);
  const MEDIA_EXT = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm|m4v|3gp|mkv|html)$/i;

  let repaired = 0, newStories = 0, alreadyTracked = 0, errors = 0;

  // Build a quick lookup: folderName → manifest entry
  const manifestByFolder = new Map(
    (existingManifests || [])
      .filter(m => m.childId === childId)
      .map(m => [m.folderName, { ...m }])
  );

  // Walk child's Stories subfolder on disk.
  // Try the current sanitised name first, then fall back to any old names
  // stored in existing manifests (handles child renames in Storypark).
  const candidateNames = [childSafe];
  const oldNames = [...new Set(
    (existingManifests || [])
      .filter(m => m.childId === childId)
      .map(m => sanitize(m.childName || ""))
      .filter(n => n && n !== childSafe),
  )];
  candidateNames.push(...oldNames);

  let storiesHandle = null;
  for (const candidate of candidateNames) {
    try {
      const h = await dirHandle.getDirectoryHandle(candidate);
      storiesHandle = await h.getDirectoryHandle("Stories");
      break; // found it
    } catch { /* try next candidate */ }
  }

  if (!storiesHandle) {
    // Child folder not found on disk — nothing to repair
    return { repaired, newStories, alreadyTracked, errors };
  }

  // Collect all story subfolders
  const storyFolders = [];
  for await (const [name, entry] of storiesHandle.entries()) {
    if (name.startsWith(".")) continue;
    if (entry.kind === "directory") storyFolders.push({ name, handle: entry });
  }

  for (const { name: folderName, handle: storyHandle } of storyFolders) {
    try {
      // Collect all media files in this story folder
      const filesInFolder = [];
      for await (const [fname, fentry] of storyHandle.entries()) {
        if (fentry.kind === "file" && MEDIA_EXT.test(fname) && !fname.startsWith(".")) {
          filesInFolder.push(fname);
        }
      }
      if (filesInFolder.length === 0) continue;

      // Exclude Story Card JPEGs (generated assets, not downloaded media).
      // Pattern: "{date} - Story Card.jpg" — these should never be in approvedFilenames.
      const mediaFiles = filesInFolder.filter(f => !/\.html$/.test(f) && !/Story Card\.jpg$/i.test(f));
      const existing = manifestByFolder.get(folderName);

      if (existing) {
        // Story is known — check if any on-disk files are missing from approvedFilenames
        const approved = new Set(existing.approvedFilenames || []);
        let addedAny = false;
        for (const fname of mediaFiles) {
          if (!approved.has(fname)) {
            approved.add(fname);
            repaired++;
            addedAny = true;
          } else {
            alreadyTracked++;
          }
        }
        if (addedAny) {
          existing.approvedFilenames = [...approved];
          existing.thumbnailFilename = existing.thumbnailFilename || mediaFiles[0] || "";
          // Update childName to the current name so future ops use the correct name
          existing.childName = childName;
          manifestByFolder.set(folderName, existing);
        }
      } else {
        // Story not in manifest — create a minimal recovery entry
        const storyDate = folderName.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || "";
        const storyTitle = folderName.replace(/^\d{4}-\d{2}-\d{2}\s*[—\-]\s*/, "").trim() || folderName;
        const recoveryManifest = {
          childId,
          childName,
          storyId:            `recovered_${childId}_${folderName}`,
          storyTitle,
          storyDate,
          folderName,
          approvedFilenames:  mediaFiles,
          thumbnailFilename:  mediaFiles[0] || "",
          excerpt:            "",
          storyBody:          "",
          storyRoutine:       "",
          educatorName:       "",
          roomName:           "",
          centreName:         "",
          childAge:           "",
        };
        manifestByFolder.set(folderName, recoveryManifest);
        newStories++;
        repaired += mediaFiles.length;
      }
    } catch (err) {
      console.warn("[disk-sync] repairManifestFromDisk error in folder", folderName, err.message);
      errors++;
    }
  }

  // Persist all updated/new manifests back to IDB
  // Import addDownloadedStory dynamically to avoid circular deps in this file.
  // Caller is responsible for importing and calling addDownloadedStory for each
  // updated manifest — we return the updated map for them to act on.
  // (Dashboard.js will call addDownloadedStory for each entry in the return value.)
  return {
    repaired,
    newStories,
    alreadyTracked,
    errors,
    updatedManifests: [...manifestByFolder.values()],
  };
}

/* ================================================================== */
/*  File operation helpers (Clean Up Folder)                           */
/* ================================================================== */

/**
 * Navigate to a file handle at the given relative path within a root
 * directory.  Returns [parentDirHandle, filename] so the caller can
 * perform operations on the file.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} relativePath  e.g. "Alice/Stories/2024-01-15 — Story/photo.jpg"
 * @returns {Promise<[FileSystemDirectoryHandle, string]>}
 */
/**
 * Derive the "{Child Name} Rejected Matches" path from an original file path.
 *
 * Original: Storypark Smart Saver/Hugo Hill/Stories/2024-01-15 — Story/photo.jpg
 * Rejected: Storypark Smart Saver/Hugo Hill Rejected Matches/Stories/2024-01-15 — Story/photo.jpg
 *
 * The rejected folder sits BESIDE the child folder so parents can drag just
 * the child's folder into Google Photos without rejected photos contaminating the upload.
 */
function _buildRejectedPath(originalRelativePath) {
  const parts = originalRelativePath.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const rejectedParts = [...parts];
    rejectedParts[1] = `${parts[1]} Rejected Matches`;
    return rejectedParts.join("/");
  }
  return `Rejected Matches/${originalRelativePath}`;
}

async function _navigateToParent(dirHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Empty path");
  let current = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i]);
  }
  return [current, parts[parts.length - 1]];
}

/**
 * Read an image file from disk and return it as a base64 data URL.
 * Used by the Clean Up Folder feature to send images to the face detector.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string}                    relativePath
 * @returns {Promise<string>}  e.g. "data:image/jpeg;base64,..."
 */
export async function readFileAsDataUrl(dirHandle, relativePath) {
  const [parentDir, filename] = await _navigateToParent(dirHandle, relativePath);
  const fileHandle = await parentDir.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Move a file into a `_rejected/` sub-folder at the root of the linked
 * directory, preserving its relative path so the location is traceable
 * and an undo is possible.
 *
 * Source:  Alice/Stories/2024-01-15 — Story/photo.jpg
 * Dest:    _rejected/Alice/Stories/2024-01-15 — Story/photo.jpg
 *
 * @param {FileSystemDirectoryHandle} dirHandle      Root linked folder
 * @param {string}                    relativePath   Source path (relative to root)
 * @returns {Promise<string>}  Destination path (relative to root)
 */
export async function moveFileToRejected(dirHandle, relativePath) {
  // ── 1. Read source file content ──
  const [sourceParent, filename] = await _navigateToParent(dirHandle, relativePath);
  const sourceHandle = await sourceParent.getFileHandle(filename);
  const file         = await sourceHandle.getFile();
  const buffer       = await file.arrayBuffer();
  const mimeType     = file.type || "application/octet-stream";

  // ── 2. Create destination directory tree: {Child Name} Rejected Matches/ ──
  // e.g. "Storypark Smart Saver/Hugo Hill Rejected Matches/Stories/2024-01-15 — Story/"
  const destPath  = _buildRejectedPath(relativePath);
  const destParts = destPath.split("/").filter(Boolean);
  let destDir = dirHandle;
  for (let i = 0; i < destParts.length - 1; i++) {
    destDir = await destDir.getDirectoryHandle(destParts[i], { create: true });
  }
  const destFilename = destParts[destParts.length - 1];

  // ── 3. Write to destination ──
  const destHandle  = await destDir.getFileHandle(destFilename, { create: true });
  const writable    = await destHandle.createWritable();
  await writable.write(new Blob([buffer], { type: mimeType }));
  await writable.close();

  // ── 4. Delete source ──
  await sourceParent.removeEntry(filename);

  return destPath;
}

/**
 * Restore a file that was previously moved to `_rejected/` back to its
 * original location.  Used by the undo button in the Clean Up Folder feature.
 *
 * @param {FileSystemDirectoryHandle} dirHandle            Root linked folder
 * @param {string}                    originalRelativePath  Original path before move
 * @returns {Promise<void>}
 */
export async function restoreFromRejected(dirHandle, originalRelativePath) {
  // Derive the rejected path using the same naming rule as moveFileToRejected
  const rejectedPath = _buildRejectedPath(originalRelativePath);

  // ── 1. Read the file from _rejected/ ──
  const [rejectedParent, filename] = await _navigateToParent(dirHandle, rejectedPath);
  const rejectedHandle = await rejectedParent.getFileHandle(filename);
  const file           = await rejectedHandle.getFile();
  const buffer         = await file.arrayBuffer();
  const mimeType       = file.type || "application/octet-stream";

  // ── 2. Re-create destination directory tree ──
  const origParts = originalRelativePath.split("/").filter(Boolean);
  let destDir = dirHandle;
  for (let i = 0; i < origParts.length - 1; i++) {
    destDir = await destDir.getDirectoryHandle(origParts[i], { create: true });
  }
  const destFilename = origParts[origParts.length - 1];

  // ── 3. Write back to original location ──
  const destHandle = await destDir.getFileHandle(destFilename, { create: true });
  const writable   = await destHandle.createWritable();
  await writable.write(new Blob([buffer], { type: mimeType }));
  await writable.close();

  // ── 4. Delete from _rejected/ ──
  await rejectedParent.removeEntry(filename);
}

/**
 * Permanently delete a file.
 * USE WITH CAUTION — this cannot be undone.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string}                    relativePath
 * @returns {Promise<void>}
 */
export async function deleteFile(dirHandle, relativePath) {
  const [parentDir, filename] = await _navigateToParent(dirHandle, relativePath);
  await parentDir.removeEntry(filename);
}
