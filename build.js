/**
 * build.js – Copies @vladmandic/human library and model files into the
 * extension directory so end-users don't need to manually download them.
 *
 * Run with: npm run build
 */

const fs   = require("fs");
const path = require("path");

const ROOT       = __dirname;
const HUMAN_PKG  = path.join(ROOT, "node_modules/@vladmandic/human");
const EXT_LIB    = path.join(ROOT, "extension/lib");
const EXT_MODELS = path.join(ROOT, "extension/models");

/** Copy a file, creating the destination directory if needed. */
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  copied: ${path.relative(ROOT, dest)}`);
}

// ---------------------------------------------------------------------------
// 1. Copy human.js (browser UMD bundle)
// ---------------------------------------------------------------------------
console.log("\n[build] Copying human.js …");
copyFile(
  path.join(HUMAN_PKG, "dist/human.js"),
  path.join(EXT_LIB, "human.js")
);

// ---------------------------------------------------------------------------
// 2. Copy model weight files
//    Only the models needed for face detection + face description:
//      blazeface  – lightweight face detector
//      faceres    – 1024-D face embedding (descriptor)
// ---------------------------------------------------------------------------
console.log("\n[build] Copying model files …");
const MODELS_TO_COPY = [
  "blazeface.json",
  "blazeface.bin",
  "faceres.json",
  "faceres.bin",
];
for (const file of MODELS_TO_COPY) {
  copyFile(
    path.join(HUMAN_PKG, "models", file),
    path.join(EXT_MODELS, file)
  );
}

console.log("\n[build] Done. Extension is ready in extension/");
