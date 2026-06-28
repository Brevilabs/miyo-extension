# Chrome Web Store listing

Source of truth for the Chrome Web Store submission. Keep this in sync
with the popup copy, the manifest `description`, and the README.

Privacy policy URL: <https://www.miyo.md/extension/privacy>

## Short summary (≤132 chars — manifest `description` / store "Summary")

```
Auto-sync your ChatGPT and Claude chats to local markdown files. Yours on your machine, never the cloud.
```

## Detailed description (store listing body)

```
Miyo Capture saves your ChatGPT and Claude conversations as clean markdown files on your own computer, so you can keep and search them with any tool you already use.

Most export tools make you click Download every time. Miyo Capture can do that too. But it can also do something most of them can't: paired with the free Miyo Desktop app, it syncs your conversations to plain files on your computer automatically, while you keep chatting. You don't have to re-export or remember to back anything up.

🔄 AUTOMATIC SYNC (THE DIFFERENCE)
Turn on "Sync to Miyo Desktop" and that's it. New ChatGPT and Claude conversations save themselves into a folder on your computer and stay up to date in the background, with no clicking and nothing going to the cloud. Each chat becomes its own markdown file. It's one-way and read-only: Miyo only reads your conversations and saves them to your computer, and never changes anything on ChatGPT or Claude. (You'll need the free Miyo Desktop app, and the sync stays entirely on your machine.)

⬇️ OR JUST GRAB A ZIP (NO SETUP)
Don't want to install anything? Pick a time range and click Download. The extension gathers the matching conversations and hands you a single ZIP of markdown files, one per conversation, straight to your Downloads folder. There's no account to create and nothing to set up.
1. Open the popup. You'll see a card for each supported site (ChatGPT and Claude).
2. Make sure you're signed in to the site in a tab.
3. Choose a time range: last 24 hours, 7 days, 30 days, 90 days, everything available, or a custom date window.
4. Click Download to get a ZIP of the matching conversations as markdown.

💬 WHAT'S CAPTURED
• ChatGPT: your full conversation history, including titles, timestamps, and messages.
• Claude (claude.ai): your full conversation history.

Each conversation becomes its own file with the full back and forth, organized turn by turn. The title, original link, and dates sit at the top.

🔒 PRIVATE BY DESIGN
• Local only. Your conversations are read and saved on your own device, either exported to your Downloads or synced to a folder by the local Miyo Desktop app. Nothing is ever sent to us or to any remote server.
• No tracking. The extension has no analytics, no telemetry, and no ads.
• Opt-in sync. Automatic sync stays off until you turn it on. When it's on, it hands your session only to the Miyo Desktop app on the same computer. The extra permission it needs is requested when you enable it, and turning the toggle off stops the handoff.
• Minimal permissions. It only touches ChatGPT and Claude, and only to work with your own conversations.

📄 NO LOCK-IN
The output is plain markdown. Open it in Obsidian, Logseq, your text editor, or search it with grep. Any tool that reads files can read your archive.

🧠 FROM THE MAKERS OF MIYO
Miyo Capture is made by Miyo, your personal context hub. The conversations you save here can become part of a local, searchable memory that any AI can use, so ChatGPT can pick up what you told Claude yesterday, and the other way around. Miyo Desktop keeps everything as plain files on your own computer (no cloud uploads) and connects to ChatGPT and Claude over MCP. It's a separate, free app you don't have to use. Find it at https://www.miyo.md

Privacy policy: https://www.miyo.md/extension/privacy
```

## Category & metadata

- **Category:** Productivity
- **Language:** English

## Privacy practices tab (dashboard)

**Single purpose:**

```
Capture the user's own ChatGPT and Claude conversation history and export it as a ZIP of markdown files saved locally.
```

**Permission justifications:**

- `storage` — Stores the user's local preferences (selected time range)
  and resume bookkeeping so an interrupted capture can continue. Stored
  on-device only.
- `nativeMessaging` — Powers the optional "Sync to Miyo Desktop" feature.
  When the user enables it, the extension talks to the Miyo Desktop app
  installed on the same computer (native-messaging host `md.miyo.chatsync`)
  to hand off the session so the desktop app can keep the user's own chat
  history in sync. It only ever messages that one local host; the host
  fails closed when Miyo isn't installed or running. No network access.
- `alarms` — Schedules a periodic re-sync (every 30 minutes) for the
  optional "Sync to Miyo Desktop" feature so the desktop app keeps a fresh
  session. No alarms run for the core capture/export flow.
- `cookies` (OPTIONAL — requested only when the user turns on "Sync to
  Miyo Desktop") — Reads the user's existing ChatGPT and Claude session
  cookies so they can be handed to the local Miyo Desktop app for the
  opt-in sync. Cookies are read only for chatgpt.com and claude.ai, are
  passed only to the local desktop app over native messaging, and are
  never sent to any remote server. A default install never requests this
  permission, so users see no cookie warning unless they opt in.
- Host `chatgpt.com` — Fetches the signed-in user's own ChatGPT
  conversation history, on their explicit click, to export it as markdown.
- Host `claude.ai` — Fetches the signed-in user's own Claude conversation
  history, on their explicit click, to export it as markdown.
- Remote code — **No, I am not using remote code** (everything is bundled).

**Data collected (disclose; the extension accesses but never transmits to
us or any remote server):**

- Personal communications (conversation content)
- Website content
- Authentication information (ChatGPT / Claude session cookies — only when
  the user opts into "Sync to Miyo Desktop", and only to hand them to the
  local Miyo Desktop app)

**Certifications:** not sold to third parties; used only for the single
purpose above; not used to determine creditworthiness — all true, in line
with the Chrome Web Store Limited Use policy.
