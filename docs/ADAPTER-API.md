# Writing a site adapter

A site adapter teaches the extension how to talk to one site's
backend AND how to render that site's data as markdown. The framework
handles rate limiting, file writes, progress UI, state persistence,
and sync orchestration; the adapter handles everything content-shaped.

The adapter owns rendering on purpose. Different sites express
different things — chat conversations, documents, bookmarks, emails,
RSS items — and one-size-fits-all formatting would misrepresent some
of them. The framework provides shared building blocks (filename
helpers, YAML escape, chat-conversation renderer) but does not
require any particular content shape.

A typical chat-shaped adapter is ~150 lines. ChatGPT and Claude live
in [`src/adapters/`](../src/adapters/) — copy-paste from one of them
as a starting point.

## The contract

```ts
import type { SiteAdapter } from '../framework/types.js';

export const myAdapter: SiteAdapter = {
  id: 'mysite',
  label: 'MySite',
  subdir: 'mysite',

  async probeSession() {
    // Hit a small "who am I" endpoint. Return signedIn:false on
    // 401/403 or any error — never throw.
    return { signedIn: true, email: 'user@example.com' };
  },

  async listItems(cursor) {
    // Newest-first by `updated_at`. The framework stops paging once
    // it sees an updated_at older than the last successful sync, so
    // monotonic ordering is required.
    return {
      items: [{ id: '...', updated_at: '2026-05-08T12:34:56Z' }],
      next_cursor: null,
      total: 42,
    };
  },

  async fetchItem(id) {
    // Adapter owns: data fetch + filename + markdown body.
    // Return whatever markdown layout makes sense for your site.
    return {
      filename: '2026-05-08 My Item (abc12345).md',
      body: '---\nsite: mysite\n---\n\n# My Item\n\n…',
    };
  },
};
```

Then add it to `src/adapters/index.ts`:

```ts
import { myAdapter } from './mysite.js';
export const ADAPTERS: SiteAdapter[] = [chatgptAdapter, claudeAdapter, myAdapter];
```

And add the host(s) to `public/manifest.json` under `host_permissions`.

## Framework helpers

You don't have to use any of these — your adapter is free to render
markdown however it wants. They exist so adapters that want to share
conventions can.

- **[`framework/filename.ts`](../src/framework/filename.ts)**
  - `sanitizeTitleForFilename(title)` — strips filesystem-unsafe
    chars, collapses whitespace, caps at 80 chars.
  - `shortenId(id, length=8)` — alphanumeric-only short suffix.
  - `makeDatePrefixedFilename({id, title, createdAt})` — produces
    `YYYY-MM-DD <title> (<shortId>).md`. The chat adapters use this
    so all chat files in a Miyo library look uniform.

- **[`framework/markdown.ts`](../src/framework/markdown.ts)**
  - `escapeYaml(str)` — quote-safe YAML scalar.
  - `formatTimestamp(iso)` — `YYYY-MM-DD HH:mm` UTC for use in
    section headers.

- **[`framework/chat.ts`](../src/framework/chat.ts)**
  - `renderChatConversationMarkdown(conv)` — full chat-style render
    (frontmatter + `# Title` + `## Role · timestamp` per message).
    Use this if your site's data is chat-shaped; ignore it
    otherwise.

- **[`framework/rate-limit.ts`](../src/framework/rate-limit.ts)**
  - `classifyHttp(res, label)` — maps a fetch Response to
    `RetryableError` (429/5xx) or `FatalError` (401/403/other 4xx).
    The framework's pacer interprets `RetryableError` as "back off
    next call"; the sync orchestrator interprets `FatalError`
    401/403 as "user is signed out, abort run".

## What the framework does for you

- **Pacing.** Every adapter call goes through a per-site rate limiter
  with a 1.5s floor between requests. You cannot opt out.

- **File writes.** Don't touch the file system. Return a filename and
  body from `fetchItem`; the framework writes the body to
  `<library>/<adapter.subdir>/<filename>`.

- **Idempotency and renames.** Filenames must be deterministic for a
  given content state — same item id always maps to the same
  filename when content is unchanged. Re-fetches overwrite the
  existing file. If your filename derivation produces a different
  value (typically a title rename), the framework writes the new
  file then deletes the old one — a crash in between leaves a
  duplicate, never a missing file.

- **Resume on crash.** Sync progress is persisted after every
  successful write. If the service worker dies mid-sync, the user's
  next click resumes from `pending_ids` instead of restarting.

- **Cursor.** The framework remembers the highest `updated_at` it has
  seen and skips older items on subsequent syncs. The cursor only
  advances on a fully-completed run.

## Things to get right

- **List items must be newest-first by `updated_at`.** The framework
  uses the first item with `updated_at <= cursor` as a signal that
  the rest of the list is also old, and stops paging. If your site's
  list is unordered, sort it client-side before returning.

- **`probeSession` must not throw.** A signed-out user is a normal
  state, not an error. Return `{ signedIn: false, email: null }`.

- **Filename must be deterministic.** Two different `id`s should
  almost never produce the same filename (use a short id suffix).
  The same `id` with the same content state should always produce
  the same filename, so re-fetches overwrite cleanly.

- **Don't cache without storage.** Service workers die. In-memory
  caches don't survive. Use `chrome.storage.session` for things you
  want to keep across SW restarts within a browser session, and
  `chrome.storage.local` for things you want across browser
  restarts. See `chatgpt.ts` for the access-token cache pattern.

- **No background timers.** Don't add `chrome.alarms`, don't set
  intervals. Sync runs only when the user clicks Sync now. The whole
  product posture depends on this.

- **No data leaves the user's machine.** Don't add telemetry,
  analytics, or "feedback" pings. The extension is local-only by
  design.

## Non-chat adapters

The contract is intentionally content-agnostic. A bookmark adapter
might emit:

```md
---
site: bookmarks
url: https://...
added_at: 2026-05-08T...
tags: [research, ml]
---

# Page title

> Description / excerpt
```

A document adapter might emit a single `# Title` followed by the
document body. An email adapter might emit
`From / To / Subject` frontmatter and the body. The framework does
not care — it just writes whatever string you return.

The only durable convention is the filename pattern: stable across
re-fetches so writes are idempotent, and roughly date-prefixed so
files sort sensibly in a directory listing. Most adapters will get
this for free by using `makeDatePrefixedFilename`.
