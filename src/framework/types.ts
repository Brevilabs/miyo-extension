// Cross-cutting types shared by the framework, adapters, and UI.

import type { ChatConversation } from './chat.js';

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
// `body` to the writer with the given `filename`.
//
// `filename` MUST be deterministic: the same item id with the same
// content state must always produce the same filename, so re-writes
// overwrite cleanly.
export interface RenderedItem {
  filename: string;
  body: string;
}

// Common adapter surface shared by both kinds.
interface BaseSiteAdapter {
  id: SiteId;
  label: string;

  // The site's home page; used for "open ChatGPT" / "open Claude"
  // affordances and recorded in the destination folder's
  // .miyo-capture.json for tools that consume the folder.
  home_url: string;

  // Optional display metadata recorded in the destination folder's
  // .miyo-capture.json so any consumer (Miyo Desktop, future tools)
  // can render the source without a hardcoded list.
  brand_color?: string; // hex, e.g. "#10a37f"
  icon_data_url?: string; // inline SVG as a data: URL

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
// chat output uniform across every chat provider so a captured folder
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

// Per-site, per-installation persistent state in chrome.storage.local
// under `state:<siteId>`. Survives browser restarts.
//
// Note: the captures map (which conversations have been written) is
// NOT here — it lives in .miyo-capture.json inside the destination
// folder, which is the source of truth for dedup. SiteState only
// holds things that don't belong in the destination folder.
export interface SiteState {
  // Highest `updated_at` we have successfully synced (only advances
  // when a sync run finishes; partial runs leave it unchanged).
  // SyncProgress.pending_items handles intra-run resumability.
  //
  // Mirrors sync.cursor_updated_at in .miyo-capture.json. On Chrome
  // the meta file is authoritative; on Firefox/Safari (downloads-only,
  // no read-back) this is the only record.
  cursor_updated_at: string | null;

  // Last sign-in probe, cached for popup display so it doesn't wait
  // on a network call to render.
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
  // Each entry carries the item's own updated_at so the captures map
  // in .miyo-capture.json records per-item timestamps faithfully,
  // rather than the page-max running watermark.
  pending_items: Array<{ id: string; updated_at: string }>;
  errors: Array<{ item_id: string; message: string }>;
  list_exhausted: boolean;
}

// Per-site row in the popup. Composes config (enabled / paused /
// destination), state (session, last sync), and folder-derived info
// (capture count from meta).
export interface SiteRowSnapshot {
  id: SiteId;
  label: string;
  home_url: string;

  // Config
  enabled: boolean;
  paused: boolean;
  destination_kind: 'folder' | 'downloads' | null;
  destination_label: string | null; // e.g. "Notes/ChatGPT" or "~/Downloads/Miyo Captures/ChatGPT"
  destination_missing: boolean; // handle gone from IndexedDB — destination must be re-picked
  destination_needs_reauth: boolean; // handle present but permission not granted this session

  // Folder-derived (null on downloads-only browsers where we can't read)
  captures_count: number | null;

  // Session + sync history
  session: SiteSession | null;
  last_sync_at: number | null;
  last_sync_error: string | null;
}

export interface PopupSnapshot {
  sites: SiteRowSnapshot[];
  active_sync: {
    site: SiteId;
    completed: number;
    total: number | null;
  } | null;
}
// Note: showDirectoryPicker capability is checked in the popup (window
// context), not here — the background service worker is a
// ServiceWorkerGlobalScope and never has the API regardless of browser.
