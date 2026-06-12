## Commands

```bash
npm run build              # bundles src/ → dist/ (esbuild, ESM, chrome120 target)
npm run build:watch        # rebuild on file change
npm run typecheck          # tsc --noEmit, strict
npm run lint               # eslint src --ext .ts
npm run test:unit          # node:test runner
npm run package            # build + zip for Chrome Web Store
```

Single test: `tsc -p tsconfig.test.json && node --test .test-dist/framework/chat.test.js`.

## Releasing

`npm version patch` (syncs manifest via `scripts/sync-version.mjs`), commit `Release vX.Y.Z`, tag `vX.Y.Z`, push with tags. Pushing the tag triggers `.github/workflows/release.yml`, which builds the zip and creates the GitHub release — do NOT `gh release create` manually, it makes the workflow fail with a tag conflict. Always check the Release workflow run is green (`gh run list`) before claiming the release succeeded.

## Architecture

MV3 Chrome extension, zero runtime dependencies. Two esbuild entry points: `src/background/index.ts` (service worker) and `src/popup/index.ts`.

**Adapter ↔ framework split.** Adapters (`src/adapters/`) know one site's backend; the framework (`src/framework/`) owns rate limiting, file delivery, resume, and progress. New sites are one file in `src/adapters/` + entry in `src/adapters/index.ts` + host in `public/manifest.json`. Two kinds in `framework/types.ts`: `kind: 'chat'` returns a `ChatConversation` and the framework renders it uniformly; `kind: 'custom'` returns `{ filename, body }` and owns its own rendering. See `docs/ADAPTER-API.md` for the full contract.

**Capture loop.** `framework/capture.ts::captureToStore` walks `listItems` newest-first, calls `Store.filterMissing` to skip already-captured ids, and fetches the missing. One `Store` backend in `framework/capture-store.ts`: `IdbStore` buffers captured items to IndexedDB; the popup builds a ZIP from the buffer and downloads it when the run completes, then clears the buffer. `pending_run` (in `chrome.storage.local`) survives a service-worker death so the popup can offer Resume from the same cursor.

## Hard constraints (not enforced by code)

- **No background timers in capture mode.** The capture flow has no `chrome.alarms`, no intervals — every site fetch is a direct consequence of the user clicking Download. One deliberate exception: the opt-in "Sync to Miyo Desktop" mode (`src/miyo-link.ts`) uses a single `miyo-sync-push` alarm to re-push session cookies to the local Miyo app over Chrome native messaging; it never fetches chat content from the sites in the background. Don't add others.
- **No runtime dependencies, no telemetry.** The extension has zero deps and ships no analytics/feedback pings. Local-only is the product (Miyo sync sends cookies only to the desktop app's native-messaging host — no network, no remote endpoint).
