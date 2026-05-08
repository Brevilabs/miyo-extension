# Writing a site adapter

A site adapter teaches the extension how to talk to one site's
backend. The framework handles rate limiting, file writes, progress UI,
state persistence, and sync orchestration. An adapter only needs to
know:

1. How to probe whether the user is signed in.
2. How to list the user's conversations, paginated.
3. How to fetch one conversation in normalized form.

A typical adapter is ~150 lines. ChatGPT and Claude live in
[`src/adapters/`](../src/adapters/) — copy-paste from one of them as a
starting point.

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

  async listConversations(cursor) {
    // Newest-first. The framework stops paging once it sees an
    // updated_at older than the last successful sync, so monotonic
    // ordering is required.
    return {
      items: [{ id: '...', title: '...', updated_at: '2026-05-08T...' }],
      next_cursor: null,
      total: 42,
    };
  },

  async fetchConversation(id) {
    return {
      site: 'mysite',
      conversation_id: id,
      title: '...',
      url: 'https://mysite.example/c/' + id,
      created_at: '2026-05-08T...',
      updated_at: '2026-05-08T...',
      messages: [
        { role: 'user', text: '...', created_at: '...' },
        { role: 'assistant', text: '...', created_at: '...' },
      ],
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

## What the framework does for you

- **Pacing.** Every adapter call goes through a per-site rate limiter
  with a 1.5s floor between requests. You cannot opt out — this is
  structural, not advisory. Throw `RetryableError` (or let
  `classifyHttp(res, label)` do it for you on 429/5xx) and pacing
  applies an exponential backoff.

- **File writes.** Don't touch the file system. Return a
  `RawConversation` from `fetchConversation` and the framework picks
  a deterministic filename, renders markdown with YAML frontmatter,
  and writes it.

- **Idempotency.** Filenames are derived from `conversation_id`, so
  re-fetching a conversation overwrites the existing file. Title
  changes trigger a write-then-delete rename so a crash in between
  leaves a duplicate, never a missing file.

- **Resume on crash.** Sync progress is persisted after every
  successful write. If the service worker dies mid-sync, the user's
  next click resumes from `pending_ids` instead of restarting.

- **Cursor.** The framework remembers the highest `updated_at` it has
  seen and skips older items on subsequent syncs. The cursor only
  advances on a fully-completed run.

## Things to get right

- **`updated_at` must be monotonically decreasing in your list pages.**
  The framework uses the first item with `updated_at <= cursor` as a
  signal that the rest of the list is also old, and stops paging.
  If your site's list is unordered, sort it client-side before
  returning.

- **`probeSession` must not throw.** A signed-out user is a normal
  state, not an error. Return `{ signedIn: false, email: null }`.

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
