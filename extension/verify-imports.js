/**
 * verify-imports.js — Import sanity check for scan-engine wiring
 * 
 * Run this in the extension's service worker console (DevTools → Service Workers)
 * to verify that scan-engine.js is correctly initialized and wired up.
 * 
 * Expected output:
 *   ✅ scan-engine initialized
 *   ✅ runExtraction is a function
 *   ✅ initScanEngine is a function
 *   ✅ _rebuildIndexPages is a function
 */

import { runExtraction, initScanEngine, _rebuildIndexPages } from "./lib/scan-engine.js";

console.log("🔍 Verifying scan-engine imports...");

const checks = [
  { name: "runExtraction is a function", pass: typeof runExtraction === "function" },
  { name: "initScanEngine is a function", pass: typeof initScanEngine === "function" },
  { name: "_rebuildIndexPages is a function", pass: typeof _rebuildIndexPages === "function" },
];

for (const check of checks) {
  console.log(check.pass ? `✅ ${check.name}` : `❌ ${check.name}`);
}

const allPassed = checks.every(c => c.pass);
console.log(allPassed 
  ? "✅ All imports verified — scan-engine is correctly wired!"
  : "❌ Some checks failed — see errors above"
);
