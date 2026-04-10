#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const LIB_DIR = path.join(__dirname, '..', 'extension', 'lib');
const MODELS_DIR = path.join(__dirname, '..', 'extension', 'models');

const downloads = [
  {
    url: 'https://raw.githubusercontent.com/vladmandic/human/main/dist/human.js',
    dest: path.join(LIB_DIR, 'human.js'),
  },
  {
    url: 'https://raw.githubusercontent.com/hMatoba/piexifjs/master/piexif.js',
    dest: path.join(LIB_DIR, 'exif.js'),
  },
  {
    url: 'https://raw.githubusercontent.com/vladmandic/human/main/models/blazeface.json',
    dest: path.join(MODELS_DIR, 'blazeface.json'),
  },
  {
    url: 'https://raw.githubusercontent.com/vladmandic/human/main/models/blazeface.bin',
    dest: path.join(MODELS_DIR, 'blazeface.bin'),
  },
  {
    url: 'https://raw.githubusercontent.com/vladmandic/human/main/models/faceres.json',
    dest: path.join(MODELS_DIR, 'faceres.json'),
  },
  {
    url: 'https://raw.githubusercontent.com/vladmandic/human/main/models/faceres.bin',
    dest: path.join(MODELS_DIR, 'faceres.bin'),
  },
];

fs.mkdirSync(LIB_DIR, { recursive: true });
fs.mkdirSync(MODELS_DIR, { recursive: true });

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
  for (const { url, dest } of downloads) {
    await downloadFile(url, dest);
  }
  console.log('\nAll files downloaded successfully. You can now load the extension.');
})().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
