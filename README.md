# Miyo Capture

> Liberate any logged-in data into markdown your AI can use.

Bulk-sync your **personal data** out of walled-garden apps — the
conversations, bookmarks, and records you produced and can't easily
get out — into local markdown files. One click syncs your full
history; subsequent clicks pick up only what's new.

This is a **personal data extractor**, not a web clipper. We don't
optimize for "save this article" — we optimize for "get my ChatGPT
history out so my own AI tools can use it."

## What it captures today

- **ChatGPT** — full conversation history, including titles and
  timestamps.
- **Claude (claude.ai)** — full conversation history.

More sources are added one adapter at a time — see
[docs/ADAPTER-API.md](docs/ADAPTER-API.md). The framework handles
rate limiting, pagination, file writes, progress UI, and state
persistence; an adapter is ~150 lines of API calls and shape
normalization.

## How delivery works

The extension picks one of two transports automatically per sync run:

- **Standalone** — files land in `~/Downloads/Miyo/<source>/`.
  Works the moment you install. The sync also writes a README in
  the folder telling your local AI agent (Claude Code, Cursor,
  Codex, …) how to use these files.
- **With [Miyo](https://miyo.md) installed** — files land in your
  chosen Miyo library folder, get indexed for semantic search, and
  appear in the Synced apps view in the Miyo desktop app. Plus:
  your AI history becomes queryable via MCP from inside ChatGPT,
  Claude.ai, and any agent that speaks MCP.

Install Miyo later and your next sync routes through the richer
transport automatically. No setting, no toggle.

## Output format

Each conversation lands at
`<dest>/<source>/<YYYY-MM-DD> <title> (<shortId>).md`, where
`<dest>` is your Miyo library folder (Miyo mode) or
`~/Downloads/Miyo` (standalone mode). The file contains:

- YAML frontmatter with `platform`, `conversation_id`, `title`,
  `url`, `created_at`, `updated_at`.
- One section per message, headed `## User · 2026-04-28 14:32` or
  `## Assistant · …`.

The format is shared across all chat adapters so a Miyo library
reads as one corpus rather than per-vendor formats.

## Design

- **Sync only when you click.** No background polling, no alarms,
  no auto-refresh. The only trigger is the Sync now button in the
  popup. Maps the action to "the user porting their own data," not
  "an automated bot."
- **Local only.** Conversation data never leaves your machine.
  Cookies and access tokens stay inside the browser. Markdown is
  delivered either to your `Downloads` folder or to the Miyo
  desktop app on `127.0.0.1` — never to a server we control.
- **Bulk + incremental.** First sync pulls everything. Every sync
  after that pulls only what's new (cursor by `updated_at`).
  Renamed conversations are handled in Miyo mode via stable IDs.
- **One adapter per site.** Open source — community contributors
  add new sources without us shipping a desktop release. The Miyo
  desktop is source-agnostic and renders any new `source_id` from
  metadata the extension supplies on `sync/start`.
- **Cross-browser.** Chrome and Chromium-based browsers (Edge,
  Brave, Arc), Firefox. Safari support is planned.

More on what Miyo does and how the extension fits in:
[miyo.md](https://miyo.md).

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

Adding a new site? Read
[docs/ADAPTER-API.md](docs/ADAPTER-API.md) and
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
