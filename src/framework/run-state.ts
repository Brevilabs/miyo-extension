// Persistent run record. One row total — "only one capture task at
// a time" is enforced by the popup gating UI plus the background's
// busy check on 'start' messages.
//
// chrome.storage.local (not IDB) because the record is tiny and the
// popup needs it on the synchronous-feeling open path; storage.local
// reads are typically <5 ms.

import type { PendingRun, SiteId } from './types.js';

const KEY = 'pending_run';
const WATERMARKS_KEY = 'miyo_watermarks';

export async function readPendingRun(): Promise<PendingRun | null> {
  try {
    const obj = await chrome.storage.local.get(KEY);
    const v = obj[KEY] as PendingRun | undefined;
    return v ?? null;
  } catch {
    return null;
  }
}

export async function writePendingRun(run: PendingRun): Promise<void> {
  await chrome.storage.local.set({ [KEY]: run });
}

export async function clearPendingRun(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

export async function updatePendingRun(
  patch: Partial<PendingRun>
): Promise<PendingRun | null> {
  const current = await readPendingRun();
  if (!current) return null;
  const next: PendingRun = { ...current, ...patch };
  await writePendingRun(next);
  return next;
}

// Per-site Miyo sync watermark: the ISO updated_at at the top of the
// source list when our last successful Miyo sync started. Items
// above this on a future sync may need capture; items at or below it
// are known to be in Miyo, so the scan can stop there. Only updated
// when a Miyo run completes successfully — aborted/cancelled runs
// leave the prior watermark in place.

export async function readMiyoWatermark(siteId: SiteId): Promise<string | null> {
  try {
    const obj = await chrome.storage.local.get(WATERMARKS_KEY);
    const all = obj[WATERMARKS_KEY] as Record<string, string> | undefined;
    return all?.[siteId] ?? null;
  } catch {
    return null;
  }
}

export async function writeMiyoWatermark(
  siteId: SiteId,
  updatedAt: string
): Promise<void> {
  const obj = await chrome.storage.local.get(WATERMARKS_KEY);
  const all = (obj[WATERMARKS_KEY] as Record<string, string> | undefined) ?? {};
  all[siteId] = updatedAt;
  await chrome.storage.local.set({ [WATERMARKS_KEY]: all });
}
