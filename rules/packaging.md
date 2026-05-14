# Packaging

The extension ships as an unpacked `dist/` (Chrome MV3). `npm run package` zips it for distribution.

## Manifest

`public/manifest.json` is the canonical Chrome manifest. Build copies it verbatim into `dist/`.

- **Host permissions**: any new adapter that hits a new origin must add it to `host_permissions`. Without this, `fetch` from the SW gets blocked silently or denied.
- **Permissions**: avoid adding new high-trust permissions (`history`, `cookies`, `webRequest`) — the project's positioning is "yours, on your machine," and broad permissions undercut that.
- **Versioning**: do not edit `version` by hand. Use `npm run version <X.Y.Z>` so `package.json` and `manifest.json` stay in lockstep (the release workflow verifies they match).

## Bundling

`scripts/build.mjs` is an esbuild-based bundler. It:
1. Compiles `src/background/index.ts`, `src/popup/index.ts`, and adapter entrypoints to `dist/`.
2. Copies `public/` (manifest, icons, popup.html, fonts) over.
3. Emits source maps in dev mode only.

When adding a new module:
- Pure TypeScript / npm-pure-JS dependencies → just import them; esbuild inlines.
- Anything Node-only (`fs`, `path`, native addons) → reject. The SW and content scripts have no Node runtime.

## Adapters

New adapters go in `src/adapters/<site>.ts` and are registered in `src/adapters/index.ts`. They must:
1. Implement `SiteAdapter` (`src/framework/types.ts`).
2. Route all network calls through `paced(adapter.id, fn)` from `src/framework/rate-limit.ts` — the 1.5s floor keeps the extension from looking like a scraper.
3. Throw `FatalError(401|403)` on auth failure, `RetryableError` on 429/5xx, plain `Error` otherwise (see `classifyHttp`).

See [`docs/ADAPTER-API.md`](../docs/ADAPTER-API.md).
