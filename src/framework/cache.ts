// Per-source captured-item cache.
//
// Only used in zip-export mode. When Miyo is connected, Miyo holds the
// captured-state truth and this cache is not consulted.
//
// Stored in chrome.storage.local under `cache:<siteId>` as a single
// object keyed by item id. We rewrite the entire bucket at the end
// of a capture run — the resulting cache is *exactly* the latest 200
// items, so the cap is enforced implicitly.
//
// The bucket also doubles as the export source: clicking Export ZIP
// reads the bucket and zips whatever is in it.

import type { CapturedItem, SiteId } from './types.js';

export type SiteCache = Record<string, CapturedItem>;

function cacheKey(siteId: SiteId): string {
  return `cache:${siteId}`;
}

export async function getCache(siteId: SiteId): Promise<SiteCache> {
  const key = cacheKey(siteId);
  const obj = await chrome.storage.local.get(key);
  return (obj[key] as SiteCache | undefined) ?? {};
}

// Replace the entire bucket. Used at end-of-run to commit exactly the
// 200 conversations we just captured, evicting anything that has
// dropped out of the top-200 window on the source.
export async function setCache(siteId: SiteId, cache: SiteCache): Promise<void> {
  await chrome.storage.local.set({ [cacheKey(siteId)]: cache });
}

export async function clearCache(siteId: SiteId): Promise<void> {
  await chrome.storage.local.remove(cacheKey(siteId));
}

export async function cachedCount(siteId: SiteId): Promise<number> {
  const cache = await getCache(siteId);
  return Object.keys(cache).length;
}
