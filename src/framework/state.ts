// Per-site state and in-progress sync persistence.
//
// chrome.storage.local survives browser restarts, so cursor and last
// sync outcome persist across sessions. SyncProgress also persists —
// a service-worker kill mid-sync resumes from this exact state on
// the next user click.

import type { SiteId, SiteState, SyncProgress } from './types.js';

const EMPTY_STATE: SiteState = {
  cursor_updated_at: null,
  last_session: null,
  last_probe_at: null,
  last_sync_at: null,
  last_sync_error: null,
};

function stateKey(siteId: SiteId): string {
  return `state:${siteId}`;
}

function progressKey(siteId: SiteId): string {
  return `progress:${siteId}`;
}

export async function getSiteState(siteId: SiteId): Promise<SiteState> {
  const key = stateKey(siteId);
  const obj = await chrome.storage.local.get(key);
  const stored = obj[key] as SiteState | undefined;
  return stored ? { ...EMPTY_STATE, ...stored } : { ...EMPTY_STATE };
}

export async function patchSiteState(
  siteId: SiteId,
  patch: Partial<SiteState>
): Promise<SiteState> {
  const cur = await getSiteState(siteId);
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [stateKey(siteId)]: next });
  return next;
}

export async function getSyncProgress(siteId: SiteId): Promise<SyncProgress | null> {
  const key = progressKey(siteId);
  const obj = await chrome.storage.local.get(key);
  return (obj[key] as SyncProgress | undefined) ?? null;
}

export async function setSyncProgress(
  siteId: SiteId,
  progress: SyncProgress | null
): Promise<void> {
  const key = progressKey(siteId);
  if (progress === null) {
    await chrome.storage.local.remove(key);
  } else {
    await chrome.storage.local.set({ [key]: progress });
  }
}

// Wipe all state for a site. Used when the user disables a connector
// and the caller wants a clean slate on next enable.
export async function resetSiteState(siteId: SiteId): Promise<void> {
  await chrome.storage.local.remove([stateKey(siteId), progressKey(siteId)]);
}
