/**
 * exif.js – Minimal EXIF writer for JPEG blobs.
 *
 * Stamps DateTimeOriginal, DateTimeDigitized, DateTime, and an optional
 * ImageDescription text string directly into a JPEG ArrayBuffer. Uses the
 * piexifjs-style approach of building EXIF bytes and inserting them after
 * the SOI marker.
 *
 * This module is intentionally dependency-free so it can run in the
 * extension's service worker or an offscreen document without bundling.
 *
 * References:
 *   - EXIF 2.32 spec (CIPA DC-008-2019)
 *   - TIFF Rev 6.0 (Adobe, 1992)
 */

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Apply date and description EXIF metadata to a JPEG blob.
 *
 * @param {Blob}        blob        – Source JPEG image blob.
 * @param {Date|null}   date        – Post date to stamp (skipped when null).
 * @param {string|null} description – Free-text description for ImageDescription tag.
 * @returns {Promise<Blob>}         – New JPEG blob with EXIF metadata embedded.
 */
export async function applyExif(blob, date, description) {
  const buf  = await blob.arrayBuffer();
  const view = new DataView(buf);

  // Validate JPEG SOI marker (0xFFD8)
  if (view.getUint16(0) !== 0xffd8) {
    console.warn("[exif] Not a JPEG – returning original blob.");
    return blob;
  }

  const exifBytes = buildExifSegment(date, description);
  const merged    = mergeExif(new Uint8Array(buf), exifBytes);
  return new Blob([merged], { type: "image/jpeg" });
}

/* ------------------------------------------------------------------ */
/*  EXIF segment builder                                               */
/* ------------------------------------------------------------------ */

// Tag constants
const BYTE_ORDER_LE = 0x4949; // "II" – Intel / little-endian
const TIFF_MAGIC    = 0x002a;

// IFD0 tags (must appear in ascending numeric order within each IFD)
const TAG_IMAGE_DESCRIPTION  = 0x010e;
const TAG_DATE_TIME          = 0x0132;
// Exif Sub-IFD tags
const TAG_EXIF_IFD_POINTER   = 0x8769;
const TAG_DATE_TIME_ORIGINAL  = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;

// TIFF field types
const TYPE_ASCII = 2;

/** Maximum byte length for the EXIF ImageDescription field (before NUL terminator). */
const MAX_EXIF_DESCRIPTION_LENGTH = 1000;

/**
 * Build a complete APP1 (Exif) segment as a Uint8Array.
 *
 * IFD0 entries (ascending tag order):
 *   0x010E  ImageDescription  [optional]
 *   0x0132  DateTime          [optional]
 *   0x8769  ExifIFDPointer    [always]
 *
 * Exif Sub-IFD entries [optional, only written when date is provided]:
 *   0x9003  DateTimeOriginal
 *   0x9004  DateTimeDigitized
 */
function buildExifSegment(date, description) {
  const pieces  = [];
  const addU16  = (v) => pieces.push(u16(v));
  const addU32  = (v) => pieces.push(u32(v));
  const addBytes = (b) => pieces.push(b);

  /* ---- "Exif\0\0" marker ---- */
  addBytes(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]));

  /* ---- TIFF header ---- */
  const tiffStart = totalLen(pieces);
  addU16(BYTE_ORDER_LE);
  addU16(TIFF_MAGIC);
  addU32(8); // IFD0 starts immediately after the 8-byte TIFF header

  /* ---- IFD0 ---- */
  const dateStr = date ? formatExifDate(date) : null;
  // Filter description to ASCII-compatible characters (tab / LF / CR / printable ASCII)
  const descStr = description
    ? description.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "?").slice(0, MAX_EXIF_DESCRIPTION_LENGTH)
    : null;

  // ifd0Count: ImageDescription (optional) + DateTime (optional) + ExifIFDPointer (always)
  const ifd0Count = (descStr ? 1 : 0) + (dateStr ? 1 : 0) + 1;
  addU16(ifd0Count);

  // Data area starts after: TIFF header (8) + count (2) + entries (12 each) + next-IFD ptr (4)
  let ifd0DataOffset = 8 + 2 + ifd0Count * 12 + 4;
  const ifd0DataBlobs = [];

  // 0x010E ImageDescription (must precede 0x0132 DateTime)
  if (descStr) {
    const encoded = encodeASCII(descStr);          // length + 1 NUL byte
    addBytes(ifdEntry(TAG_IMAGE_DESCRIPTION, TYPE_ASCII, encoded.length, ifd0DataOffset));
    ifd0DataBlobs.push(encoded);
    ifd0DataOffset += encoded.length;
  }

  // 0x0132 DateTime
  if (dateStr) {
    const encoded = encodeASCII(dateStr);          // exactly 20 bytes
    addBytes(ifdEntry(TAG_DATE_TIME, TYPE_ASCII, 20, ifd0DataOffset));
    ifd0DataBlobs.push(encoded);
    ifd0DataOffset += encoded.length;
  }

  // 0x8769 ExifIFDPointer – value patched once we know the Sub-IFD position
  const exifPtrPatchIdx = pieces.length;
  addBytes(ifdEntry(TAG_EXIF_IFD_POINTER, 4 /* LONG */, 1, 0));

  addU32(0); // next IFD pointer = 0 (no IFD1)

  // IFD0 extra data blobs
  for (const b of ifd0DataBlobs) addBytes(b);

  /* ---- Exif Sub-IFD ---- */
  const exifIFDOffset = totalLen(pieces) - tiffStart;
  patchU32(pieces[exifPtrPatchIdx], 8, exifIFDOffset);

  const exifCount = dateStr ? 2 : 0;
  addU16(exifCount);

  let exifDataOffset = exifIFDOffset + 2 + exifCount * 12 + 4;
  const exifDataBlobs = [];

  if (dateStr) {
    const enc = encodeASCII(dateStr);
    addBytes(ifdEntry(TAG_DATE_TIME_ORIGINAL, TYPE_ASCII, 20, exifDataOffset));
    exifDataBlobs.push(enc);
    exifDataOffset += enc.length;

    const enc2 = encodeASCII(dateStr);
    addBytes(ifdEntry(TAG_DATE_TIME_DIGITIZED, TYPE_ASCII, 20, exifDataOffset));
    exifDataBlobs.push(enc2);
    exifDataOffset += enc2.length;
  }

  addU32(0); // next IFD = 0
  for (const b of exifDataBlobs) addBytes(b);

  return concatArrays(pieces);
}

/* ------------------------------------------------------------------ */
/*  Merge helper – insert APP1 into JPEG                               */
/* ------------------------------------------------------------------ */

function mergeExif(jpegBytes, exifPayload) {
  // Remove any existing APP1 (Exif) segment
  let cleaned = jpegBytes;
  let pos = 2; // right after SOI
  while (pos < cleaned.length - 1) {
    const marker = (cleaned[pos] << 8) | cleaned[pos + 1];
    if (marker === 0xffe1) {
      const segLen = (cleaned[pos + 2] << 8) | cleaned[pos + 3];
      // Remove this segment
      const before = cleaned.slice(0, pos);
      const after = cleaned.slice(pos + 2 + segLen);
      cleaned = concatTyped(before, after);
      continue; // check same position again
    }
    if ((marker & 0xff00) !== 0xff00) break; // not a marker
    const segLen = (cleaned[pos + 2] << 8) | cleaned[pos + 3];
    pos += 2 + segLen;
  }

  // Build APP1 marker + length prefix
  const app1Len = 2 + exifPayload.length; // length field includes itself
  const header = new Uint8Array(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header[2] = (app1Len >> 8) & 0xff;
  header[3] = app1Len & 0xff;

  const soi = cleaned.slice(0, 2);
  const rest = cleaned.slice(2);
  return concatTyped(soi, concatTyped(header, concatTyped(exifPayload, rest)));
}

/* ------------------------------------------------------------------ */
/*  Low-level helpers                                                  */
/* ------------------------------------------------------------------ */

function u16(v) {
  const a = new Uint8Array(2);
  a[0] = v & 0xff;
  a[1] = (v >> 8) & 0xff;
  return a;
}

function u32(v) {
  const a = new Uint8Array(4);
  a[0] = v & 0xff;
  a[1] = (v >> 8) & 0xff;
  a[2] = (v >> 16) & 0xff;
  a[3] = (v >> 24) & 0xff;
  return a;
}

function ifdEntry(tag, type, count, valueOrOffset) {
  const a = new Uint8Array(12);
  a[0] = tag & 0xff;
  a[1] = (tag >> 8) & 0xff;
  a[2] = type & 0xff;
  a[3] = (type >> 8) & 0xff;
  a[4] = count & 0xff;
  a[5] = (count >> 8) & 0xff;
  a[6] = (count >> 16) & 0xff;
  a[7] = (count >> 24) & 0xff;
  a[8] = valueOrOffset & 0xff;
  a[9] = (valueOrOffset >> 8) & 0xff;
  a[10] = (valueOrOffset >> 16) & 0xff;
  a[11] = (valueOrOffset >> 24) & 0xff;
  return a;
}

function patchU32(arr, offset, value) {
  arr[offset]     = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
  arr[offset + 3] = (value >> 24) & 0xff;
}

function encodeASCII(str) {
  const a = new Uint8Array(str.length + 1); // +1 for NUL terminator
  for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i);
  a[str.length] = 0;
  return a;
}

/**
 * Format a Date as "YYYY:MM:DD HH:MM:SS" (19 chars + NUL = 20 bytes).
 */
function formatExifDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function totalLen(arrays) {
  let n = 0;
  for (const a of arrays) n += a.length;
  return n;
}

function concatArrays(arrays) {
  const out = new Uint8Array(totalLen(arrays));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function concatTyped(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
