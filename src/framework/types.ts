// Cross-cutting types shared by the framework, adapters, and UI.

import type { ChatConversation } from './chat.js';
import type { TransportSnapshot } from './transports/index.js';

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

// What a custom adapter returns from fetchItem. The framework forwards
// `body` to the active transport with the given `filename`.
//
// `filename` MUST be deterministic: the same item id with the same
// content state must always produce the same filename, so re-deliveries
// overwrite cleanly.
export interface RenderedItem {
  filename: string;
  body: string;
}

// Common adapter surface shared by both kinds.
interface BaseSiteAdapter {
  id: SiteId;
  label: string;

  // Subdirectory hint used by the downloads transport
  // (Downloads/Miyo/<subdir>/...) and as a documentation aid for
  // Miyo's per-source destination convention. Conventionally `<id>/`.
  subdir: string;

  // Returns user identity if signed in. Never throws on a logged-out
  // browser — return { signedIn: false } instead.
  probeSession(): Promise<SiteSession>;

  // One page of item refs, sorted newest-first. The framework stops
  // paging once it sees an updated_at <= the last successful sync's
  // cursor.
  listItems(cursor: string | null): Promise<ItemListPage>;
}

// Chat-shaped adapter. Submits a normalized ChatConversation; the
// framework derives the filename and renders the markdown. This keeps
// chat output uniform across every chat provider so a Miyo library
// reads as one corpus rather than per-vendor formats.
export interface ChatSiteAdapter extends BaseSiteAdapter {
  kind: 'chat';
  fetchConversation(id: string): Promise<ChatConversation>;
}

// Custom adapter. Owns its own filename and markdown body. Used for
// sites whose data is not chat-shaped (notes, bookmarks, documents,
// emails, RSS items).
export interface CustomSiteAdapter extends BaseSiteAdapter {
  kind: 'custom';
  fetchItem(id: string): Promise<RenderedItem>;
}

export type SiteAdapter = ChatSiteAdapter | CustomSiteAdapter;

// Per-site, per-installation persistent state. Survives browser
// restarts. Stored in chrome.storage.local under `state:<siteId>`.
export interface SiteState {
  // Highest `updated_at` we have successfully synced. Drives delta
  // sync — we only fetch items newer than this on subsequent runs.
  // Null before the first successful sync.
  cursor_updated_at: string | null;

  // Map from item id → last-delivered filename.
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
// permanently aborts.
export interface SyncProgress {
  started_at: number;
  total: number | null;
  completed: number;
  list_cursor: string | null;
  pending_ids: string[];
  errors: Array<{ item_id: string; message: string }>;
  list_exhausted: boolean;
}

export interface PopupSnapshot {
  transports: TransportSnapshot;
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
