// Zip ./dist into miyo-sync-<version>-chrome.zip for Chrome Web Store
// upload or GitHub release attachment. The trailing "-chrome" target
// marker leaves room for miyo-sync-<version>-firefox.zip and
// miyo-sync-<version>-safari.zip when those targets land — and keeps
// all assets for a given release sorted together by version.

import { readFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const manifest = JSON.parse(
  await readFile(resolve(ROOT, 'dist/manifest.json'), 'utf8')
);
const out = resolve(ROOT, `miyo-sync-${manifest.version}-chrome.zip`);

const child = spawn('zip', ['-r', out, '.'], {
  cwd: resolve(ROOT, 'dist'),
  stdio: 'inherit',
});
child.on('exit', (code) => {
  if (code === 0) console.log(`packaged → ${out}`);
  process.exit(code ?? 0);
});
