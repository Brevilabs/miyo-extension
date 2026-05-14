// IndexedDB-backed buffer for captured items.
//
// Why IDB rather than chrome.storage.local: chrome.storage.local
// caps around 10 MB total, and 200 conversations × ~50 KB easily
// pushes past that. IDB has the runway and is fine in MV3 service
// workers (no DOM access needed).
//
// One object store, `items`, keyed by [siteId, item_id]. Each record
// is the rendered CapturedItem from the capture loop — when the run
// finishes, the popup reads everything for a siteId, zips it up, and
// downloads. After the user has the zip, we clear the store.
//
// Resume: capture.ts checks hasItem before fetching each list item.
// A browser close mid-run leaves items in IDB; the next Resume just
// picks up where the loop left off without refetching.

import type { CapturedItem, SiteId } from './types.js';

const DB_NAME = 'miyo-capture';
const ITEMS_STORE = 'items';

interface ItemRecord {
  siteId: SiteId;
  item_id: string;
  filename: string;
  markdown: string;
  title: string;
  updated_at: string;
  captured_at: number;
}

// Open the DB, ensuring the items store exists. Handles a recovery
// case: if a previous run created the DB but was killed before the
// upgrade handler ran the createObjectStore call, the DB sits at some
// version with no store. We detect that, close, and reopen at
// current+1 to force a fresh upgrade.
function openDb(): Promise<IDBDatabase> {
  return openAtVersion(undefined).then((db) => {
    if (db.objectStoreNames.contains(ITEMS_STORE)) return db;
    const v = db.version + 1;
    db.close();
    return openAtVersion(v);
  });
}

function openAtVersion(version: number | undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req =
      version !== undefined ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        // Composite key [siteId, item_id] lets us range-scan by site
        // without an extra index.
        db.createObjectStore(ITEMS_STORE, { keyPath: ['siteId', 'item_id'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IDB upgrade blocked by another connection'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(ITEMS_STORE, mode);
    const store = tx.objectStore(ITEMS_STORE);
    const result = await fn(store);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    return result;
  } finally {
    db.close();
  }
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putItem(siteId: SiteId, item: CapturedItem): Promise<void> {
  const record: ItemRecord = {
    siteId,
    item_id: item.item_id,
    filename: item.filename,
    markdown: item.markdown,
    title: item.title,
    updated_at: item.updated_at,
    captured_at: Date.now(),
  };
  await withStore('readwrite', async (store) => {
    await reqToPromise(store.put(record));
  });
}

export async function hasItem(siteId: SiteId, itemId: string): Promise<boolean> {
  return withStore('readonly', async (store) => {
    const key = await reqToPromise(store.getKey([siteId, itemId]));
    return key !== undefined;
  });
}

export async function countItems(siteId: SiteId): Promise<number> {
  return withStore('readonly', async (store) => {
    const range = IDBKeyRange.bound([siteId], [siteId, []]);
    return reqToPromise(store.count(range));
  });
}

export async function getAllItems(siteId: SiteId): Promise<ItemRecord[]> {
  return withStore('readonly', async (store) => {
    const range = IDBKeyRange.bound([siteId], [siteId, []]);
    return reqToPromise(store.getAll(range));
  });
}

export async function clearItems(siteId: SiteId): Promise<void> {
  await withStore('readwrite', async (store) => {
    const range = IDBKeyRange.bound([siteId], [siteId, []]);
    await reqToPromise(store.delete(range));
  });
}

export type { ItemRecord };
