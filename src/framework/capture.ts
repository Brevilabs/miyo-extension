// Capture orchestrator.
//
// Two flows:
//
//   captureToLocalFiles (local mode — Miyo not installed)
//     • User picks a time-range window. We page newest-first and
//       buffer each rendered item into IndexedDB (store.ts). When
//       the loop finishes we mark the pending run 'completed'; the
//       popup then zips IDB contents and triggers the download.
//     • Resumable across browser restarts: items already in IDB are
//       skipped at the fetch step. The persistent run record
//       (run-state.ts) tells the popup whether to show "Resume" or
//       auto-zip-and-download on its next open.
//
//   captureToMiyo (Miyo mode)
//     • No cap. Miyo holds the full library; the extension only sends
//       the delta.
//     • Diff: list newest-first, comparing each item against the
//       app-folder metadata blob; stop at the first clean page.
//     • POSTs each rendered item as a .md file via /v0/file, and
//       updates the metadata blob (every FLUSH_EVERY items + at end).
//
// If the SW dies mid-run:
//   • Local mode: items written so far survive in IDB; pending_run
//     record stays at status='fetching'. Next popup open offers
//     Resume, which re-enters the loop and skips IDB-present items.
//   • Miyo mode: the metadata blob (last flushed) is the index. Items
//     written but not yet recorded in metadata get re-captured next
//     run (POST /v0/file with force:true is idempotent), so worst-case
//     redo is FLUSH_EVERY-1 items.

import { FatalError, paced } from './rate-limit.js';
import { renderChatConversationMarkdown } from './chat.js';
import { hasItem, putItem } from './store.js';
import { updatePendingRun } from './run-state.js';
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
  initialWritten: number,
  initialErrors: number,
  callbacks: CaptureCallbacks
): Promise<CaptureResult> {
  const session = await adapter.probeSession();
  if (!session.signedIn) return { kind: 'aborted', reason: 'signed_out' };

  // Page-and-buffer in lockstep: each list page immediately drives
  // IDB writes, so a resumed run sees progress without re-traversing
  // the entire window. Items below sinceMs end the scan; items above
  // untilMs are skipped (newest-first ordering).
  //
  // initialWritten/initialErrors let a resumed run continue counting
  // from where the previous attempt left off (read from the persisted
  // PendingRun by the caller).
  let listCursor: string | null = null;
  let written = initialWritten;
  let errors = initialErrors;

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
      // Resume short-circuit: items already buffered survive across
      // SW death and browser restarts. We just count them and move on.
      if (await hasItem(adapter.id, item.id)) {
        continue;
      }
      try {
        const captured = await paced(adapter.id, () => renderForAdapter(adapter, item));
        await putItem(adapter.id, captured);
        written += 1;
        await updatePendingRun({ written, errors });
      } catch (err) {
        if (isSignedOutError(err)) return { kind: 'aborted', reason: 'signed_out' };
        errors += 1;
        await updatePendingRun({ written, errors });
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
