'use strict';

/**
 * Bundles src/*.js into dist/Code.gs so the server can be pasted into the Apps
 * Script editor as a single file, next to dist/appsscript.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');

const files = fs
  .readdirSync(SRC_DIR)
  .filter((file) => file.endsWith('.js'))
  .sort();

const bundle = files
  .map((file) => '// ===== ' + file + ' =====\n' + fs.readFileSync(path.join(SRC_DIR, file), 'utf8').trimEnd() + '\n')
  .join('\n');

fs.mkdirSync(DIST_DIR, { recursive: true });
fs.writeFileSync(path.join(DIST_DIR, 'Code.gs'), bundle);
fs.copyFileSync(path.join(SRC_DIR, 'appsscript.json'), path.join(DIST_DIR, 'appsscript.json'));

process.stdout.write('Built dist/Code.gs from ' + files.length + ' files (' + bundle.split('\n').length + ' lines).\n');
