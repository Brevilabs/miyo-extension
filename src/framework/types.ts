// Cross-cutting types shared by the framework, adapters, and UI.

export type SiteId = string;

export interface SiteSession {
  signedIn: boolean;
  email: string | null;
}

export interface ListItem {
  id: string;
  // ISO 8601. Used by the framework for delta-sync cursor logic. The
  // adapter must return list pages sorted newest-first.
  updated_at: string;
}

export interface ItemListPage {
  items: ListItem[];
  // Opaque cursor passed back to listItems(); null means no further
  // pages. Adapters encode whatever pagination scheme the site uses
  // (offset, page token, …).
  next_cursor: string | null;
  // Best estimate of total items, if the site reports it. Drives
  // progress UI; null when unknown.
  total: number | null;
}

// What an adapter returns from fetchItem. The framework writes this
// directly to disk under <library>/<adapter.subdir>/<filename>.
//
// The adapter owns both the filename and the body. This is deliberate:
// different sites express different things (chat conversations,
// documents, bookmarks, emails, RSS items, …) and a single
// framework-imposed format would misrepresent some of them. Adapters
// decide what their data looks like as markdown.
//
// `filename` MUST be deterministic: the same item id must always
// produce the same filename for a given content state, so re-fetches
// overwrite cleanly and the framework can detect filename changes
// (title rename, etc.) by diffing against the persisted filenames map.
export interface RenderedItem {
  filename: string;
  body: string;
}

// Implemented by `adapters/<site>.ts`. Adapters are pure: they fetch
// data and render it. They never touch the file system, never decide
// when to run, and never pace themselves — the framework owns those
// concerns.
export interface SiteAdapter {
  id: SiteId;
  label: string;

  // Subdirectory under the user's library directory where this
  // adapter writes files. Conventionally `<id>/`.
  subdir: string;

  // Returns user identity if signed in, never throws on a logged-out
  // browser — return { signedIn: false } instead.
  probeSession(): Promise<SiteSession>;

  // One page of item refs, sorted newest-first. The framework stops
  // paging once it sees an updated_at <= the last successful sync's
  // cursor.
  listItems(cursor: string | null): Promise<ItemListPage>;

  // Fetches one item and renders it as markdown. The adapter chooses
  // both the filename and the body. Throws on hard failure; the
  // framework classifies (FatalError 401/403 → signed_out; everything
  // else → per-item error logged, sync continues).
  //
  // The framework provides utilities the adapter MAY use:
  //   - framework/filename.ts (sanitizeTitleForFilename, shortenId,
  //     makeDatePrefixedFilename)
  //   - framework/markdown.ts (escapeYaml, formatTimestamp)
  //   - framework/chat.ts (renderChatConversationMarkdown — for chat
  //     adapters specifically)
  fetchItem(id: string): Promise<RenderedItem>;
}

// Per-site, per-installation persistent state. Survives browser
// restarts. Stored in chrome.storage.local under `state:<siteId>`.
export interface SiteState {
  // Highest `updated_at` we have successfully synced. Drives delta
  // sync — we only fetch items newer than this on subsequent runs.
  // Null before the first successful sync.
  cursor_updated_at: string | null;

  // Map from item id → on-disk filename. Lets us rename the file when
  // the adapter's filename derivation changes (e.g. title rename)
  // without leaving an orphan under the old name.
  filenames: Record<string, string>;

  // Last sign-in probe result, cached for popup display so it doesn't
  // wait on a network call to render.
  last_session: SiteSession | null;
  last_probe_at: number | null;

  // Last sync outcome.
  last_sync_at: number | null;
  last_sync_error: string | null;
}

// In-progress sync state. Stored in chrome.storage.local under
// `progress:<siteId>` and cleared once the sync finishes or
// permanently aborts. Persisting this means a service-worker kill
// mid-sync resumes from the right spot on the next user click.
export interface SyncProgress {
  started_at: number;
  total: number | null;
  completed: number;
  list_cursor: string | null;
  pending_ids: string[];
  errors: Array<{ item_id: string; message: string }>;
  list_exhausted: boolean;
}

export type LibraryAccess =
  | { state: 'unset' }
  | { state: 'granted' }
  | { state: 'permission_required' }
  | { state: 'unavailable'; reason: string };

export interface PopupSnapshot {
  library: LibraryAccess;
  sites: Array<{
    id: SiteId;
    label: string;
    session: SiteSession | null;
    last_sync_at: number | null;
    last_sync_error: string | null;
  }>;
  active_sync: {
    site: SiteId;
    completed: number;
    total: number | null;
  } | null;
}
