// The single sync loop.
//
// Driven by the background service worker after the popup hands off a
// "sync this site now" message. The orchestrator picks a transport at
// the start (Miyo HTTP if running, downloads fallback otherwise),
// then drives the same fetch-render-deliver loop regardless of which
// transport is active. One run = one transport.
//
// Correctness invariants:
//
//   1. The cursor (last successfully synced `updated_at`) only
//      advances at the end of a fully-completed run. A partial run
//      that gets interrupted leaves the cursor unchanged, and the
//      next click resumes via `SyncProgress.pending_ids` — we do not
//      re-deliver items we already wrote.
//
//   2. SyncProgress is persisted after every individual successful
//      delivery. A service-worker kill at any point loses at most
//      one in-flight item.
//
//   3. Deliveries are idempotent. Adapter contract guarantees the
//      same item id produces a deterministic filename. Re-deliveries
//      overwrite (Miyo: by stable_id; Downloads: by overwrite
//      conflictAction).
//
//   4. Listing is newest-first; the first item with
//      `updated_at <= cursor` lets us terminate paging early.
//
//   5. 401/403 from any site call stops the run and marks the source
//      as signed-out.
//
//   6. MiyoUnreachableError from a Miyo-mode transport call stops
//      the run cleanly; the user can install/start Miyo and click
//      again to resume. State is preserved.

import { FatalError, paced } from './rate-limit.js';
import {
  getSiteState,
  patchSiteState,
  getSyncProgress,
  setSyncProgress,
} from './state.js';
import {
  selectTransport,
  MiyoUnreachableError,
  type Transport,
  type TransportMode,
} from './transports/index.js';
import { renderChatConversationMarkdown } from './chat.js';
import { makeDatePrefixedFilename } from './filename.js';
import type { RenderedItem, SiteAdapter, SyncProgress } from './types.js';

// Cap a single Sync click. Multi-thousand-item histories see
// "Continue sync" on the next click rather than chewing the SW for
// an hour.
const MAX_PER_RUN = 1000;

export interface SyncCallbacks {
  onProgress: (p: { completed: number; total: number | null; mode: TransportMode }) => void;
}

export type SyncResult =
  | { kind: 'completed'; written: number; errors: number; mode: TransportMode }
  | { kind: 'paused'; written: number; reason: 'cap_reached'; mode: TransportMode }
  | { kind: 'aborted'; reason: string };

function freshProgress(): SyncProgress {
  return {
    started_at: Date.now(),
    total: null,
    completed: 0,
    list_cursor: null,
    pending_ids: [],
    errors: [],
    list_exhausted: false,
  };
}

// Resolves an adapter's per-item render output. For chat adapters the
// framework owns both filename and body; custom adapters bring their
// own.
async function renderForAdapter(
  adapter: SiteAdapter,
  id: string
): Promise<RenderedItem> {
  if (adapter.kind === 'chat') {
    const conv = await adapter.fetchConversation(id);
    return {
      filename: makeDatePrefixedFilename({
        id: conv.conversation_id,
        title: conv.title,
        createdAt: conv.created_at,
      }),
      body: renderChatConversationMarkdown(conv),
    };
  }
  return adapter.fetchItem(id);
}

export async function runSync(
  adapter: SiteAdapter,
  callbacks: SyncCallbacks
): Promise<SyncResult> {
  const resolved = await selectTransport();
  if (!resolved) {
    return { kind: 'aborted', reason: 'no_transport' };
  }
  const transport: Transport = resolved.transport;

  const state = await getSiteState(adapter.id);
  const progress = (await getSyncProgress(adapter.id)) ?? freshProgress();
  const filenames = { ...state.filenames };
  const cursorAt = state.cursor_updated_at;
  let highestSeen: string | null = cursorAt;

  // Tell the transport we are starting (Miyo surfaces "syncing" in
  // the Synced apps UI and caches display metadata; Downloads writes
  // a folder README on first run / refreshes it after).
  try {
    await transport.postSyncStart(adapter.id, {
      signed_in_email: state.last_session?.email ?? null,
      label: adapter.label,
      home_url: adapter.home_url,
      brand_color: adapter.brand_color,
      icon_data_url: adapter.icon_data_url,
    });
  } catch (err) {
    if (err instanceof MiyoUnreachableError) {
      return { kind: 'aborted', reason: 'miyo_unreachable' };
    }
    throw err;
  }

  const finalizeAsSignedOut = async (): Promise<SyncResult> => {
    await patchSiteState(adapter.id, {
      last_sync_error: 'signed_out',
      last_session: { signedIn: false, email: null },
      last_probe_at: Date.now(),
    });
    await setSyncProgress(adapter.id, null);
    await transport
      .postSyncFinish(adapter.id, {
        written: progress.completed,
        errors: progress.errors.length,
        cursor_updated_at: cursorAt,
        error_summary: 'signed_out',
      })
      .catch(() => {});
    return { kind: 'aborted', reason: 'signed_out' };
  };

  try {
    while (progress.completed < MAX_PER_RUN) {
      // Refill pending_ids from the next list page when empty.
      if (progress.pending_ids.length === 0) {
        if (progress.list_exhausted) break;
        const page = await paced(adapter.id, () => adapter.listItems(progress.list_cursor));
        if (progress.total === null && page.total !== null) progress.total = page.total;

        let hitCursor = false;
        for (const item of page.items) {
          if (cursorAt && item.updated_at <= cursorAt) {
            // Newest-first ordering: every subsequent item is also
            // older than the cursor.
            hitCursor = true;
            break;
          }
          progress.pending_ids.push(item.id);
          if (!highestSeen || item.updated_at > highestSeen) highestSeen = item.updated_at;
        }
        progress.list_exhausted = hitCursor || page.next_cursor === null;
        progress.list_cursor = page.next_cursor;
        await setSyncProgress(adapter.id, progress);

        if (progress.pending_ids.length === 0) {
          if (progress.list_exhausted) break;
          continue;
        }
      }

      const id = progress.pending_ids.shift()!;
      try {
        const rendered = await paced(adapter.id, () => renderForAdapter(adapter, id));
        await transport.postItem(adapter.id, {
          filename: rendered.filename,
          body: rendered.body,
          stable_id: id,
          updated_at: highestSeen,
        });

        filenames[id] = rendered.filename;
        progress.completed += 1;

        // Persist after every successful delivery so a SW restart
        // loses at most the in-flight item.
        await patchSiteState(adapter.id, { filenames });
        await setSyncProgress(adapter.id, progress);
        callbacks.onProgress({
          completed: progress.completed,
          total: progress.total,
          mode: transport.mode,
        });
      } catch (err) {
        if (err instanceof MiyoUnreachableError) {
          await patchSiteState(adapter.id, { last_sync_error: 'miyo_unreachable' });
          return { kind: 'aborted', reason: 'miyo_unreachable' };
        }
        if (err instanceof FatalError && (err.status === 401 || err.status === 403)) {
          return finalizeAsSignedOut();
        }
        const message = err instanceof Error ? err.message : String(err);
        progress.errors.push({ item_id: id, message });
        await setSyncProgress(adapter.id, progress);
      }
    }

    const reachedCap = progress.completed >= MAX_PER_RUN && !progress.list_exhausted;
    if (reachedCap) {
      await transport
        .postSyncFinish(adapter.id, {
          written: progress.completed,
          errors: progress.errors.length,
          cursor_updated_at: cursorAt,
          error_summary:
            progress.errors.length > 0
              ? `${progress.errors.length} item(s) failed; paused at cap`
              : 'paused at cap',
        })
        .catch(() => {});
      return {
        kind: 'paused',
        written: progress.completed,
        reason: 'cap_reached',
        mode: transport.mode,
      };
    }

    await patchSiteState(adapter.id, {
      cursor_updated_at: highestSeen,
      last_sync_at: Date.now(),
      last_sync_error:
        progress.errors.length > 0
          ? `${progress.errors.length} item${progress.errors.length === 1 ? '' : 's'} failed`
          : null,
    });
    await setSyncProgress(adapter.id, null);
    await transport
      .postSyncFinish(adapter.id, {
        written: progress.completed,
        errors: progress.errors.length,
        cursor_updated_at: highestSeen,
        error_summary:
          progress.errors.length > 0 ? `${progress.errors.length} item(s) failed` : null,
      })
      .catch(() => {});
    return {
      kind: 'completed',
      written: progress.completed,
      errors: progress.errors.length,
      mode: transport.mode,
    };
  } catch (err) {
    if (err instanceof MiyoUnreachableError) {
      await patchSiteState(adapter.id, { last_sync_error: 'miyo_unreachable' });
      return { kind: 'aborted', reason: 'miyo_unreachable' };
    }
    if (err instanceof FatalError && (err.status === 401 || err.status === 403)) {
      return finalizeAsSignedOut();
    }
    const message = err instanceof Error ? err.message : String(err);
    await patchSiteState(adapter.id, { last_sync_error: message });
    await transport
      .postSyncFinish(adapter.id, {
        written: progress.completed,
        errors: progress.errors.length,
        cursor_updated_at: cursorAt,
        error_summary: message,
      })
      .catch(() => {});
    return { kind: 'aborted', reason: message };
  }
}
