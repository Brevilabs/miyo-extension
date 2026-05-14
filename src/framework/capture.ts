// Capture orchestrator.
//
// Two flows share the inner loop (paged list → fetch+render → write)
// but differ at the edges:
//
//   captureToLocalFiles (local mode — Miyo not installed)
//     • User picks a time-range window; we capture newest-first
//       within it, up to a MAX_ZIP_ITEMS safety cap.
//     • Each rendered item is written directly to the user's
//       Downloads folder via chrome.downloads.download (one .md per
//       item, conflictAction:'overwrite'). The filesystem is the
//       source of truth; the extension stores no per-item state.
//
//   captureToMiyo (Miyo mode)
//     • No cap. Miyo holds the full library; the extension only sends
//       the delta.
//     • Diff: list newest-first, comparing each item against the
//       app-folder metadata blob; stop at the first clean page.
//     • POSTs each rendered item as a .md file via /v0/file, and
//       updates the metadata blob (every FLUSH_EVERY items + at end).
//
// Neither flow persists run progress. If the SW dies, the next click
// starts fresh:
//   • Local mode: re-running captures into the same paths; overwrite
//     makes the retry safely idempotent. Any items downloaded before
//     the death survive on disk.
//   • Miyo mode: the metadata blob (last flushed) is the index. Items
//     written but not yet recorded in metadata get re-captured next
//     run (POST /v0/file with force:true is idempotent), so worst-case
//     redo is FLUSH_EVERY-1 items.

import { FatalError, paced } from './rate-limit.js';
import { renderChatConversationMarkdown } from './chat.js';
import { downloadMarkdown } from './downloader.js';
import { makeDatePrefixedFilename } from './filename.js';
import { MiyoClient, MiyoUnavailableError } from './miyo.js';
import type {
  AppFolderMetadata,
  AppFolderMetadataItem,
  CapturedItem,
  ListItem,
  RenderedItem,
  SiteAdapter,
} from './types.js';

// Miyo-mode metadata-flush cadence. Trade-off: a higher number means
// fewer PUTs but more redo on SW death. 25 items × ~1.5s rate-limited
// fetch = ~40s of work between flushes — small enough that a crash
// barely matters.
const META_FLUSH_EVERY = 25;

export interface CaptureCallbacks {
  // Same shape as before so the popup UI doesn't have to care which
  // mode is running. `total` may be null while we're still
  // discovering work.
  onProgress: (p: {
    phase: 'listing' | 'fetching';
    completed: number;
    total: number | null;
  }) => void;
  isCancelled?: () => boolean;
}

export type CaptureResult =
  | { kind: 'completed'; mode: 'local' | 'miyo'; written: number; errors: number }
  | { kind: 'aborted'; reason: string };

// ───────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────

async function renderForAdapter(
  adapter: SiteAdapter,
  item: ListItem
): Promise<CapturedItem> {
  if (adapter.kind === 'chat') {
    const conv = await adapter.fetchConversation(item.id);
    const filename = makeDatePrefixedFilename({
      id: conv.conversation_id,
      title: conv.title,
      createdAt: conv.created_at,
    });
    return {
      item_id: conv.conversation_id,
      updated_at: conv.updated_at ?? item.updated_at,
      title: conv.title,
      url: conv.url,
      created_at: conv.created_at,
      filename,
      markdown: renderChatConversationMarkdown(conv),
      extra: { kind: 'chat', message_count: conv.messages.length },
    };
  }
  const rendered: RenderedItem = await adapter.fetchItem(item.id);
  return {
    item_id: item.id,
    updated_at: item.updated_at,
    title: rendered.filename.replace(/\.md$/, ''),
    url: adapter.home_url,
    created_at: null,
    filename: rendered.filename,
    markdown: rendered.body,
  };
}

function isSignedOutError(err: unknown): boolean {
  return err instanceof FatalError && (err.status === 401 || err.status === 403);
}

function emptyMetadata(adapter: SiteAdapter): AppFolderMetadata {
  return {
    version: 1,
    app_id: adapter.id,
    label: adapter.label,
    last_sync_at: null,
    items: {},
  };
}

function metadataEntry(item: CapturedItem): AppFolderMetadataItem {
  return {
    updated_at: item.updated_at,
    filename: item.filename,
    title: item.title,
    url: item.url,
    created_at: item.created_at,
  };
}

// ───────────────────────────────────────────────────────────────────
// Local-mode capture (Miyo not installed)
// ───────────────────────────────────────────────────────────────────

export async function captureToLocalFiles(
  adapter: SiteAdapter,
  sinceMs: number | null,
  untilMs: number | null,
  callbacks: CaptureCallbacks
): Promise<CaptureResult> {
  const session = await adapter.probeSession();
  if (!session.signedIn) return { kind: 'aborted', reason: 'signed_out' };

  // Page-and-download in lockstep: each list page immediately drives
  // downloads, so the user sees files flowing into Downloads almost
  // as soon as the run starts (no separate "scanning" phase to sit
  // through). The whole thing is naturally bounded by the user's
  // range — items below sinceMs end the scan, items above untilMs are
  // skipped (newest-first ordering).
  let listCursor: string | null = null;
  let written = 0;
  let errors = 0;

  while (true) {
    if (callbacks.isCancelled?.()) return { kind: 'aborted', reason: 'cancelled' };
    let page;
    try {
      page = await paced(adapter.id, () => adapter.listItems(listCursor));
    } catch (err) {
      if (isSignedOutError(err)) return { kind: 'aborted', reason: 'signed_out' };
      return { kind: 'aborted', reason: errMessage(err) };
    }

    let rangeExhausted = false;
    for (const item of page.items) {
      if (callbacks.isCancelled?.()) return { kind: 'aborted', reason: 'cancelled' };
      const ts = Date.parse(item.updated_at);
      if (untilMs !== null && ts >= untilMs) continue; // too new — skip
      if (sinceMs !== null && ts < sinceMs) {
        rangeExhausted = true;
        break;
      }
      try {
        const captured = await paced(adapter.id, () => renderForAdapter(adapter, item));
        await downloadMarkdown(adapter.id, captured);
        written += 1;
      } catch (err) {
        if (isSignedOutError(err)) return { kind: 'aborted', reason: 'signed_out' };
        errors += 1;
      }
      // Total is unknown without an upfront listing pass — popup
      // shows an indeterminate bar plus the running count.
      callbacks.onProgress({ phase: 'fetching', completed: written, total: null });
    }

    if (rangeExhausted) break;
    if (page.next_cursor === null) break;
    listCursor = page.next_cursor;
  }

  return { kind: 'completed', mode: 'local', written, errors };
}

// ───────────────────────────────────────────────────────────────────
// Miyo-mode helpers
// ───────────────────────────────────────────────────────────────────

// Probe-only: compute the delta count without fetching anything. Used
// by the popup-open snapshot to render "N new available". Walks
// listItems newest-first until it finds a full page where every item
// is already in the metadata index at matching updated_at, or until
// it runs out of pages.
//
// Saturated = we hit `MAX_PROBE_PAGES` without exhausting; the true
// new-count is `count` or more. The popup displays "N+" in that case.
const MAX_PROBE_PAGES = 4;

export async function probeMiyoDelta(
  adapter: SiteAdapter,
  miyoIndex: Map<string, string>
): Promise<{ count: number; saturated: boolean }> {
  let count = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PROBE_PAGES; page++) {
    const result = await paced(adapter.id, () => adapter.listItems(cursor));
    let pageHadNew = false;
    for (const item of result.items) {
      const knownAt = miyoIndex.get(item.id);
      if (!knownAt || knownAt < item.updated_at) {
        count += 1;
        pageHadNew = true;
      }
    }
    // Stopping rule: once a page contains zero new-or-updated items,
    // every subsequent page is also clean — newest-first ordering
    // means any touched item would have moved up to a page we've
    // already seen.
    if (!pageHadNew) return { count, saturated: false };
    if (result.next_cursor === null) return { count, saturated: false };
    cursor = result.next_cursor;
  }
  return { count, saturated: true };
}

// Build the diff index used by probeMiyoDelta and captureToMiyo from
// a stored metadata blob. Returns an empty map for null/missing
// metadata (first-time capture).
export function indexFromMetadata(metadata: AppFolderMetadata | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!metadata) return out;
  for (const [id, entry] of Object.entries(metadata.items)) {
    out.set(id, entry.updated_at);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────
// Miyo-mode capture
// ───────────────────────────────────────────────────────────────────

export async function captureToMiyo(
  adapter: SiteAdapter,
  miyo: MiyoClient,
  callbacks: CaptureCallbacks
): Promise<CaptureResult> {
  const session = await adapter.probeSession();
  if (!session.signedIn) return { kind: 'aborted', reason: 'signed_out' };

  // Ensure the app folder exists and grab its current metadata. The
  // POST is idempotent; on a hot path it just returns the existing
  // folder + metadata.
  let folderInfo;
  try {
    folderInfo = await miyo.ensureAppFolder(adapter.id, adapter.label);
  } catch (err) {
    if (err instanceof MiyoUnavailableError) {
      return { kind: 'aborted', reason: 'miyo_unavailable' };
    }
    return { kind: 'aborted', reason: errMessage(err) };
  }
  const metadata: AppFolderMetadata = folderInfo.metadata ?? emptyMetadata(adapter);
  // Refresh label in case the adapter's display name changed since
  // the prior run. The app_id is immutable per source.
  metadata.app_id = adapter.id;
  metadata.label = adapter.label;
  const miyoIndex = indexFromMetadata(metadata);

  // Phase 1: scan pages newest-first until a clean page is seen.
  // No page cap — the user clicked Send and explicitly wants the
  // full delta.
  const toCapture: ListItem[] = [];
  let listCursor: string | null = null;
  while (true) {
    if (callbacks.isCancelled?.()) return { kind: 'aborted', reason: 'cancelled' };
    let page;
    try {
      page = await paced(adapter.id, () => adapter.listItems(listCursor));
    } catch (err) {
      if (isSignedOutError(err)) return { kind: 'aborted', reason: 'signed_out' };
      return { kind: 'aborted', reason: errMessage(err) };
    }
    let pageHadNew = false;
    for (const item of page.items) {
      const knownAt = miyoIndex.get(item.id);
      if (!knownAt || knownAt < item.updated_at) {
        toCapture.push(item);
        pageHadNew = true;
      }
    }
    callbacks.onProgress({
      phase: 'listing',
      completed: toCapture.length,
      total: null,
    });
    if (!pageHadNew) break;
    if (page.next_cursor === null) break;
    listCursor = page.next_cursor;
  }

  // Phase 2: fetch, write file, record in metadata. Flush metadata to
  // Miyo every META_FLUSH_EVERY items so a SW death loses at most
  // that many items of bookkeeping (the file writes themselves are
  // durable as soon as POST /v0/file returns).
  let written = 0;
  let errors = 0;
  let pendingFlush = 0;
  const total = toCapture.length;

  for (const item of toCapture) {
    if (callbacks.isCancelled?.()) {
      await flushMetadata(miyo, adapter, metadata).catch(() => {});
      return { kind: 'aborted', reason: 'cancelled' };
    }
    if (!miyo.isAlive()) {
      await flushMetadata(miyo, adapter, metadata).catch(() => {});
      return { kind: 'aborted', reason: 'miyo_unavailable' };
    }
    try {
      const captured = await paced(adapter.id, () => renderForAdapter(adapter, item));
      await miyo.writeFile(folderInfo.folder_name, captured);
      metadata.items[captured.item_id] = metadataEntry(captured);
      written += 1;
      pendingFlush += 1;
      if (pendingFlush >= META_FLUSH_EVERY) {
        await flushMetadata(miyo, adapter, metadata);
        pendingFlush = 0;
      }
    } catch (err) {
      if (isSignedOutError(err)) {
        await flushMetadata(miyo, adapter, metadata).catch(() => {});
        return { kind: 'aborted', reason: 'signed_out' };
      }
      if (err instanceof MiyoUnavailableError) {
        // No flush — the client is dead.
        return { kind: 'aborted', reason: 'miyo_unavailable' };
      }
      errors += 1;
    }
    callbacks.onProgress({ phase: 'fetching', completed: written, total });
  }

  // Final flush. last_sync_at advances only at successful end-of-run.
  metadata.last_sync_at = new Date().toISOString();
  try {
    await flushMetadata(miyo, adapter, metadata);
  } catch (err) {
    if (err instanceof MiyoUnavailableError) {
      return { kind: 'aborted', reason: 'miyo_unavailable' };
    }
    // A failed final flush is bad but not catastrophic — files are
    // written, items will re-sync next run. Treat as a soft error.
    errors += 1;
  }
  return { kind: 'completed', mode: 'miyo', written, errors };
}

async function flushMetadata(
  miyo: MiyoClient,
  adapter: SiteAdapter,
  metadata: AppFolderMetadata
): Promise<void> {
  await miyo.putMetadata(adapter.id, metadata);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
