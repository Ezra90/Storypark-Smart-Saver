/**
 * generate-icons.js
 *
 * Generates Storypark-branded extension icons (16x16, 48x48, 128x128) as PNG
 * files in extension/icons/. Uses only Node.js built-ins — no external
 * dependencies required.
 *
 * Design: bright Storypark green (#00C853) rounded-square background with a
 * white "S" centred on it.
 *
 * Usage:
 *   node scripts/generate-icons.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const zlib = require("zlib");

/**
 * Build a minimal PNG file buffer for a solid-coloured icon with a simple
 * white "S" shape drawn as pixel art at the given size.
 *
 * @param {number} size  - Width/height in pixels.
 * @returns {Buffer}     - Complete PNG file as a Buffer.
 */
function buildIconPng(size) {
  // -------------------------------------------------------------------------
  // Palette
  // -------------------------------------------------------------------------
  const BG_R = 0x00, BG_G = 0xc8, BG_B = 0x53; // #00C853 Storypark green
  const FG_R = 0xff, FG_G = 0xff, FG_B = 0xff; // white
  const TR_R = 0x00, TR_G = 0x00, TR_B = 0x00, TR_A = 0x00; // transparent

  // -------------------------------------------------------------------------
  // Build pixel array  (RGBA, 4 bytes per pixel)
  // -------------------------------------------------------------------------
  const pixels = Buffer.alloc(size * size * 4);

  // Corner radius proportional to icon size
  const radius = Math.round(size * 0.20);

  // "S" letter bounding box — centred, roughly 50% wide, 65% tall
  const sW = Math.round(size * 0.50);
  const sH = Math.round(size * 0.65);
  const sX = Math.round((size - sW) / 2);
  const sY = Math.round((size - sH) / 2);
  const sw = Math.max(1, Math.round(size * 0.12)); // stroke width

  function inRoundedRect(px, py, rr) {
    if (px < 0 || py < 0 || px >= size || py >= size) return false;
    // Exclude pixels outside corner arcs
    if (px < rr && py < rr) return dist(px, py, rr - 1, rr - 1) <= rr - 0.5;
    if (px >= size - rr && py < rr) return dist(px, py, size - rr, rr - 1) <= rr - 0.5;
    if (px < rr && py >= size - rr) return dist(px, py, rr - 1, size - rr) <= rr - 0.5;
    if (px >= size - rr && py >= size - rr) return dist(px, py, size - rr, size - rr) <= rr - 0.5;
    return true;
  }

  function dist(ax, ay, bx, by) {
    return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
  }

  /**
   * Returns true if pixel (px, py) is part of the "S" glyph.
   * The "S" is drawn as three horizontal bars connected by two vertical
   * half-bars — a classic pixel-art "S".
   */
  function inSGlyph(px, py) {
    // Horizontal bars: top, middle, bottom
    const topBar    = py >= sY              && py < sY + sw;
    const midBar    = py >= sY + (sH - sw) / 2 && py < sY + (sH + sw) / 2;
    const botBar    = py >= sY + sH - sw    && py < sY + sH;

    const inSBox    = px >= sX && px < sX + sW && py >= sY && py < sY + sH;
    if (!inSBox) return false;

    if (topBar || midBar || botBar) return true;

    const halfH = Math.floor(sH / 2);
    // Top-left vertical (connects top-bar left to mid-bar left)
    const topLeftV = px >= sX && px < sX + sw
      && py > sY + sw - 1 && py < sY + halfH + sw / 2;
    // Bottom-right vertical (connects mid-bar right to bot-bar right)
    const botRightV = px >= sX + sW - sw && px < sX + sW
      && py > sY + halfH - sw / 2 && py < sY + sH - sw + 1;

    return topLeftV || botRightV;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      if (!inRoundedRect(x, y, radius)) {
        // transparent
        pixels[idx]     = TR_R;
        pixels[idx + 1] = TR_G;
        pixels[idx + 2] = TR_B;
        pixels[idx + 3] = TR_A;
      } else if (inSGlyph(x, y)) {
        pixels[idx]     = FG_R;
        pixels[idx + 1] = FG_G;
        pixels[idx + 2] = FG_B;
        pixels[idx + 3] = 0xff;
      } else {
        pixels[idx]     = BG_R;
        pixels[idx + 1] = BG_G;
        pixels[idx + 2] = BG_B;
        pixels[idx + 3] = 0xff;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Encode as PNG (RGBA, 8-bit, deflate-compressed)
  // -------------------------------------------------------------------------

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  function uint32be(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  }

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, "ascii");
    const len = uint32be(data.length);
    const crcInput = Buffer.concat([typeBytes, data]);
    const crc = uint32be(crc32(crcInput));
    return Buffer.concat([len, typeBytes, data, crc]);
  }

  const ihdrData = Buffer.concat([
    uint32be(size),  // width
    uint32be(size),  // height
    Buffer.from([8, 6, 0, 0, 0]),  // bit depth=8, colour type=6 (RGBA), compression, filter, interlace
  ]);

  // Build raw scanlines (filter byte 0 = None prepended to each row)
  const rowSize = size * 4;
  const raw = Buffer.alloc(size * (rowSize + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (rowSize + 1)] = 0; // filter type None
    pixels.copy(raw, y * (rowSize + 1) + 1, y * rowSize, (y + 1) * rowSize);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const idatData = compressed;

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdrData),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// CRC-32 (needed for PNG chunks)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SIZES = [16, 48, 128];
const outDir = path.join(__dirname, "..", "extension", "icons");

fs.mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const outPath = path.join(outDir, `icon${size}.png`);
  const png = buildIconPng(size);
  fs.writeFileSync(outPath, png);
  console.log(`✅  Wrote ${outPath}  (${png.length} bytes)`);
}

console.log("\nDone! Icons written to extension/icons/");
