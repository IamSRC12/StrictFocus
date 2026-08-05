/**
 * generate_code.js
 * ----------------------------------------------------------------------------
 * StrictFocus code.txt generator + auto-update watcher
 * ----------------------------------------------------------------------------
 * Scans the project for source/config files, and writes them ALL into a single
 * `code.txt` file in a systematic, human-readable format.
 *
 * MODES
 *   node scripts/generate_code.js                -> single run, build code.txt
 *   node scripts/generate_code.js --watch        -> build, then watch for changes
 *                                                  and rebuild automatically
 *
 * AUTO-UPDATE
 *   When running with `--watch`, the script continuously monitors every source
 *   file/directory. As soon as any file is added, changed, or removed, `code.txt`
 *   is regenerated automatically (debounced to avoid churn during saves).
 * ----------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'code.txt');

// Directories that are *always* excluded from the snapshot (vendor / build noise).
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.gradle',
  'build',
  'dist',
  '.idea',
  '.vscode',
  'apk',
  'adb',
  'installer_output',
]);

// File/dir names ignored by exact name anywhere they appear.
const IGNORED_NAMES = new Set([
  'package-lock.json', // auto-generated dependency tree
  '.DS_Store',
  'Thumbs.db',
  'code.txt', // never include our own output
]);

// Files we deliberately skip as they are huge / auto-generated build artifacts.
const IGNORED_SUFFIXES = [
  '.exe',
  '.apk',
  '.blockmap',
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.woff',
  '.woff2',
  '.ttf',
  '.map',
  '.log',
];

// Allowed source extensions (everything else is skipped).
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.html', '.css', '.json', '.md',
  '.kt', '.java', '.kts', '.toml', '.properties',
  '.xml', '.bat', '.cmd', '.ps1', '.iss',
  '.yaml', '.yml', '.py', '.sh',
]);

// Recursively collect source file paths.
function collectSourceFiles(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const isDir = entry.isDirectory();

      if (isDir) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }

      // Skip exact-name ignored files.
      if (IGNORED_NAMES.has(entry.name)) continue;
      // Skip binary / forbidden suffixes.
      if (IGNORED_SUFFIXES.some((s) => entry.name.toLowerCase().endsWith(s))) continue;
      // Only keep allowed text/code extensions.
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;

      results.push(full);
    }
  }

  // Sort deterministically: root files first, then alphabetical full path.
  results.sort((a, b) => {
    const relA = path.relative(PROJECT_ROOT, a);
    const relB = path.relative(PROJECT_ROOT, b);
    const depthA = relA.split(path.sep).length;
    const depthB = relB.split(path.sep).length;
    if (depthA !== depthB) return depthA - depthB;
    return relA.localeCompare(relB);
  });

  return results;
}

// Human friendly language label from filename.
function languageOf(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const ext = path.extname(name);
  const map = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript (React)', '.jsx': 'JavaScript (React)',
    '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.md': 'Markdown',
    '.json': 'JSON', '.kt': 'Kotlin', '.kts': 'Kotlin Script', '.java': 'Java',
    '.toml': 'TOML', '.properties': 'Properties', '.xml': 'XML',
    '.bat': 'Batch', '.cmd': 'Batch', '.ps1': 'PowerShell', '.iss': 'Inno Setup',
    '.yaml': 'YAML', '.yml': 'YAML', '.py': 'Python', '.gradle': 'Gradle',
    '.build.gradle.kts': 'Kotlin/Gradle',
  };
  if (name.endsWith('.build.gradle.kts')) return 'Kotlin/Gradle';
  if (name.endsWith('.gradle.kts')) return 'Kotlin/Gradle';
  if (name === 'package.json') return 'JSON (npm)';
  return map[ext] || 'Unknown';
}

// Build the single consolidated code.txt content.
function buildSnapshot(files) {
  const lines = [];
  const separator = '='.repeat(80);

  lines.push(separator);
  lines.push('STRICTFOCUS — CODE SNAPSHOT (auto-generated)');
  lines.push(separator);
  lines.push(`Generated at  : ${new Date().toLocaleString()}`);
  lines.push(`Project root  : ${PROJECT_ROOT}`);
  lines.push(`Total files   : ${files.length}`);
  lines.push('');
  lines.push('--- FILE INDEX ---');
  files.forEach((f, i) => {
    lines.push(`${String(i + 1).padStart(3)}. ${path.relative(PROJECT_ROOT, f)}`);
  });
  lines.push('');
  lines.push(separator);
  lines.push('--- BEGIN OF FILES ---');
  lines.push(separator);
  lines.push('');

  files.forEach((file, i) => {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      content = `[UNREADABLE: ${err.message}]`;
    }

    // Strip any trailing newline noise for clean formatting.
    content = content.replace(/\r\n/g, '\n').replace(/\n+$/, '');

    const rel = path.relative(PROJECT_ROOT, file);
    const lang = languageOf(file);
    const lineCount = content.split('\n').length;
    const byteSize = Buffer.byteLength(content, 'utf8');

    lines.push(separator);
    lines.push(`FILE  : ${rel}`);
    lines.push(`LANG  : ${lang}`);
    lines.push(`LINES : ${lineCount}   |   SIZE : ${byteSize} bytes`);
    lines.push(separator);
    lines.push(content);
    lines.push('');
    lines.push(separator);
    lines.push('');
  });

  lines.push(separator);
  lines.push('END OF SNAPSHOT');
  lines.push(separator);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Rebuild + watch logic
// ---------------------------------------------------------------------------

const WATCHED_DIRS = new Set();

function refreshSnapshot() {
  try {
    const files = collectSourceFiles(PROJECT_ROOT);
    const content = buildSnapshot(files);
    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
    const when = new Date().toLocaleTimeString();
    console.log(`[${when}] code.txt regenerated (${files.length} source files).`);
  } catch (err) {
    console.error('Snapshot build failed:', err.message);
  }
}

// Recursively register a watch on a directory tree (Node supports recursive on
// some platforms; we attach listeners per relevant folder to be safe).
let debounceTimer = null;
function scheduleRefresh(reason) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log('Change detected:', reason);
    refreshSnapshot();
  }, 300);
}

function watchTree(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const watcher = fs.watch(rootDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const rel = filename.toString();
    // Ignore events on the output/itself / hidden / vendor.
    const base = path.basename(rel);
    if (base === 'code.txt') return;
    if (IGNORED_NAMES.has(base)) return;
    if (IGNORED_DIRS.has(base.split(path.sep)[0])) return;

    // Only react to paths pointing at text/code files.
    const ext = path.extname(rel).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return;

    scheduleRefresh(`${eventType} on ${rel}`);
  });
  // Keep watcher alive; attach to process lifetime.
  stack.on('error', (err) => console.error('Watcher error:', err.message));
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const watchMode = args.includes('--watch') || args.includes('-w');
const once = args.includes('--once') || (!watchMode);

function main() {
  refreshSnapshot();

  if (watchMode) {
    // Watch each top-level component of the project so that node_modules noise is
    // not walked, and events across nested dirs are still captured.
    const componentTops = collectSourceFiles(PROJECT_ROOT).map((f) => {
      // Track the containing top level folders we care about.
      return path.dirname(f);
    });

    // De-duplicate directories to watch.
    const toWatch = new Set(componentTops);
    toWatch.forEach((d) => {
      while (d && d.startsWith(PROJECT_ROOT)) {
        watchTree(d);
        break; // watch recursively at that dir level only
      }
    });

    console.log('Watching for file changes (auto-update code.txt)... Ctrl+C to stop.');
  }
}

main();