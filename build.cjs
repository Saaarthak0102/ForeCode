const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ── Setup Paths ─────────────────────────────────────────────────────────────

const ROOT_DIR = __dirname;
const SRC_DIR = path.join(ROOT_DIR, 'src');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const LIB_DIR = path.join(SRC_DIR, 'scripts', 'lib');

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

// ── Inline Shared Modules ───────────────────────────────────────────────────

/**
 * Cache for loaded library files to avoid reading the same file multiple times.
 */
const libCache = new Map();

/**
 * Load a library file's contents, stripping any export statements
 * since we're inlining into non-module scripts.
 */
function loadLib(libName) {
  if (libCache.has(libName)) return libCache.get(libName);

  const libPath = path.join(LIB_DIR, libName);
  if (!fs.existsSync(libPath)) {
    console.error(`  ✗ Library not found: ${libName}`);
    process.exit(1);
  }

  let content = fs.readFileSync(libPath, 'utf8');

  // Strip ES module export statements (not needed when inlining)
  content = content.replace(/^export\s+/gm, '');

  libCache.set(libName, content);
  return content;
}

/**
 * Process a script file, replacing {{INLINE:lib/xxx.js}} markers
 * with the actual library contents.
 */
function inlineLibraries(scriptContent, scriptName) {
  const inlinePattern = /^.*\{\{INLINE:(lib\/[^}]+)\}\}.*$/gm;
  const inlined = new Set();

  const result = scriptContent.replace(inlinePattern, (match, libPath) => {
    const libName = libPath.replace('lib/', '');

    if (inlined.has(libName)) {
      return `// [Already inlined: ${libName}]`;
    }

    inlined.add(libName);
    const libContent = loadLib(libName);
    console.log(`  ↳ Inlined ${libName} into ${scriptName}`);

    return [
      `// ── BEGIN INLINED: ${libName} ──────────────────────────────────`,
      libContent.trim(),
      `// ── END INLINED: ${libName} ────────────────────────────────────`,
    ].join('\n');
  });

  return result;
}

// ── File Copy with Inline Processing ────────────────────────────────────────

/**
 * All script paths (relative to src/) that need shared module inlining.
 */
const allInlineTargets = new Set([
  'scripts/background.js',
  'scripts/content.js',
  'scripts/profileInjector.js',
  'popup/popup.js',
]);

/**
 * Source files/directories to include in the build (relative to src/).
 * The lib/ directory is NOT included — its contents are inlined.
 */
const srcPaths = [
  'scripts/background.js',
  'scripts/content.js',
  'scripts/profileInjector.js',
  'popup/',
];

/**
 * Root-level files to include in the build.
 */
const rootPaths = [
  'manifest.json',
  'icons/',
];

const copiedItems = [];
const skippedItems = [];

function copyRecursiveSync(src, dest, relPath) {
  if (!fs.existsSync(src)) return;

  // Skip the lib/ directory — its contents are inlined into scripts
  const normalizedRel = relPath.replace(/\\/g, '/');
  if (normalizedRel === 'scripts/lib' || normalizedRel.startsWith('scripts/lib/')) {
    return;
  }

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
    if (allInlineTargets.has(normalizedRel)) {
      // Process inlining for this script
      const content = fs.readFileSync(src, 'utf8');
      const processed = inlineLibraries(content, path.basename(src));
      fs.writeFileSync(dest, processed, 'utf8');
      copiedItems.push(`${relPath} (inlined)`);
    } else {
      fs.copyFileSync(src, dest);
      copiedItems.push(relPath);
    }
  }
}

// ── Execute Build ───────────────────────────────────────────────────────────

console.log('\n🔨 Building LC Rating Predictor Extension...\n');
console.log(`Version: ${version}`);
console.log('');

// Pre-load all lib files to check they exist
if (fs.existsSync(LIB_DIR)) {
  const libFiles = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.js'));
  console.log(`📦 Shared modules found: ${libFiles.join(', ')}`);
  console.log('');
}

// Copy source files from src/
for (const item of srcPaths) {
  const src = path.join(SRC_DIR, item);
  const dest = path.join(DIST_DIR, item);

  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyRecursiveSync(src, dest, item);
  } else {
    skippedItems.push(`src/${item} (Not found)`);
  }
}

// Copy root-level files (manifest, icons)
for (const item of rootPaths) {
  const src = path.join(ROOT_DIR, item);
  const dest = path.join(DIST_DIR, item);

  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
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
console.log('\nIncluded:');
copiedItems.forEach(item => console.log(`  + ${item}`));

console.log('\nExcluded / Ignored (by design):');
console.log('  - src/scripts/lib/   (inlined into scripts)');
console.log('  - backend/');
console.log('  - node_modules/');
console.log('  - package.json');
console.log('  - build.cjs');
console.log('  - .git/');

if (skippedItems.length > 0) {
  console.log('\nSkipped (Not found):');
  skippedItems.forEach(item => console.log(`  ? ${item}`));
}

console.log(`\n✅ Success! Created ${zipName}`);
