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

## Architecture

MV3 Chrome extension, zero runtime dependencies. Two esbuild entry points: `src/background/index.ts` (service worker) and `src/popup/index.ts`.

**Adapter ↔ framework split.** Adapters (`src/adapters/`) know one site's backend; the framework (`src/framework/`) owns rate limiting, file delivery, resume, and progress. New sites are one file in `src/adapters/` + entry in `src/adapters/index.ts` + host in `public/manifest.json`. Two kinds in `framework/types.ts`: `kind: 'chat'` returns a `ChatConversation` and the framework renders it uniformly; `kind: 'custom'` returns `{ filename, body }` and owns its own rendering. See `docs/ADAPTER-API.md` for the full contract.

**Capture loop.** `framework/capture.ts::captureToStore` walks `listItems` newest-first, calls `Store.filterMissing` to skip already-captured ids, and fetches the missing. One `Store` backend in `framework/capture-store.ts`: `IdbStore` buffers captured items to IndexedDB; the popup builds a ZIP from the buffer and downloads it when the run completes, then clears the buffer. `pending_run` (in `chrome.storage.local`) survives a service-worker death so the popup can offer Resume from the same cursor.

## Hard constraints (not enforced by code)

- **No background timers.** No `chrome.alarms`, no intervals. Every fetch must be a direct consequence of the user clicking Sync now — this user-initiated posture is load-bearing for how the project is framed.
- **No runtime dependencies, no telemetry.** The extension has zero deps and ships no analytics/feedback pings. Local-only is the product.
