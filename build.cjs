const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// 1. Setup paths
const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// 2. Read manifest for version
const manifestPath = path.join(ROOT_DIR, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error("Failed to read manifest.json:", e);
  process.exit(1);
}

const version = manifest.version || 'unknown';
const zipName = `lc-rating-predictor-v${version}.zip`;
const outputZip = path.join(ROOT_DIR, zipName);

// 3. Clean and recreate dist/
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR);

// 4. Define copy logic
const includedPaths = [
  'manifest.json',
  'scripts/background.js',
  'scripts/content.js',
  'scripts/profileInjector.js',
  'popup/',
  'icons/'
];

const copiedItems = [];
const skippedItems = [];

function copyRecursiveSync(src, dest, relPath) {
  if (!fs.existsSync(src)) {
    return;
  }
  
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    
    const children = fs.readdirSync(src);
    for (const child of children) {
      copyRecursiveSync(path.join(src, child), path.join(dest, child), path.join(relPath, child));
    }
  } else {
    fs.copyFileSync(src, dest);
    copiedItems.push(relPath);
  }
}

// Perform copies
for (const item of includedPaths) {
  const src = path.join(ROOT_DIR, item);
  const dest = path.join(DIST_DIR, item);
  
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyRecursiveSync(src, dest, item);
  } else {
    skippedItems.push(`${item} (Not found)`);
  }
}

// 5. Create zip
const zip = new AdmZip();
zip.addLocalFolder(DIST_DIR);
zip.writeZip(outputZip);

console.log('\n--- Build Summary ---');
console.log(`Version: ${version}`);
console.log('\nIncluded:');
copiedItems.forEach(item => console.log(`  + ${item}`));

console.log('\nExcluded / Ignored (Explicitly excluded by design):');
console.log(`  - repos/`);
console.log(`  - tests/`);
console.log(`  - scripts/predictor.js`);
console.log(`  - package.json`);
console.log(`  - README.md`);
console.log(`  - .git/`);

if (skippedItems.length > 0) {
  console.log('\nSkipped (Not found):');
  skippedItems.forEach(item => console.log(`  ? ${item}`));
}

console.log(`\nSuccess! Created ${zipName}`);
