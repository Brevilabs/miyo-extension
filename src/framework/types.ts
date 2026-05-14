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

// Capture destination: 'local' buffers to IDB and zips at the end;
// 'miyo' streams items directly into the Miyo desktop app folder.
export type CaptureMode = 'local' | 'miyo';

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
// `capturing` covers both in-flight (SW running) and paused (SW
// killed); the popup distinguishes by whether the SW reports an
// in-flight run. `ready` is the popup's cue to finalize: local
// zips IDB, Miyo just clears the record.
//
// `cursor` lets resume skip pages already walked — important for
// the "All available" + huge-history case where re-walking the
// whole source would take many minutes.
export interface PendingRun {
  siteId: SiteId;
  mode: CaptureMode;
  range: TimeRange;
  started_at: number; // epoch ms
  status: 'capturing' | 'ready';
  written: number;
  errors: number;
  cursor: string | null;
  // Set once on the first page; preserved across resumes. Promoted to
  // miyo_watermarks on successful Miyo completion only.
  newest_seen: string | null;
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
  // miyo_total: count of items Miyo has stored for this app_id.
  // miyo_folder_path: absolute on-disk path of the app folder (shown
  //   in the popup so users know where files land).
  // new_available: how many items the source has that Miyo doesn't.
  //   Saturated when our diff probe ran the page cap without finding
  //   a fully-known page.
  miyo_total: number | null;
  miyo_folder_path: string | null;
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
