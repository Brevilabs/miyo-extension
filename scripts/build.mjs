// Build the extension into ./dist for `chrome://extensions` to load.
//
// We bundle two entry points (background service worker, popup) with
// esbuild, copy static assets, and emit a flat dist tree. No CSS
// preprocessing — popup.css is plain CSS copied as-is.

import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

const watch = process.argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  format: 'esm',
  target: ['chrome120'],
  platform: 'browser',
  sourcemap: 'inline',
  logLevel: 'info',
};

async function clean() {
  if (existsSync(DIST)) await rm(DIST, { recursive: true });
  await mkdir(DIST, { recursive: true });
}

async function copyStatic() {
  await cp(resolve(ROOT, 'public'), DIST, { recursive: true });
  await cp(resolve(ROOT, 'src/popup/popup.html'), resolve(DIST, 'popup.html'));
  await cp(resolve(ROOT, 'src/popup/popup.css'), resolve(DIST, 'popup.css'));
}

async function build() {
  await clean();
  await copyStatic();

  const ctxs = await Promise.all([
    esbuild.context({
      ...sharedOptions,
      entryPoints: [resolve(ROOT, 'src/background/index.ts')],
      outfile: resolve(DIST, 'background.js'),
    }),
    esbuild.context({
      ...sharedOptions,
      entryPoints: [resolve(ROOT, 'src/popup/index.ts')],
      outfile: resolve(DIST, 'popup.js'),
    }),
  ]);

  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('watching for changes…');
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
    console.log('built → dist/');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
