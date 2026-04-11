#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const LIB_DIR = path.join(__dirname, '..', 'extension', 'lib');
const MODELS_DIR = path.join(__dirname, '..', 'extension', 'models');
const VERSION_FILE = path.join(__dirname, '..', '.human-version');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    }).on('error', reject);
  });
}

async function getLatestVersion() {
  const data = await httpGet('https://registry.npmjs.org/@vladmandic/human/latest');
  const { version } = JSON.parse(data.toString());
  return version;
}

function getCurrentVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(dest);
    console.log(`Downloading ${filename} ...`);
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`  ✓ Saved ${filename}`);
        resolve();
      });
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

(async () => {
  console.log('=== Storypark Smart Saver – Setup ===\n');

  const latestVersion = await getLatestVersion();
  const currentVersion = getCurrentVersion();
  const requiredFiles = [
    path.join(LIB_DIR, 'human.js'),
    path.join(MODELS_DIR, 'blazeface.json'),
    path.join(MODELS_DIR, 'blazeface.bin'),
    path.join(MODELS_DIR, 'faceres.json'),
    path.join(MODELS_DIR, 'faceres.bin'),
  ];
  const forceDownload = requiredFiles.some((f) => !fs.existsSync(f));

  console.log(`  Latest @vladmandic/human version: ${latestVersion}`);
  console.log(`  Current pinned version:           ${currentVersion || '(none)'}\n`);

  if (currentVersion === latestVersion && !forceDownload) {
    console.log('Already up to date — skipping downloads.');
    process.exit(0);
  }

  // NOTE: extension/lib/exif.js is already committed to the repository and is
  // the source of truth for EXIF writing. Do NOT add piexif.js here — it
  // must not be downloaded or overwritten by this script.
  const BASE = `https://raw.githubusercontent.com/vladmandic/human/v${latestVersion}`;

  const downloads = [
    { url: `${BASE}/dist/human.js`, dest: path.join(LIB_DIR, 'human.js') },
    { url: `${BASE}/models/blazeface.json`, dest: path.join(MODELS_DIR, 'blazeface.json') },
    { url: `${BASE}/models/blazeface.bin`, dest: path.join(MODELS_DIR, 'blazeface.bin') },
    { url: `${BASE}/models/faceres.json`, dest: path.join(MODELS_DIR, 'faceres.json') },
    { url: `${BASE}/models/faceres.bin`, dest: path.join(MODELS_DIR, 'faceres.bin') },
  ];

  fs.mkdirSync(LIB_DIR, { recursive: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  for (const { url, dest } of downloads) {
    await downloadFile(url, dest);
  }

  fs.writeFileSync(VERSION_FILE, latestVersion + '\n');
  console.log(`\n✓ Updated to v${latestVersion}. Version pinned in .human-version`);
})().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
