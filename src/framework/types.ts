// Cross-cutting types shared by the framework, adapters, and UI.

export type SiteId = string;

export interface SiteSession {
  signedIn: boolean;
  email: string | null;
}

export interface ConversationListItem {
  id: string;
  title: string;
  updated_at: string; // ISO 8601
}

export interface ConversationListPage {
  items: ConversationListItem[];
  next_cursor: string | null;
  // Best estimate of total conversations available, if the site reports
  // it. Used purely to drive progress UI; null when unknown.
  total: number | null;
}

export type RawRole = 'user' | 'assistant' | 'system' | 'tool';

export interface RawMessage {
  role: RawRole;
  text: string;
  created_at: string | null;
}

export interface RawConversation {
  site: SiteId;
  conversation_id: string;
  title: string;
  url: string;
  created_at: string | null;
  updated_at: string | null;
  messages: RawMessage[];
}

// Implemented by `adapters/<site>.ts`. Adapters are pure: they fetch
// data and normalize it. They never touch the file system, never decide
// when to run, and never pace themselves — the framework owns those.
export interface SiteAdapter {
  id: SiteId;
  label: string;

  // Subdirectory under the user's library directory where this site's
  // markdown files are written. Conventionally `<id>/`.
  subdir: string;

  // Returns user identity if signed in, null if not. Must not throw on
  // a logged-out browser — return null instead.
  probeSession(): Promise<SiteSession>;

  // One page of the user's conversation list, sorted newest-first.
  // `cursor` is opaque to the framework; the adapter encodes whatever
  // pagination scheme the site uses (offset, page token, …).
  listConversations(cursor: string | null): Promise<ConversationListPage>;

  // A single conversation in normalized form. Throws on hard failure;
  // the framework decides whether to retry or skip based on the error
  // shape (see framework/sync.ts).
  fetchConversation(id: string): Promise<RawConversation>;
}

// Per-site, per-installation persistent state. Survives browser
// restarts. Stored in chrome.storage.local under `state:<siteId>`.
export interface SiteState {
  // Highest `updated_at` we have successfully synced. Drives delta
  // sync — we only fetch conversations newer than this on subsequent
  // runs. Null before the first successful sync.
  cursor_updated_at: string | null;

  // Map from conversation_id → on-disk filename. Lets us rename the
  // file when the title changes between syncs without leaving an
  // orphan under the old name.
  filenames: Record<string, string>;

  // Last sign-in probe result, cached for popup display so the popup
  // doesn't have to wait for a network call to render.
  last_session: SiteSession | null;
  last_probe_at: number | null;

  // Last sync outcome, used by the popup empty-state and error
  // surfaces.
  last_sync_at: number | null;
  last_sync_error: string | null;
}

// In-progress sync state. Stored in chrome.storage.local under
// `progress:<siteId>` and cleared once the sync finishes (or
// permanently aborts).
//
// Persisting progress means a service-worker kill mid-sync resumes
// from the right cursor on the next user click — we never re-fetch
// conversations we have already written.
export interface SyncProgress {
  started_at: number;
  total: number | null;
  completed: number;
  // The list cursor we are currently consuming. Null when starting
  // from the newest page.
  list_cursor: string | null;
  // IDs from the current list page that have not yet been fetched.
  // Drained one by one with rate-limited fetches.
  pending_ids: string[];
  // Soft errors collected mid-sync. We keep going and surface them
  // at the end rather than aborting on the first failure.
  errors: Array<{ conversation_id: string; message: string }>;
  // True once we have walked off the end of the list. The next
  // pending_ids drain finishes the sync.
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
