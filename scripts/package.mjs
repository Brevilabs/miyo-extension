// Zip ./dist into miyo-sync-chrome-<version>.zip for Chrome Web Store
// upload or GitHub release attachment. The "chrome" postfix exists
// so Firefox and Safari artifacts can ship beside it later under
// the same naming scheme (miyo-sync-firefox-..., miyo-sync-safari-...).

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
const out = resolve(ROOT, `miyo-sync-chrome-${manifest.version}.zip`);

const child = spawn('zip', ['-r', out, '.'], {
  cwd: resolve(ROOT, 'dist'),
  stdio: 'inherit',
});
child.on('exit', (code) => {
  if (code === 0) console.log(`packaged → ${out}`);
  process.exit(code ?? 0);
});
