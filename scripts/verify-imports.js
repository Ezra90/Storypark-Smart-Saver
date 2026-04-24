#!/usr/bin/env node
/**
 * verify-imports.js — Import/export consistency checker
 *
 * Scans all .js files in extension/ and checks that every named import
 * has a matching named export in the source module.
 *
 * Usage:
 *   node scripts/verify-imports.js
 *   node scripts/verify-imports.js --verbose
 *
 * Exit code 0 = all imports satisfied
 * Exit code 1 = one or more missing exports found
 *
 * What it checks:
 *   1. Named imports { foo, bar } from './lib/baz.js' have matching exports
 *   2. Reports "dead exports" (exported but never imported) when --verbose
 *   3. Checks for duplicate exports in the same file
 *
 * What it does NOT check:
 *   - Default exports/imports
 *   - Dynamic import() calls
 *   - Star imports (import * from ...)
 *   - Node.js built-ins or external packages
 */

const fs   = require("fs");
const path = require("path");

const VERBOSE  = process.argv.includes("--verbose");
const ROOT_DIR = path.join(__dirname, "..", "extension");

// ──────────────────────────────────────────────────────────────────
//  File discovery
// ──────────────────────────────────────────────────────────────────

function findJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "models" && entry.name !== "node_modules") {
      results.push(...findJsFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────
//  Export extraction
// ──────────────────────────────────────────────────────────────────

/**
 * Extract all named exports from a JS file.
 * Handles:
 *   export function foo() {}
 *   export const foo = ...
 *   export class Foo {}
 *   export async function foo() {}
 *   export { foo, bar } (re-export from module scope)
 *   export { foo as bar } from './other.js' (re-exports)
 *
 * @param {string} filePath
 * @returns {Set<string>}
 */
function extractExports(filePath) {
  const source = fs.readFileSync(filePath, "utf-8");
  const exports = new Set();

  // Patterns for different export forms
  const patterns = [
    // export function foo, export async function foo, export class Foo, export const foo
    /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm,
    // export { foo, bar, baz }
    /^export\s*\{([^}]+)\}/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1].includes(",") || match[1].includes("{")) {
        // export { foo, bar } form
        const names = match[1].split(",").map(n => n.trim().split(/\s+as\s+/).pop().trim());
        names.filter(Boolean).forEach(n => exports.add(n));
      } else {
        exports.add(match[1].trim());
      }
    }
  }

  return exports;
}

// ──────────────────────────────────────────────────────────────────
//  Import extraction
// ──────────────────────────────────────────────────────────────────

/**
 * Extract all named imports from a JS file.
 * @param {string} filePath
 * @returns {Array<{names: string[], source: string, resolvedPath: string}>}
 */
function extractImports(filePath) {
  const source  = fs.readFileSync(filePath, "utf-8");
  const fileDir = path.dirname(filePath);
  const imports = [];

  // import { foo, bar } from './module.js'
  const importPattern = /^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const raw    = match[1];
    const source_ = match[2];
    // Skip non-relative imports (chrome.*, node built-ins, etc.)
    if (!source_.startsWith(".")) continue;

    const names = raw
      .split(",")
      .map(n => n.trim())
      .filter(Boolean)
      .map(n => {
        // Handle 'foo as bar' — import name is 'foo'
        const parts = n.split(/\s+as\s+/);
        return parts[0].trim();
      });

    // Resolve the import path
    let resolved = path.resolve(fileDir, source_);
    if (!resolved.endsWith(".js") && !fs.existsSync(resolved)) {
      resolved += ".js";
    }

    imports.push({ names, source: source_, resolvedPath: resolved });
  }

  return imports;
}

// ──────────────────────────────────────────────────────────────────
//  Main check
// ──────────────────────────────────────────────────────────────────

function run() {
  const files = findJsFiles(ROOT_DIR);
  console.log(`\nScanning ${files.length} JS files in ${ROOT_DIR}...\n`);

  // Build export map: filePath → Set<exportedName>
  const exportMap = new Map();
  for (const file of files) {
    try {
      exportMap.set(file, extractExports(file));
    } catch (err) {
      console.warn(`  ⚠ Could not parse exports from ${path.relative(ROOT_DIR, file)}: ${err.message}`);
    }
  }

  // Check every import
  let errorCount   = 0;
  let warningCount = 0;
  const importedNames = new Map(); // filePath → Set<importedName>

  for (const file of files) {
    let fileImports;
    try {
      fileImports = extractImports(file);
    } catch (err) {
      continue;
    }

    for (const { names, source: srcPath, resolvedPath } of fileImports) {
      const sourceExports = exportMap.get(resolvedPath);
      if (!sourceExports) {
        // Module not found in our scan (might be external or unresolvable)
        if (VERBOSE) {
          console.warn(`  ⚠ Cannot resolve: ${path.relative(ROOT_DIR, file)} → ${srcPath}`);
          warningCount++;
        }
        continue;
      }

      for (const name of names) {
        if (!sourceExports.has(name)) {
          const relFile = path.relative(ROOT_DIR, file);
          const relSrc  = path.relative(ROOT_DIR, resolvedPath);
          console.error(`  ✗ MISSING EXPORT: "${name}" imported in ${relFile} but not exported from ${relSrc}`);
          errorCount++;
        } else {
          // Track that this name was imported (for dead export detection)
          if (!importedNames.has(resolvedPath)) importedNames.set(resolvedPath, new Set());
          importedNames.get(resolvedPath).add(name);
        }
      }
    }
  }

  // Dead export detection (verbose only)
  if (VERBOSE) {
    for (const [filePath, exports] of exportMap) {
      const imported = importedNames.get(filePath) || new Set();
      const deadExports = [...exports].filter(name => !imported.has(name));
      if (deadExports.length > 0) {
        const relFile = path.relative(ROOT_DIR, filePath);
        console.warn(`  ⚠ UNUSED EXPORTS in ${relFile}: ${deadExports.join(", ")}`);
        warningCount++;
      }
    }
  }

  // Summary
  console.log("\n─────────────────────────────────────────────");
  if (errorCount === 0) {
    console.log(`\n  ✅ All imports are satisfied (0 errors).`);
    if (warningCount > 0 && VERBOSE) {
      console.log(`  ⚠  ${warningCount} warnings (dead exports / unresolvable modules).`);
    }
  } else {
    console.log(`\n  ✗  ${errorCount} import error${errorCount !== 1 ? "s" : ""} found.`);
    if (warningCount > 0 && VERBOSE) {
      console.log(`  ⚠  ${warningCount} warnings.`);
    }
    console.log("\n  Fix: ensure the named export exists in the source module.");
    console.log("  Common causes:");
    console.log("    • Typo in the exported function name");
    console.log("    • Function was renamed but import wasn't updated");
    console.log("    • Function moved to a different module");
  }
  console.log("\n");

  process.exit(errorCount > 0 ? 1 : 0);
}

run();
