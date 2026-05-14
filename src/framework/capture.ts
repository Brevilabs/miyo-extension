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
//   sinceMs null → no lower bound. Early-stop kicks in when a page's
//                  in-range items are all already in the store —
//                  newest-first ordering means everything below is
//                  also in store. Without this, "All available" would
//                  walk the user's entire history on every refresh.
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
import type { CapturedItem, ListItem, RenderedItem, SiteAdapter } from './types.js';
import type { Store } from './capture-store.js';

// pending_run.{written,errors,cursor} are flushed every N captured
// items. A crash loses at most N items of bookkeeping; the IDB / Miyo
// store always reflects truth via filterMissing, so resume corrects
// the count on its first flush.
const RUN_FLUSH_EVERY = 10;

export interface CaptureCallbacks {
  onProgress: (p: {
    phase: 'listing' | 'fetching';
    completed: number;
    total: number | null;
    // Optional override for the popup's progress text. The capture
    // loop sends this at moments where a generic phase label isn't
    // specific enough — e.g. "Found 3 new on page 1, fetching…"
    // right after the first filterMissing call lands.
    note?: string;
  }) => void;
  isCancelled?: () => boolean;
}

export type CaptureResult =
  | { kind: 'completed'; mode: 'local' | 'miyo'; written: number; errors: number }
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

export async function captureToStore(
  adapter: SiteAdapter,
  store: Store,
  mode: 'local' | 'miyo',
  sinceMs: number | null,
  untilMs: number | null,
  // Stop scanning the moment we see an item with updated_at <= this.
  // Items strictly above it still pass through filterMissing so
  // "bumped" known items don't get falsely re-captured. Pass null for
  // a full walk (first sync, or local mode where this concept doesn't
  // apply).
  watermark: string | null,
  callbacks: CaptureCallbacks
): Promise<CaptureResult> {
  const session = await adapter.probeSession();
  if (!session.signedIn) return { kind: 'aborted', reason: 'signed_out' };

  const existing = await readPendingRun();
  let written = existing?.written ?? 0;
  let errors = existing?.errors ?? 0;
  let listCursor: string | null = existing?.cursor ?? null;
  let newestSeen: string | null = existing?.newest_seen ?? null;
  let unflushed = 0;

  const flush = async (): Promise<void> => {
    if (unflushed === 0) return;
    await updatePendingRun({
      written,
      errors,
      cursor: listCursor,
      newest_seen: newestSeen,
    });
    unflushed = 0;
  };

  // Early-stop is only safe when the store is monotonically growing
  // and we've walked from the top — i.e., sinceMs is null (no lower
  // bound). Bounded ranges always walk to their lower edge.
  const earlyStopAllowed = sinceMs === null;
  let firstPageProcessed = false;

  while (true) {
    if (callbacks.isCancelled?.()) {
      await flush();
      return { kind: 'aborted', reason: 'cancelled' };
    }
    let page;
    try {
      page = await paced(adapter.id, () => adapter.listItems(listCursor));
    } catch (err) {
      await flush();
      if (isSignedOutError(err)) return { kind: 'aborted', reason: 'signed_out' };
      return { kind: 'aborted', reason: errMessage(err) };
    }

    // Capture the newest item's updated_at the first time we see one
    // — preserved across resumes via pending_run. On successful Miyo
    // completion this becomes the new watermark.
    if (newestSeen === null && page.items.length > 0) {
      newestSeen = page.items[0]!.updated_at;
      unflushed += 1;
    }

    // Filter to in-range items, and detect whether we've crossed
    // below sinceMs (rangeExhausted) or hit the prior-sync watermark.
    // The watermark check is what lets a steady-state sync finish
    // after one list call: items below it are known to be in store.
    const inRange: ListItem[] = [];
    let rangeExhausted = false;
    let belowWatermark = false;
    for (const item of page.items) {
      const ts = Date.parse(item.updated_at);
      if (untilMs !== null && ts >= untilMs) continue;
      if (sinceMs !== null && ts < sinceMs) {
        rangeExhausted = true;
        break;
      }
      if (watermark !== null && item.updated_at <= watermark) {
        belowWatermark = true;
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

    // First-page feedback: tell the popup what we found so the
    // "Looking for new conversations…" text gets a concrete update
    // before the first item fetch finishes (~1.5s of additional wait).
    if (!firstPageProcessed && missing.length > 0) {
      callbacks.onProgress({
        phase: 'listing',
        completed: 0,
        total: null,
        note: `Found ${missing.length} new, fetching…`,
      });
    }
    firstPageProcessed = true;

    for (const item of inRange) {
      if (!missingSet.has(item.id)) continue;
      if (callbacks.isCancelled?.()) {
        await flush();
        return { kind: 'aborted', reason: 'cancelled' };
      }
      try {
        const captured = await paced(adapter.id, () => renderForAdapter(adapter, item));
        await store.put(captured);
        written += 1;
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
      callbacks.onProgress({ phase: 'fetching', completed: written, total: null });
    }

    listCursor = page.next_cursor;
    unflushed += 1; // mark a page-boundary flush as pending
    if (unflushed >= RUN_FLUSH_EVERY) await flush();

    if (rangeExhausted) break;
    if (belowWatermark) break;
    if (page.next_cursor === null) break;
    // Early stop: a non-empty page where every in-range item was
    // already in the store. Newest-first ordering means older pages
    // are also fully in store.
    if (earlyStopAllowed && inRange.length > 0 && missing.length === 0) break;
  }

  await flush();
  return { kind: 'completed', mode, written, errors };
}

// Probe-only: walk a few pages newest-first asking the store how
// many items are missing. Used by the popup snapshot's "N new
// available" indicator (Miyo mode only).
const MAX_PROBE_PAGES = 4;

export async function probeStoreDelta(
  adapter: SiteAdapter,
  store: Store
): Promise<{ count: number; saturated: boolean }> {
  let count = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PROBE_PAGES; page++) {
    const result = await paced(adapter.id, () => adapter.listItems(cursor));
    if (result.items.length === 0) return { count, saturated: false };
    const missing = await store.filterMissing(result.items.map((i) => i.id));
    count += missing.length;
    if (missing.length === 0) return { count, saturated: false };
    if (result.next_cursor === null) return { count, saturated: false };
    cursor = result.next_cursor;
  }
  return { count, saturated: true };
}
