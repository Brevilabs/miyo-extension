# Miyo Sync

> Liberate any logged-in data into markdown your AI can use.

Bulk-sync your **personal data** out of walled-garden apps — the
conversations, bookmarks, and records you produced and can't easily
get out — into local markdown files. One click syncs your full
history; subsequent clicks pick up only what's new.

This is a **personal data extractor**, not a web clipper. We don't
optimize for "save this article" — we optimize for "get my ChatGPT
history out so my own AI tools can use it."

## What it syncs today

- **ChatGPT** — full conversation history, including titles and
  timestamps.
- **Claude (claude.ai)** — full conversation history.

## What's coming

ChatGPT and Claude are the launch wedge — they're where the most
locked-in personal context lives today. They're not the destination.
The product is a **personal data extractor for any walled-garden
SaaS**, and the source list is meant to grow:

- More AI chat providers (Gemini, Grok, …)
- Browser bookmarks and reading history
- Note apps (Notion, …)
- More SaaS as community contributions land

Adding a source is one ~150-line adapter — see
[docs/ADAPTER-API.md](docs/ADAPTER-API.md). The framework handles
rate limiting, pagination, file writes, progress UI, and state
persistence.

Both ChatGPT and Claude are accessed via unofficial APIs and could
be revoked at any time. Portfolio breadth is the durability story.

## How delivery works

The extension picks one of two transports automatically per sync run.
**In both modes, your data stays on your machine. Nothing is uploaded.**

- **Standalone (local-only)** — sync stores conversations in a local
  buffer inside the extension. Works the moment you install. To get
  the markdown files on disk, click **Export to disk** from the popup;
  the OS save dialog lets you pick any folder, and the export ships
  as a zip alongside a folder README that tells your local AI agent
  (Claude Code, Cursor, Codex, …) how to use the files. Multi-source
  users export per-source — this is intentional friction; the
  smoother path is Miyo.
- **With [Miyo](https://miyo.md) installed** — files land in a
  folder *you choose*, on your machine, the moment you sync. Miyo
  indexes them for **semantic search** and serves them over **MCP**,
  so your favorite AI app — ChatGPT and Claude.ai in the cloud,
  Claude Code and Cursor locally — can query your full history on
  demand. Miyo doesn't see the contents; it only opens a local door
  for the AI to read through.

Install Miyo after a few standalone syncs, and the popup offers a
one-click **Send to Miyo** that replays the buffered conversations
into Miyo's library. From then on, every sync streams straight
through. No setting, no toggle.

## Output format

Each conversation lands at
`<dest>/<source>/<YYYY-MM-DD> <title> (<shortId>).md`, where
`<dest>` is the folder you chose in Miyo (Miyo mode) or the folder
you pick in the OS save dialog when you click Export (standalone
mode). The file contains:

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
  buffered locally (IndexedDB) or streamed to the Miyo desktop app
  on `127.0.0.1` — never to a server we control.
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
