# Miyo extension

Capture your AI chat history (ChatGPT and Claude) into your local
[Miyo](https://github.com/Brevilabs/miyo) library. The extension runs
in your browser, fetches each conversation in your own logged-in
session, renders it as markdown, and POSTs it to the Miyo desktop app
on `localhost`. Miyo writes the file under your library directory and
indexes it for search.

The files Miyo writes are normal `.md` files. Any tool that reads
markdown — your editor, ripgrep, the Miyo app, or another search tool
— works on them.

## Design

- **Sync only when you click.** No background polling, no alarms, no
  auto-refresh. The only trigger is the Sync now button in the popup.
- **Local only.** Conversation data never leaves your machine.
  Cookies and access tokens stay inside the browser. Markdown bodies
  travel from the extension to the Miyo desktop app over `127.0.0.1`
  loopback only.
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

## Requires

- The [Miyo desktop app](https://github.com/Brevilabs/miyo) running
  on the same machine. The extension talks to it on
  `http://127.0.0.1:8742`. The popup tells you if Miyo isn't
  reachable.

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

For each conversation Miyo writes
`<library>/<source>/<YYYY-MM-DD> <title> (<shortId>).md`. The file
contains:

- YAML frontmatter with `platform`, `conversation_id`, `title`, `url`,
  `created_at`, `updated_at`.
- One section per message, headed `## User · 2026-04-28 14:32` or
  `## Assistant · …`.

The format matches what the Miyo desktop app's earlier capture path
produced, so existing libraries stay coherent.

## License

MIT — see [LICENSE](LICENSE).
