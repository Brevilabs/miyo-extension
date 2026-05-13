// The single sync loop.
//
// Driven by the background service worker after the popup hands off a
// "sync this site now" message. Each run targets one site; the
// destination is whatever the user configured. No transport selection
// — there is exactly one delivery path per run: the writer for that
// site.
//
// Correctness invariants:
//
//   1. The destination folder is the source of truth. On Chrome the
//      writer reads .miyo-capture.json at the start of the run and
//      uses its captures map to skip already-delivered items. On
//      Firefox/Safari (downloads-only), readMeta is null; we synthesize
//      a fresh meta in memory and rely on the cursor in
//      chrome.storage.local for delta sync.
//
//   2. The cursor (last successfully synced `updated_at`) only
//      advances at the end of a fully-completed run. A partial run
//      that gets interrupted leaves the cursor unchanged, and the
//      next click resumes via `SyncProgress.pending_items`.
//
//   3. SyncProgress is persisted after every individual successful
//      delivery. A service-worker kill at any point loses at most
//      one in-flight item.
//
//   4. Writes are idempotent. The adapter's filename is deterministic
//      per item id; re-writes overwrite (folder: getFileHandle with
//      create:true; downloads: conflictAction:'overwrite').
//
//   5. Listing is newest-first; the first item with
//      `updated_at <= cursor` lets us terminate paging early.
//
//   6. 401/403 from any site call stops the run and marks the source
//      as signed-out.

import { FatalError, paced } from './rate-limit.js';
import {
  getSiteState,
  patchSiteState,
  getSyncProgress,
  setSyncProgress,
} from './state.js';
import { getSiteConfig } from './destinations.js';
import { makeWriter } from './writer.js';
import {
  emptyMeta,
  hasCapture,
  mergeCapture,
  type CaptureFolderMeta,
  type SourceIdentity,
} from './meta.js';
import { renderChatConversationMarkdown } from './chat.js';
import { makeDatePrefixedFilename } from './filename.js';
import type { RenderedItem, SiteAdapter, SyncProgress } from './types.js';

// Cap a single Sync click. Multi-thousand-item histories see
// "Continue sync" on the next click rather than chewing the SW for
// an hour.
const MAX_PER_RUN = 1000;

// Per-item meta write would be O(N²) in serialized bytes for large
// runs. Flush every K items to amortize while keeping crash-recovery
// cost bounded — writes are idempotent (deterministic filenames +
// overwrite), so re-fetching K items on a worst-case crash is cheap.
const META_FLUSH_EVERY = 25;

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
    pending_items: [],
    errors: [],
    list_exhausted: false,
  };
}

async function renderForAdapter(adapter: SiteAdapter, id: string): Promise<RenderedItem> {
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

function sourceIdentityFromAdapter(adapter: SiteAdapter): SourceIdentity {
  return {
    id: adapter.id,
    label: adapter.label,
    home_url: adapter.home_url,
    ...(adapter.brand_color ? { brand_color: adapter.brand_color } : {}),
  };
}

function writerVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
}

export async function runSync(
  adapter: SiteAdapter,
  callbacks: SyncCallbacks
): Promise<SyncResult> {
  const config = await getSiteConfig(adapter.id);
  if (!config.enabled) return { kind: 'aborted', reason: 'not_enabled' };
  if (config.paused) return { kind: 'aborted', reason: 'paused' };

  const writerResult = await makeWriter(adapter.id, config);
  if (!writerResult.ok) return { kind: 'aborted', reason: writerResult.reason };
  const writer = writerResult.writer;
  const isFolder = writer.kind === 'folder';

  // Load existing meta or initialize. emptyMeta is used both on
  // first-ever sync to a folder and on downloads-only browsers where
  // readMeta cannot return real state.
  const sourceIdentity = sourceIdentityFromAdapter(adapter);
  let meta: CaptureFolderMeta =
    (await writer.readMeta()) ?? emptyMeta(sourceIdentity, writerVersion());

  // Defense in depth: the popup's destination setup should catch
  // mismatched-source folders before we get here, but if a meta file
  // exists for a different source, bail without writing.
  if (meta.source.id !== adapter.id) {
    return { kind: 'aborted', reason: `destination_belongs_to_${meta.source.id}` };
  }

  // Refresh source identity (label, brand_color may evolve across
  // extension releases).
  meta = {
    ...meta,
    source: sourceIdentity,
    writer_version: writerVersion(),
  };

  const state = await getSiteState(adapter.id);
  // Folder is SoT: prefer meta's cursor. Fall back to state's cursor
  // on downloads-only browsers (where readMeta returned null and meta
  // is synthetic).
  const cursorAt = meta.sync?.cursor_updated_at ?? state.cursor_updated_at;
  let highestSeen: string | null = cursorAt;

  const progress = (await getSyncProgress(adapter.id)) ?? freshProgress();

  // Resume after a cap_reached pause: prior run filled MAX_PER_RUN
  // items and stopped. The pending_items queue and list_cursor carry
  // forward so we can resume mid-stream, but `completed` is the
  // per-click counter — reset it so this click can capture another
  // batch instead of bailing out immediately at the cap check.
  if (progress.completed >= MAX_PER_RUN) {
    progress.completed = 0;
    progress.errors = [];
  }

  const finalizeAsSignedOut = async (): Promise<SyncResult> => {
    await patchSiteState(adapter.id, {
      last_sync_error: 'signed_out',
      last_session: { signedIn: false, email: null },
      last_probe_at: Date.now(),
    });
    await setSyncProgress(adapter.id, null);
    await writer.writeMeta(meta).catch(() => {});
    return { kind: 'aborted', reason: 'signed_out' };
  };

  try {
    while (progress.completed < MAX_PER_RUN) {
      // Refill pending_items from the next list page when empty.
      if (progress.pending_items.length === 0) {
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
          // Advance highestSeen regardless of capture state — cursor
          // should move past items we've already captured.
          if (!highestSeen || item.updated_at > highestSeen) highestSeen = item.updated_at;
          // Skip items already in the captures map.
          if (hasCapture(meta, item.id)) continue;
          progress.pending_items.push({ id: item.id, updated_at: item.updated_at });
        }
        progress.list_exhausted = hitCursor || page.next_cursor === null;
        progress.list_cursor = page.next_cursor;
        await setSyncProgress(adapter.id, progress);

        if (progress.pending_items.length === 0) {
          if (progress.list_exhausted) break;
          continue;
        }
      }

      const pending = progress.pending_items.shift()!;
      try {
        const rendered = await paced(adapter.id, () =>
          renderForAdapter(adapter, pending.id)
        );
        await writer.write(rendered.filename, rendered.body);

        meta = mergeCapture(meta, pending.id, {
          filename: rendered.filename,
          updated_at: pending.updated_at,
        });
        progress.completed += 1;
        await setSyncProgress(adapter.id, progress);

        // On Chrome (folder writer), flush meta every META_FLUSH_EVERY
        // items. On downloads-only browsers each writeMeta is a visible
        // download — defer to end-of-run regardless.
        if (isFolder && progress.completed % META_FLUSH_EVERY === 0) {
          await writer.writeMeta(meta).catch(() => {
            // Best-effort. Next flush retries.
          });
        }

        callbacks.onProgress({ completed: progress.completed, total: progress.total });
      } catch (err) {
        if (err instanceof FatalError && (err.status === 401 || err.status === 403)) {
          return finalizeAsSignedOut();
        }
        // Permission lost mid-run — abort cleanly so the popup can
        // prompt for reconnect rather than collecting N identical
        // per-item errors.
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          await patchSiteState(adapter.id, { last_sync_error: 'permission_revoked' });
          return { kind: 'aborted', reason: 'permission_revoked' };
        }
        const message = err instanceof Error ? err.message : String(err);
        progress.errors.push({ item_id: pending.id, message });
        await setSyncProgress(adapter.id, progress);
      }
    }

    const reachedCap = progress.completed >= MAX_PER_RUN && !progress.list_exhausted;
    const nowIso = new Date().toISOString();
    const sessionSnapshot = state.last_session
      ? {
          signed_in_email: state.last_session.email,
          probed_at: state.last_probe_at
            ? new Date(state.last_probe_at).toISOString()
            : nowIso,
        }
      : meta.session;

    meta = {
      ...meta,
      sync: {
        last_at: nowIso,
        cursor_updated_at: reachedCap ? cursorAt : highestSeen,
      },
      ...(sessionSnapshot ? { session: sessionSnapshot } : {}),
    };

    // Final meta flush. Redundant on Chrome after per-item writes;
    // essential on downloads-only browsers (their only writeMeta call).
    await writer.writeMeta(meta).catch(() => {});

    if (reachedCap) {
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
    return {
      kind: 'completed',
      written: progress.completed,
      errors: progress.errors.length,
    };
  } catch (err) {
    if (err instanceof FatalError && (err.status === 401 || err.status === 403)) {
      return finalizeAsSignedOut();
    }
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      await patchSiteState(adapter.id, { last_sync_error: 'permission_revoked' });
      return { kind: 'aborted', reason: 'permission_revoked' };
    }
    const message = err instanceof Error ? err.message : String(err);
    await patchSiteState(adapter.id, { last_sync_error: message });
    await writer.writeMeta(meta).catch(() => {});
    return { kind: 'aborted', reason: message };
  }
}
