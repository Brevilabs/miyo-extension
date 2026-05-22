# Miyo Capture

> Capture your AI chats as markdown. Yours, on your machine.

A browser extension that turns your **ChatGPT** and **Claude**
conversations into markdown files. No accounts, no servers in the
cloud, no telemetry.

It runs in two modes, depending on what you have installed:

- **With [Miyo desktop](https://www.miyo.md/)** — captures stream
  directly into your Miyo library as you click Capture. Miyo handles
  storage, dedup, and search.
- **Without Miyo** — captures buffer in the extension, then download
  as a single ZIP of markdown files to your Downloads folder. One
  conversation per file.

The output is plain markdown — open it in **Obsidian**, **Logseq**,
your editor, or `grep`. Nothing locks you in.

## Install

- **Browser extension store** — *coming soon.*
- **From a release artifact** — grab the latest
  `miyo-capture-<version>-chrome.zip` from
  [Releases](https://github.com/Brevilabs/miyo-sync/releases),
  unzip it, then in `chrome://extensions` enable Developer mode
  and click **Load unpacked** on the unzipped folder.

## How it works

1. Open the popup. You'll see one card per supported site
   (ChatGPT, Claude).
2. Sign in to the site in a tab (if you aren't already).
3. Pick a time range (last 7 days, 30 days, all available, or a
   custom window).
4. Click **Capture to Miyo** (if Miyo desktop is running) or
   **Download** (to get a ZIP).

The header shows a Miyo toggle when the desktop app is reachable on
`http://127.0.0.1:8742`. Turn it off to force ZIP mode even with
Miyo running.

## What's captured

- **ChatGPT** — full conversation history (titles, timestamps,
  messages).
- **Claude (claude.ai)** — full conversation history.

More sources are planned. Each is a single adapter file — see
[docs/ADAPTER-API.md](docs/ADAPTER-API.md).

## Design

- **Sync only when you click.** No background polling, no alarms,
  no service-worker timers. Every fetch is a direct consequence of
  you pressing Capture.
- **Local only.** Conversation data goes to your Downloads folder
  (ZIP mode) or your Miyo desktop app (Miyo mode). It never leaves
  your machine.
- **Zero runtime dependencies, zero telemetry.** The extension
  ships no analytics and no feedback pings.
- **Pause and resume.** A capture can be paused mid-run and
  resumed later from the same cursor — useful for large histories.
- **No lock-in.** The output is plain markdown. Any tool that
  reads files can consume it.

## Browser support

Chromium-based browsers only for now: **Chrome, Edge, Brave, Arc**,
and other Chromium variants. Firefox and Safari are planned.

## Output format

Each conversation becomes one markdown file:

```
<YYYY-MM-DD> <title> (<shortId>).md
```

In ZIP mode the archive is named
`miyo-capture-<site>-<YYYY-MM-DD>.zip`. In Miyo mode the file lands
in the Miyo-managed folder for that site.

Each file contains:

- **YAML frontmatter** — `platform`, `conversation_id`, `title`,
  `url`, `created_at`, `updated_at`.
- **`# Title`** — the conversation title as an H1.
- **One `## Turn · <timestamp>` section per conversational turn** —
  a user prompt and the assistant replies that follow it stay
  grouped in one section. Inside each turn, individual messages
  are introduced by a bold `**User · <timestamp>**` or
  `**Assistant · <timestamp>**` line — not a heading — so the turn
  remains one section for downstream chunkers.

## Development

```bash
npm install
npm run build              # builds to ./dist
npm run build:watch        # rebuild on change
npm run typecheck
npm run lint
npm run test:unit
```

Then load `./dist` as an unpacked extension in `chrome://extensions`
(Developer mode → Load unpacked).

To package for distribution:

```bash
npm run package            # produces miyo-capture-<version>-chrome.zip
```

Adding a new site? Read
[docs/ADAPTER-API.md](docs/ADAPTER-API.md) and
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). The Miyo desktop
protocol is documented in [docs/MIYO_INTERFACE.md](docs/MIYO_INTERFACE.md).

## License

MIT — see [LICENSE](LICENSE).
