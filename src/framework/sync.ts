// The single sync loop.
//
// Driven by the background service worker after the popup hands off a
// "sync this site now" message. The popup handles all user-gesture
// concerns (folder picker, permission grant); by the time we get here
// the library handle exists and we have readwrite permission.
//
// The framework is content-agnostic: it asks the adapter for a list
// of item refs, asks the adapter to render each item to a filename +
// body, and writes the body to disk. It does not know whether the
// items are chat conversations, documents, bookmarks, or anything
// else.
//
// Correctness invariants:
//
//   1. The cursor (last successfully synced `updated_at`) only
//      advances at the end of a fully-completed run. A partial run
//      that gets interrupted leaves the cursor unchanged, and the
//      next click resumes via `SyncProgress.pending_ids` — we do not
//      re-fetch items we already wrote.
//
//   2. SyncProgress is persisted after every individual write. A
//      service-worker kill at any point loses at most one in-flight
//      fetch; everything written to disk is reflected in
//      chrome.storage.local before the next item starts.
//
//   3. File writes are idempotent. Adapter contract guarantees the
//      same item id produces a deterministic filename. Re-fetches
//      overwrite the existing file. Filename changes (title rename,
//      etc.) trigger a write-then-delete rename so a crash between
//      the two leaves a harmless duplicate, never a missing file.
//
//   4. Listing is newest-first; the first item with
//      `updated_at <= cursor` lets us terminate paging early. Without
//      this the first sync after a long quiet period is still bounded
//      by `MAX_PER_RUN` instead of the user's full history.
//
//   5. 401/403 from any call stops the run and marks the site as
//      signed-out. Subsequent calls would all fail the same way and
//      the user must re-sign-in in their browser tab.
//
// The orchestrator collects per-item errors but never aborts the run
// on them. A 429 from a single fetch surfaces as one "1 item failed"
// line; the rest of the run completes.

import { FatalError, paced } from './rate-limit.js';
import {
  getSiteState,
  patchSiteState,
  getSyncProgress,
  setSyncProgress,
} from './state.js';
import {
  getStoredLibraryHandle,
  queryLibraryPermission,
  writeMarkdown,
} from './storage.js';
import type { SiteAdapter, SyncProgress } from './types.js';

// Cap a single Sync click. Multi-thousand-item histories see
// "Continue sync" on the next click rather than chewing the SW for
// an hour.
const MAX_PER_RUN = 1000;

export interface SyncCallbacks {
  onProgress: (p: { completed: number; total: number | null }) => void;
}

export type SyncResult =
  | { kind: 'completed'; written: number; errors: number }
  | { kind: 'paused'; written: number; reason: 'cap_reached' }
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

export async function runSync(
  adapter: SiteAdapter,
  callbacks: SyncCallbacks
): Promise<SyncResult> {
  const root = await getStoredLibraryHandle();
  if (!root) return { kind: 'aborted', reason: 'no_library' };

  const perm = await queryLibraryPermission(root);
  if (perm !== 'granted') return { kind: 'aborted', reason: 'permission_required' };

  const state = await getSiteState(adapter.id);
  const progress = (await getSyncProgress(adapter.id)) ?? freshProgress();
  const filenames = { ...state.filenames };
  const cursorAt = state.cursor_updated_at;
  let highestSeen: string | null = cursorAt;

  const finalizeAsSignedOut = async (): Promise<SyncResult> => {
    await patchSiteState(adapter.id, {
      last_sync_error: 'signed_out',
      last_session: { signedIn: false, email: null },
      last_probe_at: Date.now(),
    });
    await setSyncProgress(adapter.id, null);
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
        const rendered = await paced(adapter.id, () => adapter.fetchItem(id));
        await writeMarkdown({
          root,
          subdir: adapter.subdir,
          filename: rendered.filename,
          oldFilename: filenames[id] ?? null,
          body: rendered.body,
        });

        filenames[id] = rendered.filename;
        progress.completed += 1;

        // Persist after every write so a SW restart loses at most the
        // in-flight fetch, never bookkeeping for files already on disk.
        await patchSiteState(adapter.id, { filenames });
        await setSyncProgress(adapter.id, progress);
        callbacks.onProgress({ completed: progress.completed, total: progress.total });
      } catch (err) {
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
      // Cursor stays where it was; pending_ids and list_cursor remain
      // in chrome.storage so the next click resumes mid-run.
      return { kind: 'paused', written: progress.completed, reason: 'cap_reached' };
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
    return { kind: 'completed', written: progress.completed, errors: progress.errors.length };
  } catch (err) {
    if (err instanceof FatalError && (err.status === 401 || err.status === 403)) {
      return finalizeAsSignedOut();
    }
    const message = err instanceof Error ? err.message : String(err);
    await patchSiteState(adapter.id, { last_sync_error: message });
    return { kind: 'aborted', reason: message };
  }
}
