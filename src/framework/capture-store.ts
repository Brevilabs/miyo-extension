// Capture-side Store abstraction.
//
// captureToStore in capture.ts diffs against a Store and writes
// captured items to it. One backend:
//
//   • IdbStore — items live in IndexedDB until the popup zips them
//     and downloads. Cleared after each successful zip.

import type { CapturedItem, SiteId } from './types.js';
import * as idb from './store.js';

export interface Store {
  // Returns the subset of itemIds that are NOT yet in the store.
  filterMissing(itemIds: string[]): Promise<string[]>;
  put(item: CapturedItem): Promise<void>;
}

export class IdbStore implements Store {
  // One transaction covers all filterMissing calls per run; put()
  // keeps the in-memory set fresh.
  private idsPromise: Promise<Set<string>> | null = null;

  constructor(private readonly siteId: SiteId) {}

  private getIds(): Promise<Set<string>> {
    if (!this.idsPromise) {
      this.idsPromise = idb
        .getAllItemIds(this.siteId)
        .then((ids) => new Set(ids));
    }
    return this.idsPromise;
  }

  async filterMissing(itemIds: string[]): Promise<string[]> {
    if (itemIds.length === 0) return [];
    const known = await this.getIds();
    return itemIds.filter((id) => !known.has(id));
  }

  async put(item: CapturedItem): Promise<void> {
    await idb.putItem(this.siteId, item);
    const known = await this.getIds();
    known.add(item.item_id);
  }
}
