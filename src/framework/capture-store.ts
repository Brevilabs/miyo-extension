// Capture-side Store abstraction.
//
// captureToStore in capture.ts is mode-agnostic: it diffs against a
// Store and writes captured items to it. Two backends:
//
//   • IdbStore — local mode. items live in IndexedDB until the popup
//     zips them and downloads. Cleared after each successful zip.
//
//   • MiyoStore — Miyo mode. items POST to /v0/file on the Miyo
//     desktop server. filterMissing is one HTTP call per page.

import type { CapturedItem, SiteId } from './types.js';
import * as idb from './store.js';
import type { MiyoClient } from './miyo.js';

export interface Store {
  // Returns the subset of itemIds that are NOT yet in the store.
  filterMissing(itemIds: string[]): Promise<string[]>;
  put(item: CapturedItem): Promise<void>;
}

export class IdbStore implements Store {
  constructor(private readonly siteId: SiteId) {}

  async filterMissing(itemIds: string[]): Promise<string[]> {
    if (itemIds.length === 0) return [];
    // Per-item hasItem is fine here — each runs in a cached connection
    // (store.ts caches the IDB handle module-wide).
    const out: string[] = [];
    for (const id of itemIds) {
      if (!(await idb.hasItem(this.siteId, id))) out.push(id);
    }
    return out;
  }

  async put(item: CapturedItem): Promise<void> {
    await idb.putItem(this.siteId, item);
  }
}

export class MiyoStore implements Store {
  constructor(
    private readonly client: MiyoClient,
    private readonly siteId: SiteId,
    private readonly folderName: string
  ) {}

  filterMissing(itemIds: string[]): Promise<string[]> {
    return this.client.filterMissing(this.siteId, itemIds);
  }

  put(item: CapturedItem): Promise<void> {
    return this.client.writeFile(this.folderName, item);
  }
}
