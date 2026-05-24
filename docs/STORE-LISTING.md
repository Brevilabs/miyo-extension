# Chrome Web Store listing

Source of truth for the Chrome Web Store submission. Keep this in sync
with the popup copy, the manifest `description`, and the README.

Privacy policy URL: <https://www.miyo.md/extension/privacy>

## Short summary (≤132 chars — manifest `description` / store "Summary")

```
Capture your ChatGPT and Claude conversations as markdown and export them as a ZIP. Yours, on your machine.
```

## Detailed description (store listing body)

```
Miyo Capture saves your ChatGPT and Claude conversations as clean markdown files — so your AI chats are yours to keep, search, and own.

Pick a time range, click Download, and the extension gathers your matching conversations and hands you a single ZIP of markdown files, one conversation per file, straight to your Downloads folder. That's it. No accounts, no cloud, no setup.

— HOW IT WORKS —
1. Open the popup. You'll see a card for each supported site (ChatGPT and Claude).
2. Make sure you're signed in to the site in a tab.
3. Choose a time range — last 24 hours, 7 days, 30 days, 90 days, all available, or a custom date window.
4. Click Download to get a ZIP of the matching conversations as markdown.

— WHAT'S CAPTURED —
• ChatGPT — full conversation history: titles, timestamps, and messages.
• Claude (claude.ai) — full conversation history.

Each conversation is saved as its own file — the full back-and-forth, organized turn by turn, with the title, original link, and dates kept neatly at the top.

— PRIVATE BY DESIGN —
• Local only. Your conversations are read and packaged entirely on your device and downloaded straight to your computer. Nothing is ever sent to us or to any server.
• No tracking. Zero analytics, zero telemetry, no third parties, no ads.
• No background activity. The extension only does anything when you click Download — it never runs on a timer or in the background.
• Minimal permissions. It can only access ChatGPT and Claude, and only to fetch your own conversations.

— NO LOCK-IN —
The output is plain markdown. Open it in Obsidian, Logseq, your text editor, or search it with grep. Any tool that reads files can read your archive.

— FROM THE MAKERS OF MIYO —
Miyo Capture is made by Miyo, your personal context hub. The conversations you export here become part of a local, searchable memory that any AI can use — so ChatGPT can pick up what you told Claude yesterday, and vice versa. Miyo Desktop keeps everything as plain files on your own computer (no cloud uploads) and connects to ChatGPT and Claude over MCP. It's a separate, optional, free app. Make it your own at https://www.miyo.md

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
- Host `chatgpt.com` — Fetches the signed-in user's own ChatGPT
  conversation history, on their explicit click, to export it as markdown.
- Host `claude.ai` — Fetches the signed-in user's own Claude conversation
  history, on their explicit click, to export it as markdown.
- Remote code — **No, I am not using remote code** (everything is bundled).

**Data collected (disclose; the extension accesses but never transmits these):**

- Personal communications (conversation content)
- Website content

**Certifications:** not sold to third parties; used only for the single
purpose above; not used to determine creditworthiness — all true, in line
with the Chrome Web Store Limited Use policy.
