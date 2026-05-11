// Buffer → Miyo replay.
//
// When the user runs a sync standalone, items pile up in the local
// buffer. Later, when Miyo desktop is detected, the popup offers a
// one-time "Send N buffered chats to Miyo" button. This module owns
// the loop that ships those items into Miyo and clears the buffer
// row-by-row as each delivery succeeds.
//
// Per-item delete (rather than batch wipe at the end) means a
// failure mid-replay leaves the buffer with only the un-replayed
// items. The next replay click resumes from where this one stopped,
// and we never redo work Miyo has already accepted.
//
// Idempotency: miyoTransport.postItem uses stable_id, so even if
// the user retries with items already accepted on the Miyo side,
// the desktop dedupes. The per-item delete is just an optimization.

import {
  forEachItem,
  getItem,
  getSource,
  deleteItem,
  type BufferedItem,
} from './buffer.js';
import { miyoTransport, MiyoUnreachableError } from './transports/miyo.js';
import type { SiteId } from './types.js';

export type ReplayResult =
  | { kind: 'completed'; replayed: number }
  | { kind: 'aborted'; reason: string; replayed: number };

export interface ReplayCallbacks {
  onProgress: (p: { completed: number; total: number }) => void;
}

export async function runBufferReplay(
  sourceId: SiteId,
  callbacks: ReplayCallbacks
): Promise<ReplayResult> {
  const source = await getSource(sourceId);
  if (!source) {
    return { kind: 'aborted', reason: 'no_buffer', replayed: 0 };
  }
  if (source.item_count === 0) {
    return { kind: 'completed', replayed: 0 };
  }

  // Tell Miyo this source exists. Replay carries display metadata
  // forward so the desktop renders any source_id the buffer holds,
  // even if the user never synced to Miyo for this source before.
  try {
    await miyoTransport.postSyncStart(sourceId, {
      signed_in_email: source.signed_in_email,
      label: source.label,
      home_url: source.home_url,
      brand_color: source.brand_color,
      icon_data_url: source.icon_data_url,
    });
  } catch (err) {
    if (err instanceof MiyoUnreachableError) {
      return { kind: 'aborted', reason: 'miyo_unreachable', replayed: 0 };
    }
    throw err;
  }

  // Materializing only the IDs (not full bodies) keeps memory bounded
  // for large buffers; we re-fetch each item right before sending.
  const ids: string[] = [];
  await forEachItem(sourceId, (item: BufferedItem) => {
    ids.push(item.stable_id);
  });
  const total = ids.length;

  let replayed = 0;
  let highestSeen: string | null = null;
  for (const id of ids) {
    const item = await getItem(sourceId, id);
    if (!item) continue;

    try {
      await miyoTransport.postItem(sourceId, {
        filename: item.filename,
        body: item.body,
        stable_id: item.stable_id,
        updated_at: item.updated_at,
      });
      if (item.updated_at && (!highestSeen || item.updated_at > highestSeen)) {
        highestSeen = item.updated_at;
      }
      await deleteItem(sourceId, item.stable_id);
      replayed += 1;
      callbacks.onProgress({ completed: replayed, total });
    } catch (err) {
      const reason =
        err instanceof MiyoUnreachableError ? 'miyo_unreachable' : 'replay_error';
      // Best-effort sync/finish so Miyo's UI doesn't stay in
      // "syncing" indefinitely.
      await miyoTransport
        .postSyncFinish(sourceId, {
          written: replayed,
          errors: 0,
          cursor_updated_at: highestSeen,
          error_summary: reason,
        })
        .catch(() => {});
      return { kind: 'aborted', reason, replayed };
    }
  }

  await miyoTransport
    .postSyncFinish(sourceId, {
      written: replayed,
      errors: 0,
      cursor_updated_at: highestSeen,
      error_summary: null,
    })
    .catch(() => {});
  return { kind: 'completed', replayed };
}
