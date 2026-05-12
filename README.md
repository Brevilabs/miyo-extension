# Miyo Capture

> Capture your AI chats as local markdown, in a folder you choose.

A browser extension that saves your **ChatGPT** and **Claude**
conversations as markdown files on your own machine. One conversation
per file. No accounts, no servers, no cloud.

The captured folder is plain markdown — use it with **Miyo Desktop**,
**Obsidian**, **Logseq**, your code editor, or just `grep`. Miyo
Capture writes; you decide what reads.

## How it works

1. Install the extension.
2. Open the popup. Pick which sites to capture from (ChatGPT, Claude).
3. For each site, pick a folder on your computer.
4. Captures land in that folder as you sync. One markdown file per
   conversation.

Each destination folder gets a hidden `.miyo-capture.json` describing
the source — so tools like Miyo Desktop can recognize the folder as,
say, "your ChatGPT archive" and render it accordingly.

## What's captured

- **ChatGPT** — full conversation history (titles, timestamps, messages).
- **Claude (claude.ai)** — full conversation history.

More sources are planned. Each is a single adapter file — see
[docs/ADAPTER-API.md](docs/ADAPTER-API.md).

## Design

- **Sync only when you click.** No background polling, no alarms.
- **Local only.** Conversation data never leaves your machine.
- **Folder is the source of truth.** Dedup, cursor, and sync state
  live in `.miyo-capture.json` inside the destination folder — not in
  extension storage. If you reinstall the extension or move to a new
  machine, point it at the same folder and it picks up where it left off.
- **Pause and resume per site.** Toggle a site off without losing its
  destination or capture history.
- **No lock-in.** The output is plain markdown. The metadata file is
  small JSON. Any tool can consume it; nothing about Miyo Capture
  forces you to keep using Miyo Capture.

## Browser support

- **Chrome / Edge / Brave / Arc / Chromium**: full support. Pick any
  folder via the File System Access API.
- **Firefox / Safari**: planned. These browsers don't expose a "pick
  any folder" API, so captures will land in your Downloads folder.

## Output format

Each conversation: `<your folder>/<YYYY-MM-DD> <title> (<shortId>).md`

Contains:
- YAML frontmatter — `platform`, `conversation_id`, `title`, `url`,
  `created_at`, `updated_at`.
- One section per message, headed `## User · 2026-04-28 14:32` or
  `## Assistant · …`.

Plus one hidden metadata file: `<your folder>/.miyo-capture.json` —
identifies the source (chatgpt / claude / …) and tracks which
conversations have been captured.

## Development

```bash
npm install
npm run build              # builds to ./dist
npm run build:watch        # rebuild on change
npm run typecheck
```

Then load `./dist` as an unpacked extension in `chrome://extensions`
(Developer mode → Load unpacked).

To package for distribution:

```bash
npm run package            # produces miyo-capture-<version>-chrome.zip
```

Adding a new site? Read
[docs/ADAPTER-API.md](docs/ADAPTER-API.md) and
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
