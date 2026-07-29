const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const esbuild = require('esbuild');

// ── Setup Paths ─────────────────────────────────────────────────────────────

const ROOT_DIR = __dirname;
const SRC_DIR = path.join(ROOT_DIR, 'src');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// ── Read Manifest ───────────────────────────────────────────────────────────

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

// ── Clean and Recreate dist/ ────────────────────────────────────────────────

if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR);

// ── Build Configuration ─────────────────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';

console.log('\n🔨 Building LC Rating Predictor Extension (esbuild)...\n');
console.log(`Version: ${version}`);
console.log(`Mode: ${isProd ? 'Production' : 'Development'}`);
console.log('');

async function build() {
  const copiedItems = [];
  const skippedItems = [];

  // 1. Bundle Scripts with esbuild
  const entryPoints = [
    path.join(SRC_DIR, 'scripts/background.js'),
    path.join(SRC_DIR, 'scripts/content.js'),
    path.join(SRC_DIR, 'scripts/profileInjector.js'),
    path.join(SRC_DIR, 'popup/popup.js'),
  ];

  try {
    await esbuild.build({
      entryPoints,
      bundle: true,
      minify: isProd,
      sourcemap: !isProd ? 'inline' : false,
      outdir: DIST_DIR,
      format: 'iife',
      logLevel: 'info',
    });
    console.log('✅ esbuild bundling complete.\n');
  } catch (err) {
    console.error('❌ esbuild bundling failed:', err);
    process.exit(1);
  }

  // 2. Copy Static Assets
  function copyRecursiveSync(src, dest, relPath) {
    if (!fs.existsSync(src)) return;

    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

      const children = fs.readdirSync(src);
      for (const child of children) {
        copyRecursiveSync(
          path.join(src, child),
          path.join(dest, child),
          path.join(relPath, child)
        );
      }
    } else {
      // Only copy non-JS files (JS is handled by esbuild)
      if (!src.endsWith('.js')) {
        fs.copyFileSync(src, dest);
        copiedItems.push(relPath);
      }
    }
  }

  // Copy source assets from src/ (like popup/index.html, popup/styles.css)
  const srcAssets = ['popup/'];
  for (const item of srcAssets) {
    const src = path.join(SRC_DIR, item);
    const dest = path.join(DIST_DIR, item);

    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      copyRecursiveSync(src, dest, item);
    } else {
      skippedItems.push(`src/${item} (Not found)`);
    }
  }

  // Copy root-level assets (manifest, icons)
  const rootAssets = ['manifest.json', 'icons/'];
  for (const item of rootAssets) {
    const src = path.join(ROOT_DIR, item);
    const dest = path.join(DIST_DIR, item);

    if (fs.existsSync(src)) {
      if (fs.statSync(src).isDirectory()) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
      }
      copyRecursiveSync(src, dest, item);
    } else {
      skippedItems.push(`${item} (Not found)`);
    }
  }

  // ── Create Zip ──────────────────────────────────────────────────────────────

  const zip = new AdmZip();
  zip.addLocalFolder(DIST_DIR);
  zip.writeZip(outputZip);

  // ── Build Summary ───────────────────────────────────────────────────────────

  console.log('\n--- Build Summary ---');
  console.log(`Version: ${version}`);
  console.log('\nIncluded (Bundled JS):');
  entryPoints.forEach(ep => console.log(`  + ${path.relative(ROOT_DIR, ep)}`));

  console.log('\nIncluded (Static Assets):');
  copiedItems.forEach(item => console.log(`  + ${item}`));

  if (skippedItems.length > 0) {
    console.log('\nSkipped (Not found):');
    skippedItems.forEach(item => console.log(`  ? ${item}`));
  }

  console.log(`\n✅ Success! Created ${zipName}`);
}

build();
