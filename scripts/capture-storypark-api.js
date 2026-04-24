/**
 * capture-storypark-api.js
 *
 * Launches Chrome via puppeteer-core, reusing a copy of your default Chrome
 * profile so you stay logged into Storypark, then navigates to
 * /latest_activity and captures every API request/response on
 * app.storypark.com (and assets.storypark.com) for analysis.
 *
 * Usage:  npm run capture
 *
 * Output (under ./captures/):
 *   - summary.json                     – list of all requests {url, method, status, contentType, bytes}
 *   - raw/NNN-METHOD-<sanitized>.json  – one file per JSON response body
 *   - storypark-capture.har            – standard HAR (subset – api hosts only)
 *
 * Privacy: The captures/ folder contains your session cookies + personal
 * data. The repo .gitignore excludes it. Delete after use.
 */

"use strict";

const fs   = require("fs");
const fsp  = require("fs/promises");
const os   = require("os");
const path = require("path");
const readline = require("readline");

let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch (e) {
  console.error("✖ puppeteer-core is not installed. Run:  npm install");
  process.exit(1);
}

const CHROME_EXE = process.env.CHROME_EXE
  || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const SOURCE_PROFILE = path.join(
  os.homedir(),
  "AppData", "Local", "Google", "Chrome", "User Data"
);

const OUT_DIR  = path.join(__dirname, "..", "captures");
const RAW_DIR  = path.join(OUT_DIR, "raw");
const HAR_PATH = path.join(OUT_DIR, "storypark-capture.har");
const SUMMARY  = path.join(OUT_DIR, "summary.json");

const TARGET_URL = "https://app.storypark.com/latest_activity";
const HOST_FILTER = /(^https?:\/\/(app|assets)\.storypark\.com\/)/i;

function sanitize(str, max = 80) {
  return str.replace(/[^a-z0-9._-]+/gi, "_").slice(0, max);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
}

async function copyProfileSubset(srcRoot, destRoot) {
  // Copy only the bits Chrome needs to keep you logged in (Default profile +
  // Local State). Skips Cache, Code Cache, GPUCache, Service Worker etc to
  // keep the copy fast.
  const SKIP_DIRS = new Set([
    "Cache", "Code Cache", "GPUCache", "Service Worker", "Crashpad",
    "ShaderCache", "GrShaderCache", "DawnCache", "Media Cache",
    "Application Cache", "blob_storage", "File System", "IndexedDB",
    "VideoDecodeStats", "optimization_guide_model_store"
  ]);

  async function copyDir(src, dest) {
    await fsp.mkdir(dest, { recursive: true });
    let entries;
    try { entries = await fsp.readdir(src, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
      const s = path.join(src, ent.name);
      const d = path.join(dest, ent.name);
      try {
        if (ent.isDirectory()) {
          await copyDir(s, d);
        } else if (ent.isFile()) {
          await fsp.copyFile(s, d);
        }
      } catch { /* skip locked files */ }
    }
  }

  await fsp.mkdir(destRoot, { recursive: true });
  // Local State (top-level)
  try { await fsp.copyFile(path.join(srcRoot, "Local State"), path.join(destRoot, "Local State")); } catch {}
  // Default profile (cookies, login session)
  await copyDir(path.join(srcRoot, "Default"), path.join(destRoot, "Default"));
}

async function autoScroll(page, times = 5, deltaY = 1500, delayMs = 1500) {
  for (let i = 0; i < times; i++) {
    await page.evaluate((d) => window.scrollBy(0, d), deltaY);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

(async () => {
  console.log("=== Storypark API Capture ===");
  if (!fs.existsSync(CHROME_EXE)) {
    console.error(`✖ Chrome not found at: ${CHROME_EXE}`);
    console.error("  Set CHROME_EXE env var to override.");
    process.exit(1);
  }

  console.log("\n⚠  Please CLOSE all open Chrome windows now (the script needs");
  console.log("   exclusive access to your profile to copy your session).");
  await prompt("   Press Enter when done... ");

  // Prepare output dirs
  await fsp.mkdir(RAW_DIR, { recursive: true });

  // Copy Chrome profile to a temp location (so we don't fight your real Chrome)
  const tempProfile = path.join(os.tmpdir(), `storypark-capture-profile-${Date.now()}`);
  console.log(`→ Copying Chrome profile to ${tempProfile} …`);
  try {
    await copyProfileSubset(SOURCE_PROFILE, tempProfile);
  } catch (e) {
    console.error("✖ Failed to copy Chrome profile:", e.message);
    console.error("  Make sure all Chrome windows are closed and try again.");
    process.exit(1);
  }
  console.log("✓ Profile copied.");

  console.log("→ Launching Chrome …");
  const browser = await puppeteer.launch({
    executablePath: CHROME_EXE,
    headless: false,
    userDataDir: tempProfile,
    defaultViewport: null,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
  });

  const page = (await browser.pages())[0] || (await browser.newPage());

  /** @type {Array<{url:string, method:string, status:number, contentType:string, bytes:number, requestHeaders:object, responseHeaders:object, requestBody?:string|null, responseBody?:string|null, startedAt:string, finishedAt:string}>} */
  const captured = [];
  let counter = 0;

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!HOST_FILTER.test(url)) return;
      const req = response.request();
      const status = response.status();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      let body = null;
      try { body = await response.text(); } catch {}
      const bytes = body ? Buffer.byteLength(body, "utf8") : 0;
      const entry = {
        url,
        method: req.method(),
        status,
        contentType,
        bytes,
        requestHeaders: req.headers(),
        responseHeaders: headers,
        requestBody: req.postData() || null,
        responseBody: body,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      captured.push(entry);

      // Save JSON responses individually for easy inspection
      const isJson = /json|javascript|text\/plain/i.test(contentType);
      if (isJson && body) {
        const idx = String(++counter).padStart(3, "0");
        const u = new URL(url);
        const fname = `${idx}-${entry.method}-${sanitize(u.pathname + (u.search || ""))}.json`;
        const filePath = path.join(RAW_DIR, fname);
        // Try to pretty-print if it parses; otherwise save raw text.
        let toWrite = body;
        try { toWrite = JSON.stringify(JSON.parse(body), null, 2); } catch {}
        await fsp.writeFile(filePath, toWrite, "utf8");
        console.log(`  [${idx}] ${status} ${entry.method} ${u.pathname}${u.search}  (${bytes} B)`);
      } else {
        console.log(`       ${status} ${entry.method} ${new URL(url).pathname}  [${contentType || "?"}]`);
      }
    } catch (e) {
      // Ignore individual response errors
    }
  });

  console.log(`→ Navigating to ${TARGET_URL} …`);
  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60_000 });
  } catch (e) {
    console.warn("⚠  Navigation timeout (continuing anyway):", e.message);
  }

  // Give the SPA a moment to fire its initial XHRs
  await new Promise((r) => setTimeout(r, 3000));

  console.log("→ Auto-scrolling feed to trigger pagination …");
  await autoScroll(page, 6, 1800, 1800);

  // Try to click the first story link to capture story-detail traffic
  console.log("→ Attempting to open the first story …");
  try {
    const opened = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/stories/"]'));
      if (links.length === 0) return false;
      links[0].click();
      return true;
    });
    if (opened) {
      await new Promise((r) => setTimeout(r, 4000));
      console.log("  ✓ Opened first story.");
    } else {
      console.log("  (no story links found on page)");
    }
  } catch {}

  console.log("\n→ Capture is running. Log in if needed, then browse the feed.");
  console.log("   Click into a story or two to capture story-detail traffic.");
  console.log("   Press Enter in this terminal when done (auto-stops in 5 minutes).");

  await Promise.race([
    prompt(""),
    new Promise((r) => setTimeout(r, 5 * 60_000)),
  ]);

  console.log("→ Saving outputs …");

  // Write summary.json
  const summary = captured.map((c) => ({
    url: c.url,
    method: c.method,
    status: c.status,
    contentType: c.contentType,
    bytes: c.bytes,
  }));
  await fsp.writeFile(SUMMARY, JSON.stringify(summary, null, 2), "utf8");

  // Write a HAR-like file
  const har = {
    log: {
      version: "1.2",
      creator: { name: "capture-storypark-api.js", version: "1.0" },
      entries: captured.map((c) => ({
        startedDateTime: c.startedAt,
        time: 0,
        request: {
          method: c.method,
          url: c.url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: Object.entries(c.requestHeaders).map(([name, value]) => ({ name, value })),
          queryString: [],
          headersSize: -1,
          bodySize: c.requestBody ? Buffer.byteLength(c.requestBody) : 0,
          ...(c.requestBody ? { postData: { mimeType: c.requestHeaders["content-type"] || "", text: c.requestBody } } : {}),
        },
        response: {
          status: c.status,
          statusText: "",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: Object.entries(c.responseHeaders).map(([name, value]) => ({ name, value })),
          content: {
            size: c.bytes,
            mimeType: c.contentType,
            text: c.responseBody || "",
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: c.bytes,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  };
  await fsp.writeFile(HAR_PATH, JSON.stringify(har, null, 2), "utf8");

  console.log(`✓ Captured ${captured.length} requests`);
  console.log(`  → summary:  ${SUMMARY}`);
  console.log(`  → raw JSON: ${RAW_DIR}`);
  console.log(`  → HAR:      ${HAR_PATH}`);

  await browser.close().catch(() => {});

  // Best-effort cleanup of the temp profile
  try { await fsp.rm(tempProfile, { recursive: true, force: true }); } catch {}

  console.log("Done.");
  process.exit(0);
})().catch((err) => {
  console.error("✖ Capture failed:", err);
  process.exit(1);
});