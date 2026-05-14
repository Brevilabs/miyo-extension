// Cross-cutting types shared by the framework, adapters, and UI.
//
// The extension is intentionally stateless across runs. There is no
// persistent SiteState, SyncProgress, or per-item cache — each
// capture run is a fresh one-shot. The only data that persists is:
//   • Miyo mode: nothing locally. Miyo holds the index.
//   • Local mode: nothing locally. Files in the user's Downloads
//     folder are the source of truth; reruns overwrite cleanly.
// Small UI prefs (time_ranges, last_snapshot) still live in
// chrome.storage.local but never hold per-item state.

import type { ChatConversation } from './chat.js';

export type SiteId = string;

// Zip-mode capture range. Two shapes:
//   • Preset: a now-relative window. The upper bound is implicit
//     "now"; the lower bound is preset-defined. 'all' means no lower
//     bound — paginate until exhausted or the safety cap kicks in.
//   • Custom: an explicit [sinceISODate, untilISODate] window in the
//     user's local timezone (start-of-day for `since`, end-of-day for
//     `until`, both inclusive). Use the window form when filling a
//     gap from a previous run that stopped mid-way.
export type TimeRangePreset = '24h' | '7d' | '30d' | '90d' | 'all';

export type TimeRange =
  | { kind: 'preset'; preset: TimeRangePreset }
  | { kind: 'custom'; sinceISODate: string; untilISODate: string };

export const DEFAULT_TIME_RANGE: TimeRange = { kind: 'preset', preset: '30d' };

// At most one local-mode capture runs at a time. The record lives in
// chrome.storage.local so it survives browser restarts — the actual
// captured items live in IndexedDB (see framework/store.ts).
//
// Lifecycle:
//   capturing → SW is (or was) capturing. If SW isn't running it
//               now, the run is "paused"; the popup offers Resume.
//   ready     → capture loop finished. The popup zips IDB contents
//               and triggers a download, then clears both the
//               record and the IDB items.
export interface PendingRun {
  siteId: SiteId;
  range: TimeRange;
  started_at: number; // epoch ms
  status: 'capturing' | 'ready';
  written: number;
  errors: number;
}

export interface SiteSession {
  signedIn: boolean;
  email: string | null;
}

export interface ListItem {
  id: string;
  // ISO 8601. The framework compares this against Miyo's known
  // `updated_at` (or against the local cache) to decide whether a
  // conversation needs re-fetch. Adapters must return list pages
  // sorted newest-first.
  updated_at: string;
}

export interface ItemListPage {
  items: ListItem[];
  // Opaque cursor passed back to listItems(); null means no further
  // pages. Adapters encode whatever pagination scheme the site uses.
  next_cursor: string | null;
  // Best estimate of total items, if the site reports it. Drives
  // progress UI; null when unknown.
  total: number | null;
}

// What a custom adapter returns from fetchItem. The framework forwards
// `body` to the cache or to Miyo with the given `filename`.
//
// `filename` MUST be deterministic: the same item id with the same
// content state must always produce the same filename.
export interface RenderedItem {
  filename: string;
  body: string;
}

// Common adapter surface shared by both kinds.
interface BaseSiteAdapter {
  id: SiteId;
  label: string;

  // The site's home page; used for "open ChatGPT" / "open Claude"
  // affordances when the user is signed out.
  home_url: string;

  // Optional display metadata. Recorded in the markdown frontmatter
  // for Miyo / Obsidian to render the source consistently.
  brand_color?: string; // hex, e.g. "#10a37f"

  // Returns user identity if signed in. Never throws on a logged-out
  // browser — return { signedIn: false } instead.
  probeSession(): Promise<SiteSession>;

  // One page of item refs, sorted newest-first. The framework stops
  // paging based on its mode (200-cap in zip mode, diff-with-Miyo in
  // Miyo mode).
  listItems(cursor: string | null): Promise<ItemListPage>;
}

// Chat-shaped adapter. Returns ChatConversation; the framework
// derives the filename and renders the markdown so output is uniform
// across providers.
export interface ChatSiteAdapter extends BaseSiteAdapter {
  kind: 'chat';
  fetchConversation(id: string): Promise<ChatConversation>;
}

// Custom adapter. Owns its own filename and markdown body. Used for
// future non-chat sources (notes, bookmarks, documents).
export interface CustomSiteAdapter extends BaseSiteAdapter {
  kind: 'custom';
  fetchItem(id: string): Promise<RenderedItem>;
}

export type SiteAdapter = ChatSiteAdapter | CustomSiteAdapter;

// One rendered item, fully serialized. The unit of cache, export,
// and the file write to Miyo. Generic across sources — a chat
// conversation is one shape of item; future shapes (notes, bookmarks,
// emails) use the same envelope.
export interface CapturedItem {
  item_id: string;
  updated_at: string;
  title: string;
  url: string;
  created_at: string | null;
  filename: string;
  markdown: string;
  // Source-specific extras. Adapters can use this for things like
  // message_count, tags, author, etc. that don't fit the common
  // envelope. Currently unused by the framework; reserved.
  extra?: Record<string, unknown>;
}

// What the extension stores in Miyo's app-folder metadata blob.
// Schema is extension-owned; Miyo treats this as opaque JSON. See
// docs/MIYO_INTERFACE.md §5.
//
// `items` is the authoritative answer to "what has been captured":
// reading it tells the extension the count, the watermark, and
// whether any given item id needs re-capture (by comparing
// `updated_at`).
//
// `app_id` here is the source application — "chatgpt", "claude_ai",
// etc. — not the extension. The extension is just the orchestrator;
// Miyo stores one app folder per captured source.
export interface AppFolderMetadata {
  version: 1;
  app_id: SiteId;
  label: string;
  last_sync_at: string | null;
  items: Record<string, AppFolderMetadataItem>;
}

export interface AppFolderMetadataItem {
  updated_at: string;
  filename: string;
  title: string;
  url: string;
  created_at: string | null;
}

// What the popup needs to render one site card. Built freshly on
// every popup open; not persisted.
export interface SiteRow {
  id: SiteId;
  label: string;
  home_url: string;
  brand_color: string | null;

  // Session probe, attempted on popup open. Null = not yet probed.
  session: SiteSession | null;

  // Miyo-mode bookkeeping. Populated when Miyo is connected.
  // total: how many conversations Miyo has stored for this site.
  // new_available: how many newer conversations the site has that
  // Miyo doesn't (or has at a stale updated_at). Saturated when our
  // diff probe filled its first list page without exhausting.
  miyo_total: number | null;
  new_available: number | null;
  new_available_saturated: boolean;
}

// Background → popup snapshot. Contains everything needed for a
// single render pass.
export interface PopupSnapshot {
  miyo_connected: boolean;
  sites: SiteRow[];
  // The single in-flight or completed-but-not-downloaded local-mode
  // run, if any. Drives popup decisions: which card shows Resume,
  // whether to auto-zip on open, whether to gate other sites'
  // Download buttons.
  pending_run: PendingRun | null;
}
