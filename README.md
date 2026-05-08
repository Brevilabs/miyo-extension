# Miyo extension

Capture your AI chat history (ChatGPT and Claude) as local markdown
files. The extension runs entirely in your browser, fetches each
conversation in your own logged-in session, and writes the resulting
markdown into a folder you choose on disk via the
[File System Access API][fsa].

The files it writes are normal `.md` files. Any tool that reads
markdown — your editor, ripgrep, [Miyo desktop](https://github.com/Brevilabs/miyo),
or another search tool — works on them. The desktop app is not
required.

[fsa]: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API

## Design

- **Sync only when you click.** No background polling, no alarms, no
  auto-refresh. The only trigger is the Sync now button in the popup.
- **Local only.** Conversation data never leaves your machine. Cookies
  and access tokens stay inside the browser. Files are written to the
  folder you pick.
- **One adapter per site.** ChatGPT and Claude ship in this repo;
  more sites can be added by writing one ~150-line adapter file —
  see [docs/ADAPTER-API.md](docs/ADAPTER-API.md).

For why the project is shaped this way and the ToS posture behind it,
see the architecture docs in the main Miyo repo:
[extension-architecture.md](https://github.com/Brevilabs/miyo/blob/main/docs/extension-architecture.md)
and
[chatgpt-capture-strategy.md](https://github.com/Brevilabs/miyo/blob/main/docs/chatgpt-capture-strategy.md).

## Browser support

Chrome (and other Chromium-based browsers — Edge, Brave, Arc).
Firefox is not supported in v1: it does not implement the File System
Access API, which the extension relies on for writing files to disk.

## Development

```bash
npm install
npm run build              # builds to ./dist
npm run build:watch        # rebuild on change
npm run typecheck
```

Then load `./dist` as an unpacked extension in
`chrome://extensions` (Developer mode → Load unpacked).

To package for distribution:

```bash
npm run package            # produces miyo-extension-<version>.zip
```

## Output format

For each conversation Miyo writes
`<your library>/<site>/<YYYY-MM-DD> <title> (<shortId>).md`. The file
contains:

- YAML frontmatter with `platform`, `conversation_id`, `title`, `url`,
  `created_at`, `updated_at`.
- One section per message, headed `## User · 2026-04-28 14:32` or
  `## Assistant · …`.

The format is identical to the format used by the Miyo desktop app's
previous capture path, so existing libraries stay coherent.

## License

MIT — see [LICENSE](LICENSE).
