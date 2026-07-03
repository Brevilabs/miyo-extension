// Zip a built dist tree into miyo-capture-<version>-<target>.zip for
// store upload or GitHub release attachment. Default target is chrome
// (./dist); pass --target=firefox to zip ./dist-firefox. The trailing
// target marker keeps all assets for a given release sorted together
// by version, with room for miyo-capture-<version>-safari.zip if that
// target lands.

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const target = process.argv.includes('--target=firefox') ? 'firefox' : 'chrome';
const dist = resolve(ROOT, target === 'firefox' ? 'dist-firefox' : 'dist');

const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
const out = resolve(ROOT, `miyo-capture-${manifest.version}-${target}.zip`);

const child = spawn('zip', ['-r', out, '.'], {
  cwd: dist,
  stdio: 'inherit',
});
child.on('exit', (code) => {
  if (code === 0) console.log(`packaged → ${out}`);
  process.exit(code ?? 0);
});
