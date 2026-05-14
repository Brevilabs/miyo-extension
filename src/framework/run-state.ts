// Persistent run record. One row total — "only one capture task at
// a time" is enforced by the popup gating UI plus the background's
// busy check on 'start' messages.
//
// chrome.storage.local (not IDB) because the record is tiny and the
// popup needs it on the synchronous-feeling open path; storage.local
// reads are typically <5 ms.

import type { PendingRun } from './types.js';

const KEY = 'pending_run';

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
