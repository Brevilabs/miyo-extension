// Mirror package.json's version into public/manifest.json.
// Wired into npm-version's lifecycle (package.json scripts.version),
// so `npm version patch` keeps both files in lockstep before
// committing and tagging.

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
const manifestPath = resolve(ROOT, 'public/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.version === pkg.version) {
  console.log(`manifest already at ${pkg.version}`);
  process.exit(0);
}

manifest.version = pkg.version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
execSync('git add public/manifest.json', { cwd: ROOT });
console.log(`manifest synced → ${pkg.version}`);
