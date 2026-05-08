# Contributing

Thanks for considering a contribution. The extension is meant to grow
adapter-by-adapter — each new site is one PR.

## Development setup

```bash
git clone https://github.com/Brevilabs/miyo-extension
cd miyo-extension
npm install
npm run build:watch
```

Then in Chrome → `chrome://extensions` → Developer mode → Load
unpacked → pick `./dist`. Reload the extension after each rebuild
(the `Reload` button on the extension card).

## Adding a site adapter

See [ADAPTER-API.md](ADAPTER-API.md) for the contract and the
gotchas. The short version:

1. Add `src/adapters/<site>.ts` exporting a `SiteAdapter`.
2. Add the import + entry to `src/adapters/index.ts`.
3. Add the host(s) to `public/manifest.json` under
   `host_permissions`.
4. Run `npm run typecheck` and `npm run build`.
5. Test with your own account: load the unpacked extension, sign in
   to the site, click Sync now, verify the markdown files look right.

## Pull requests

- Keep the PR scope small. One adapter per PR is ideal.
- Don't introduce dependencies if you can avoid them. The whole
  extension currently has zero runtime dependencies.
- Don't add automatic sync, polling, or alarms. The user-initiated
  posture is load-bearing for the project — see the strategy doc in
  the main Miyo repo if you want the why.

## Bug reports

Open an issue with:

- Which site adapter (if any) the bug touches.
- What you clicked.
- What you expected.
- What happened, including any error from the popup or from the
  Service Worker console at `chrome://extensions` → details →
  inspect views.
