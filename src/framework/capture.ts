// Capture orchestrator.
//
// One mode-agnostic loop drives both flows. It walks the adapter's
// list pages newest-first, bulk-checks the destination store for
// which item ids are already present, and captures the missing ones.
// Local mode → IdbStore (buffered, zipped+downloaded by popup at end).
// Miyo mode  → MiyoStore (files POST'd to the Miyo desktop server).
//
// Range semantics:
//   sinceMs   → stop when an item's updated_at falls below it.
//   untilMs   → skip items above it (newest-first; they're "too new").
//   sinceMs null → no lower bound; walk to end-of-pages. "All
//                  available" is O(library size) in list calls. There
//                  is no page-level early-stop: a previously bounded
//                  run (e.g. 30d) leaves older items uncaptured, so a
//                  "fully-known" page near the top of history would
//                  hide them. Correctness > a perf shortcut here.
//
// Resume:
//   The capture loop reads pending_run on entry. `cursor` lets us pick
//   up at the last successfully-walked list page so we don't re-walk
//   thousands of items after a SW death. `written` and `errors`
//   continue counting from where they left off.

import { FatalError, paced } from './rate-limit.js';
import { renderChatConversationMarkdown } from './chat.js';
import { readPendingRun, updatePendingRun } from './run-state.js';
import { makeDatePrefixedFilename } from './filename.js';
import { MiyoUnavailableError } from './miyo.js';
import type {
  CaptureMode,
  CapturedItem,
  ListItem,
  RenderedItem,
  SiteAdapter,
} from './types.js';
import type { Store } from './capture-store.js';

// Crash loses at most this many items of bookkeeping; the store
// itself is the source of truth via filterMissing, so resume self-
// corrects on its first flush.
const RUN_FLUSH_EVERY = 10;

// 'cancelled' is the hard halt — pending_run is dropped. 'paused' is
// the soft one — state is flushed and Resume picks up at the same
// cursor.
export type StopReason = 'cancelled' | 'paused';

export interface CaptureCallbacks {
  onProgress: (p: {
    phase: 'listing' | 'fetching';
    completed: number;
    total: number | null;
    note?: string;
  }) => void;
  shouldStop?: () => StopReason | null;
}

export type CaptureResult =
  | { kind: 'completed'; mode: CaptureMode; written: number; errors: number }
  | { kind: 'aborted'; reason: string };

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export async function captureToStore(
  adapter: SiteAdapter,
  store: Store,
  mode: CaptureMode,
  sinceMs: number | null,
  untilMs: number | null,
  callbacks: CaptureCallbacks
): Promise<CaptureResult> {
  const session = await adapter.probeSession();
  if (!session.signedIn) return { kind: 'aborted', reason: 'signed_out' };

  const existing = await readPendingRun();
  let written = existing?.written ?? 0;
  let errors = existing?.errors ?? 0;
  let listCursor: string | null = existing?.cursor ?? null;
  let unflushed = 0;
  // The most recent title we successfully captured. Surfaced as a
  // detail line so the user sees what's being saved, not just a
  // count.
  let lastCapturedTitle: string | null = null;

  const flush = async (): Promise<void> => {
    if (unflushed === 0) return;
    await updatePendingRun({
      written,
      errors,
      cursor: listCursor,
    });
    unflushed = 0;
  };

  let firstPageProcessed = false;

  const checkStop = async (): Promise<CaptureResult | null> => {
    const stop = callbacks.shouldStop?.();
    if (!stop) return null;
    await flush();
    return { kind: 'aborted', reason: stop };
  };

  while (true) {
    const stop = await checkStop();
    if (stop) return stop;
    let page;
    try {
      page = await paced(adapter.id, () => adapter.listItems(listCursor));
    } catch (err) {
      await flush();
      if (isSignedOutError(err)) return { kind: 'aborted', reason: 'signed_out' };
      return { kind: 'aborted', reason: errMessage(err) };
    }

    const inRange: ListItem[] = [];
    let rangeExhausted = false;
    for (const item of page.items) {
      const ts = Date.parse(item.updated_at);
      if (untilMs !== null && ts >= untilMs) continue;
      if (sinceMs !== null && ts < sinceMs) {
        rangeExhausted = true;
        break;
      }
      inRange.push(item);
    }

    let missing: string[] = [];
    if (inRange.length > 0) {
      try {
        missing = await store.filterMissing(inRange.map((i) => i.id));
      } catch (err) {
        await flush();
        if (err instanceof MiyoUnavailableError) {
          return { kind: 'aborted', reason: 'miyo_unavailable' };
        }
        return { kind: 'aborted', reason: errMessage(err) };
      }
    }
    const missingSet = new Set(missing);

    // Surface scan progress page-by-page so the popup isn't stuck on
    // "Looking for new conversations…" for an entire library walk.
    // On the first page with new items, switch to "Found N new,
    // fetching…" so the user knows fetching is about to start.
    if (!firstPageProcessed && missing.length > 0) {
      callbacks.onProgress({
        phase: 'listing',
        completed: 0,
        total: null,
        note: `Found ${missing.length} new, fetching…`,
      });
    } else if (inRange.length > 0) {
      // Adapters return items newest-first, so the first item is the
      // newest in this page and the last is the oldest. Surfacing the
      // window lets the user see exactly which conversations are
      // being diffed right now, and the window naturally advances
      // backwards in time as we paginate.
      const target = mode === 'miyo' ? 'Miyo' : 'your local cache';
      const newest = formatDate(inRange[0]!.updated_at);
      const oldest = formatDate(inRange[inRange.length - 1]!.updated_at);
      const window = newest === oldest ? newest : `${newest} → ${oldest}`;
      callbacks.onProgress({
        phase: 'listing',
        completed: 0,
        total: null,
        note: `Checking ${window} against ${target}…`,
      });
    }
    firstPageProcessed = true;

    for (const item of inRange) {
      if (!missingSet.has(item.id)) continue;
      const stop = await checkStop();
      if (stop) return stop;
      try {
        const captured = await paced(adapter.id, () => renderForAdapter(adapter, item));
        await store.put(captured);
        written += 1;
        lastCapturedTitle = captured.title;
      } catch (err) {
        if (isSignedOutError(err)) {
          await flush();
          return { kind: 'aborted', reason: 'signed_out' };
        }
        if (err instanceof MiyoUnavailableError) {
          await flush();
          return { kind: 'aborted', reason: 'miyo_unavailable' };
        }
        errors += 1;
      }
      unflushed += 1;
      if (unflushed >= RUN_FLUSH_EVERY) await flush();
      callbacks.onProgress({
        phase: 'fetching',
        completed: written,
        total: null,
        note: lastCapturedTitle
          ? `${written} captured · ${lastCapturedTitle}`
          : undefined,
      });
    }

    listCursor = page.next_cursor;
    unflushed += 1; // mark a page-boundary flush as pending
    if (unflushed >= RUN_FLUSH_EVERY) await flush();

    if (rangeExhausted) break;
    if (page.next_cursor === null) break;
  }

  await flush();
  return { kind: 'completed', mode, written, errors };
}
