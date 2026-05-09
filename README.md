# Miyo extension

Capture your AI chat history (ChatGPT and Claude) as local markdown
files. The extension runs in your browser and fetches each
conversation in your own logged-in session.

The extension is useful immediately on its own:

- **Standalone:** files land in `~/Downloads/Miyo/<source>/`. Works
  the moment you install.
- **With [Miyo](https://github.com/Brevilabs/miyo) installed:** files
  land in your Miyo library folder, get indexed for search, and
  appear in the Synced apps view in the Miyo desktop app.

The extension picks the right delivery automatically — install Miyo
later and your next sync just routes to the richer transport.

## Design

- **Sync only when you click.** No background polling, no alarms, no
  auto-refresh. The only trigger is the Sync now button in the
  popup.
- **Local only.** Conversation data never leaves your machine.
  Cookies and access tokens stay inside the browser. Markdown is
  delivered either to your `Downloads` folder or to the Miyo desktop
  app on `127.0.0.1`.
- **One adapter per site.** ChatGPT and Claude ship in this repo;
  more sites can be added by writing one ~150-line adapter file —
  see [docs/ADAPTER-API.md](docs/ADAPTER-API.md).
- **Cross-browser.** Targets Chrome (and other Chromium-based
  browsers — Edge, Brave, Arc) and Firefox. Safari support is
  planned.

For why the project is shaped this way and the ToS posture behind it,
see the architecture docs in the main Miyo repo:
[extension-architecture.md](https://github.com/Brevilabs/miyo/blob/main/docs/extension-architecture.md)
and
[chatgpt-capture-strategy.md](https://github.com/Brevilabs/miyo/blob/main/docs/chatgpt-capture-strategy.md).

## Development

```bash
npm install
npm run build              # builds to ./dist
npm run build:watch        # rebuild on change
npm run typecheck
```

Then load `./dist` as an unpacked extension in
`chrome://extensions` (Developer mode → Load unpacked) or in
`about:debugging` for Firefox.

To package for distribution:

```bash
npm run package            # produces miyo-extension-<version>.zip
```

## Output format

For each conversation the extension writes
`<dest>/<source>/<YYYY-MM-DD> <title> (<shortId>).md`, where `<dest>`
is your Miyo library folder (Miyo mode) or `~/Downloads/Miyo`
(standalone mode). The file contains:

- YAML frontmatter with `platform`, `conversation_id`, `title`,
  `url`, `created_at`, `updated_at`.
- One section per message, headed `## User · 2026-04-28 14:32` or
  `## Assistant · …`.

The format matches what the Miyo desktop app's earlier capture path
produced, so existing libraries stay coherent.

## License

MIT — see [LICENSE](LICENSE).
