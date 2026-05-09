# Writing a site adapter

A site adapter teaches the extension how to talk to one site's
backend. The framework handles rate limiting, file writes, progress
UI, state persistence, and sync orchestration.

There are two kinds of adapter, picked based on your site's data
shape:

- **Chat adapter** (`kind: 'chat'`) — submit a normalized
  `ChatConversation`. The framework derives the filename and renders
  the markdown using one shared chat layout. ChatGPT and Claude are
  chat adapters; future Gemini, Grok, etc. should be too. **Why this
  exists:** every chat provider in a user's library should produce
  the same markdown layout so the library reads as one corpus rather
  than per-vendor formats.

- **Custom adapter** (`kind: 'custom'`) — submit a `RenderedItem`
  (`{ filename, body }`). Used for sites whose data is not chat:
  notes, bookmarks, documents, emails, RSS items. The adapter chooses
  both the filename and the markdown body.

A typical chat adapter is ~150 lines (mostly fetching and shape
normalization). ChatGPT and Claude live in
[`src/adapters/`](../src/adapters/) — copy-paste from one of them.

## Chat adapter

```ts
import type { ChatSiteAdapter } from '../framework/types.js';
import type { ChatConversation } from '../framework/chat.js';

export const myAdapter: ChatSiteAdapter = {
  id: 'mysite',
  label: 'MySite',
  subdir: 'mysite',
  kind: 'chat',

  async probeSession() {
    return { signedIn: true, email: 'user@example.com' };
  },

  async listItems(cursor) {
    // Newest-first by updated_at. The framework stops paging on the
    // first item with updated_at <= the last successful sync's
    // cursor.
    return {
      items: [{ id: 'abc', updated_at: '2026-05-09T12:00:00Z' }],
      next_cursor: null,
      total: 1,
    };
  },

  async fetchConversation(id): Promise<ChatConversation> {
    return {
      site: 'mysite',
      conversation_id: id,
      title: 'My conversation',
      url: 'https://mysite.example/c/' + id,
      created_at: '2026-05-09T11:30:00Z',
      updated_at: '2026-05-09T12:00:00Z',
      messages: [
        { role: 'user', text: 'Hello', created_at: '2026-05-09T11:30:00Z' },
        { role: 'assistant', text: 'Hi', created_at: '2026-05-09T11:30:05Z' },
      ],
    };
  },
};
```

## Custom adapter

```ts
import type { CustomSiteAdapter } from '../framework/types.js';
import { makeDatePrefixedFilename } from '../framework/filename.js';

export const bookmarksAdapter: CustomSiteAdapter = {
  id: 'bookmarks',
  label: 'Bookmarks',
  subdir: 'bookmarks',
  kind: 'custom',

  async probeSession() { /* … */ },
  async listItems(cursor) { /* … */ },

  async fetchItem(id) {
    const data = await fetchFromYourSite(id);
    return {
      filename: makeDatePrefixedFilename({
        id,
        title: data.title,
        createdAt: data.added_at,
      }),
      body: [
        '---',
        `site: bookmarks`,
        `url: ${data.url}`,
        `added_at: ${data.added_at}`,
        '---',
        '',
        `# ${data.title}`,
        '',
        data.excerpt ?? '',
      ].join('\n'),
    };
  },
};
```

## Registration

Both kinds register the same way. Add to `src/adapters/index.ts`:

```ts
export const ADAPTERS: SiteAdapter[] = [chatgptAdapter, claudeAdapter, myAdapter];
```

And add the host(s) to `public/manifest.json` under
`host_permissions`.

## Framework helpers (for custom adapters)

You don't have to use any of these — your custom adapter is free to
render markdown however it wants. They exist so adapters that want to
share conventions can.

- **[`framework/filename.ts`](../src/framework/filename.ts)**
  - `sanitizeTitleForFilename(title)` — strips filesystem-unsafe
    chars, collapses whitespace, caps at 80 chars.
  - `shortenId(id, length=8)` — alphanumeric-only short suffix.
  - `makeDatePrefixedFilename({id, title, createdAt})` —
    `YYYY-MM-DD <title> (<shortId>).md`. Used internally by chat
    rendering; available to custom adapters that want the same look.

- **[`framework/markdown.ts`](../src/framework/markdown.ts)**
  - `escapeYaml(str)` — quote-safe YAML scalar.
  - `formatTimestamp(iso)` — `YYYY-MM-DD HH:mm` UTC.

- **[`framework/rate-limit.ts`](../src/framework/rate-limit.ts)**
  - `classifyHttp(res, label)` — maps a fetch Response to
    `RetryableError` (429/5xx) or `FatalError` (401/403/other 4xx).
    The framework pacer interprets `RetryableError` as "back off
    next call"; the sync orchestrator interprets `FatalError`
    401/403 as "user is signed out, abort run".

## What the framework does for you

- **Pacing.** Every adapter call goes through a per-site rate
  limiter with a 1.5s floor between requests. You cannot opt out.

- **File writes.** Don't touch the file system. The framework writes
  the body (chat-rendered or custom-rendered) to
  `<library>/<adapter.subdir>/<filename>`.

- **Idempotency and renames.** Same item id with same content state
  must produce the same filename. Re-fetches overwrite the existing
  file. If your filename derivation produces a different value
  (typically a title rename), the framework writes the new file then
  deletes the old one — a crash in between leaves a duplicate, never
  a missing file.

- **Resume on crash.** Sync progress is persisted after every
  successful write. If the service worker dies mid-sync, the user's
  next click resumes from `pending_ids` instead of restarting.

- **Cursor.** The framework remembers the highest `updated_at` it
  has seen and skips older items on subsequent syncs. The cursor
  only advances on a fully-completed run.

## Things to get right

- **List items must be newest-first by `updated_at`.** Required for
  the framework's early-termination optimization.

- **`probeSession` must not throw.** Signed-out is a normal state.
  Return `{ signedIn: false, email: null }`.

- **Filename must be deterministic.** Two different `id`s should
  almost never produce the same filename (use a short id suffix).
  The same `id` with the same content should always produce the
  same filename.

- **Don't cache without storage.** Service workers die. Use
  `chrome.storage.session` for caches that should survive SW
  restarts within a browser session, and `chrome.storage.local`
  across browser restarts. See `chatgpt.ts` for the access-token
  cache pattern.

- **No background timers.** Don't add `chrome.alarms`, don't set
  intervals. Sync runs only when the user clicks Sync now. The whole
  product posture depends on this.

- **No data leaves the user's machine.** Don't add telemetry,
  analytics, or "feedback" pings. The extension is local-only by
  design.
