// Build the extension into ./dist (Chrome, default) or ./dist-firefox
// (`--target=firefox`) for chrome://extensions / about:debugging to load.
//
// We bundle two entry points (background, popup) with esbuild, copy
// static assets, and emit a flat dist tree. No CSS preprocessing —
// popup.css is plain CSS copied as-is.
//
// The Firefox target reuses the same source and manifest, with two
// mechanical differences applied here at build time:
//   - the background runs as an MV3 event page (background.scripts),
//     not a service worker, so its bundle is emitted as an IIFE
//   - the manifest drops the Chrome-only `key` and gains
//     browser_specific_settings.gecko (add-on id, min version, data
//     collection disclosure)

import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const watch = process.argv.includes('--watch');
const target = process.argv.includes('--target=firefox') ? 'firefox' : 'chrome';
const DIST = resolve(ROOT, target === 'firefox' ? 'dist-firefox' : 'dist');

const sharedOptions = {
  bundle: true,
  format: 'esm',
  target: [target === 'firefox' ? 'firefox115' : 'chrome120'],
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
  await cp(resolve(ROOT, 'src/popup/fonts'), resolve(DIST, 'fonts'), { recursive: true });
  if (target === 'firefox') await firefoxifyManifest();
}

// public/manifest.json stays the single source of truth (sync-version
// only touches that file); the Firefox deltas are applied to the copy
// in dist-firefox.
async function firefoxifyManifest() {
  const path = resolve(DIST, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));

  // Chrome Web Store key pin; unknown to Firefox.
  delete manifest.key;

  // Firefox MV3 backgrounds are event pages, not service workers.
  manifest.background = { scripts: ['background.js'] };

  manifest.browser_specific_settings = {
    gecko: {
      // Permanent add-on id — AMO keys the listing and its updates to
      // it. Changing it after the first AMO upload forks the listing.
      id: 'miyo-capture@miyo.md',
      // storage.session (MV3) needs Firefox 115.
      strict_min_version: '115.0',
      // AMO data-collection disclosure (Firefox 140+, ignored by
      // older versions): the extension collects nothing.
      data_collection_permissions: { required: ['none'] },
    },
  };

  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}

async function build() {
  await clean();
  await copyStatic();

  const ctxs = await Promise.all([
    esbuild.context({
      ...sharedOptions,
      // Firefox loads background.js as a classic script (event page);
      // the bundle is single-file either way, so IIFE is equivalent.
      format: target === 'firefox' ? 'iife' : 'esm',
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
    console.log(`built → ${target === 'firefox' ? 'dist-firefox' : 'dist'}/`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
