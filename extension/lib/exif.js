/**
 * exif.js – Minimal EXIF writer for JPEG blobs.
 *
 * Stamps DateTimeOriginal, DateTimeDigitized, DateTime, and GPS coordinates
 * directly into a JPEG ArrayBuffer. Uses the piexifjs-style approach of
 * building EXIF bytes and inserting them after the SOI marker.
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
 * Apply date and GPS EXIF metadata to a JPEG blob.
 *
 * @param {Blob}    blob      – Source JPEG image blob.
 * @param {Date|null} date    – Post date to stamp (skipped when null).
 * @param {number|null} lat   – Daycare latitude  (decimal degrees, skipped when null).
 * @param {number|null} lon   – Daycare longitude (decimal degrees, skipped when null).
 * @returns {Promise<Blob>}   – New JPEG blob with EXIF metadata embedded.
 */
export async function applyExif(blob, date, lat, lon) {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);

  // Validate JPEG SOI marker (0xFFD8)
  if (view.getUint16(0) !== 0xffd8) {
    console.warn("[exif] Not a JPEG – returning original blob.");
    return blob;
  }

  const exifBytes = buildExifSegment(date, lat, lon);
  const merged = mergeExif(new Uint8Array(buf), exifBytes);
  return new Blob([merged], { type: "image/jpeg" });
}

/* ------------------------------------------------------------------ */
/*  EXIF segment builder                                               */
/* ------------------------------------------------------------------ */

// Tag constants
const BYTE_ORDER_LE = 0x4949; // "II" – Intel / little-endian
const TIFF_MAGIC = 0x002a;

// IFD0 tags
const TAG_DATE_TIME = 0x0132;
// Exif Sub-IFD tags
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;
// GPS IFD tags
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_LONGITUDE = 0x0004;

// TIFF field types
const TYPE_ASCII = 2;
const TYPE_RATIONAL = 5;

/**
 * Build a complete APP1 (Exif) segment as a Uint8Array.
 */
function buildExifSegment(date, lat, lon) {
  const pieces = []; // collect bytes then concatenate once
  const addU16 = (v) => pieces.push(u16(v));
  const addU32 = (v) => pieces.push(u32(v));
  const addBytes = (b) => pieces.push(b);

  /* ---- Header ---- */
  // "Exif\0\0"
  addBytes(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]));

  // TIFF header (offset 0 relative to TIFF start)
  const tiffStart = totalLen(pieces);
  addU16(BYTE_ORDER_LE);
  addU16(TIFF_MAGIC);
  addU32(8); // offset to IFD0 (immediately after TIFF header)

  /* ---- IFD0 ---- */
  const ifd0Entries = [];
  const ifd0DataBlobs = [];
  let ifd0DataOffset; // set after we know entry count

  const dateStr = date ? formatExifDate(date) : null;

  // We always write 3 entries in IFD0: DateTime, ExifIFDPointer, GPSIFDPointer
  const ifd0Count = (dateStr ? 1 : 0) + 1 /* exif ptr */ + (lat != null && lon != null ? 1 : 0);
  addU16(ifd0Count);

  // Current offset counter (relative to TIFF start = piece[tiffStart])
  // IFD0 starts at offset 8. Each entry = 12 bytes. After entries: 4-byte next-IFD pointer.
  ifd0DataOffset = 8 + 2 + ifd0Count * 12 + 4;

  // -- DateTime tag (ASCII 20 bytes including NUL) --
  if (dateStr) {
    const encoded = encodeASCII(dateStr); // 20 bytes
    addBytes(ifdEntry(TAG_DATE_TIME, TYPE_ASCII, 20, ifd0DataOffset));
    ifd0DataBlobs.push(encoded);
    ifd0DataOffset += encoded.length;
  }

  // Placeholder offsets — we'll backpatch Exif and GPS IFD pointers.
  const exifPtrPatchIdx = pieces.length;
  addBytes(ifdEntry(TAG_EXIF_IFD_POINTER, 4 /* LONG */, 1, 0)); // patched later

  let gpsPtrPatchIdx = -1;
  if (lat != null && lon != null) {
    gpsPtrPatchIdx = pieces.length;
    addBytes(ifdEntry(TAG_GPS_IFD_POINTER, 4 /* LONG */, 1, 0)); // patched later
  }

  addU32(0); // next IFD pointer = 0 (no IFD1)

  // -- IFD0 extra data --
  for (const b of ifd0DataBlobs) addBytes(b);

  /* ---- Exif Sub-IFD ---- */
  const exifIFDOffset = totalLen(pieces) - tiffStart;
  patchU32(pieces[exifPtrPatchIdx], 8, exifIFDOffset); // backpatch

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

  /* ---- GPS IFD ---- */
  if (lat != null && lon != null) {
    const gpsIFDOffset = totalLen(pieces) - tiffStart;
    patchU32(pieces[gpsPtrPatchIdx], 8, gpsIFDOffset); // backpatch

    const gpsCount = 4; // LatRef, Lat, LonRef, Lon
    addU16(gpsCount);

    let gpsDataOffset = gpsIFDOffset + 2 + gpsCount * 12 + 4;
    const gpsDataBlobs = [];

    // GPSLatitudeRef (ASCII 2 bytes – fits inline)
    const latRef = lat >= 0 ? "N" : "S";
    addBytes(ifdEntryInlineASCII(TAG_GPS_LATITUDE_REF, latRef));

    // GPSLatitude (3 RATIONALs = 24 bytes)
    const latDMS = toDMS(Math.abs(lat));
    addBytes(ifdEntry(TAG_GPS_LATITUDE, TYPE_RATIONAL, 3, gpsDataOffset));
    const latBytes = encodeDMS(latDMS);
    gpsDataBlobs.push(latBytes);
    gpsDataOffset += latBytes.length;

    // GPSLongitudeRef
    const lonRef = lon >= 0 ? "E" : "W";
    addBytes(ifdEntryInlineASCII(TAG_GPS_LONGITUDE_REF, lonRef));

    // GPSLongitude
    const lonDMS = toDMS(Math.abs(lon));
    addBytes(ifdEntry(TAG_GPS_LONGITUDE, TYPE_RATIONAL, 3, gpsDataOffset));
    const lonBytes = encodeDMS(lonDMS);
    gpsDataBlobs.push(lonBytes);
    gpsDataOffset += lonBytes.length;

    addU32(0); // next IFD = 0
    for (const b of gpsDataBlobs) addBytes(b);
  }

  // Concatenate all pieces
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

function ifdEntryInlineASCII(tag, char) {
  // ASCII with count=2 (char + NUL) fits in the 4-byte value field
  const a = new Uint8Array(12);
  a[0] = tag & 0xff;
  a[1] = (tag >> 8) & 0xff;
  a[2] = TYPE_ASCII & 0xff;
  a[3] = (TYPE_ASCII >> 8) & 0xff;
  a[4] = 2; // count
  a[8] = char.charCodeAt(0);
  a[9] = 0; // NUL
  return a;
}

function patchU32(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
  arr[offset + 3] = (value >> 24) & 0xff;
}

function encodeASCII(str) {
  const a = new Uint8Array(str.length + 1); // +1 for NUL
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

/**
 * Convert decimal degrees to [degrees, minutes, seconds].
 */
function toDMS(decimal) {
  const d = Math.floor(decimal);
  const mFloat = (decimal - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return [d, m, s];
}

/**
 * Encode [d, m, s] as 3 TIFF RATIONAL values (6 × uint32 LE = 24 bytes).
 * Each RATIONAL = numerator/denominator (both uint32).
 */
function encodeDMS([d, m, s]) {
  const a = new Uint8Array(24);
  const view = new DataView(a.buffer);
  view.setUint32(0, d, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, m, true);
  view.setUint32(12, 1, true);
  // Seconds × 10000 for 4-decimal-place precision
  view.setUint32(16, Math.round(s * 10000), true);
  view.setUint32(20, 10000, true);
  return a;
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
