// Local IndexedDB buffer for synced items.
//
// Replaces the prior auto-write-to-Downloads model: sync now lands
// every rendered item here, and the user explicitly clicks Export to
// emit a zip via chrome.downloads (with saveAs:true so they can pick
// any folder, escaping the Downloads-only chrome.downloads jail).
//
// Two object stores:
//
//   items   — one row per (source_id, stable_id) holding the rendered
//             markdown. Compound key so re-syncs of the same item
//             overwrite cleanly.
//   sources — one row per source_id with denormalized item_count and
//             timestamps. The popup reads this directly; we don't
//             scan items to render counts.
//
// chrome.storage.local has a 10MB cap which a heavy ChatGPT user
// would blow past in their first sync. We require unlimitedStorage
// (declared in manifest) and use IndexedDB, which has no practical
// upper bound on Chrome desktop.

import type { SiteId } from './types.js';

const DB_NAME = 'miyo-extension';
const DB_VERSION = 1;
const STORE_ITEMS = 'items';
const STORE_SOURCES = 'sources';
const INDEX_BY_SOURCE = 'by_source';

export interface BufferedItem {
  source_id: SiteId;
  stable_id: string;
  filename: string;
  body: string;
  // ISO 8601 watermark from the run that wrote this row. Nullable
  // because the very first sync's first item may precede any cursor.
  // Not used for ordering (synced_at is); kept for parity with the
  // wire payload so a future buffer→Miyo replay forwards it intact.
  updated_at: string | null;
  // Date.now() at the moment this row was written.
  synced_at: number;
}

export interface BufferedSource {
  source_id: SiteId;
  label: string;
  home_url: string;
  brand_color?: string;
  icon_data_url?: string;
  signed_in_email: string | null;
  // Denormalized so the popup renders without a count() scan.
  item_count: number;
  last_buffered_at: number | null;
  last_exported_at: number | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const items = db.createObjectStore(STORE_ITEMS, {
          keyPath: ['source_id', 'stable_id'],
        });
        items.createIndex(INDEX_BY_SOURCE, 'source_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SOURCES)) {
        db.createObjectStore(STORE_SOURCES, { keyPath: 'source_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Upserts the per-source metadata row. Called by the buffer transport
// on sync/start. Preserves prior counts and timestamps; only the
// display metadata + signed-in email are refreshed.
export async function upsertSource(
  meta: Omit<BufferedSource, 'item_count' | 'last_buffered_at' | 'last_exported_at'>
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SOURCES, 'readwrite');
  const store = tx.objectStore(STORE_SOURCES);
  const existing = (await asPromise(store.get(meta.source_id))) as BufferedSource | undefined;
  const next: BufferedSource = {
    ...meta,
    item_count: existing?.item_count ?? 0,
    last_buffered_at: existing?.last_buffered_at ?? null,
    last_exported_at: existing?.last_exported_at ?? null,
  };
  store.put(next);
  await txDone(tx);
}

// Writes a buffered item and increments the source's item_count if
// this stable_id is new. Atomic via a single readwrite transaction
// over both stores.
export async function putItem(item: BufferedItem): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_ITEMS, STORE_SOURCES], 'readwrite');
  const items = tx.objectStore(STORE_ITEMS);
  const sources = tx.objectStore(STORE_SOURCES);

  const existing = await asPromise(items.get([item.source_id, item.stable_id]));
  items.put(item);

  const src = (await asPromise(sources.get(item.source_id))) as BufferedSource | undefined;
  if (src) {
    sources.put({
      ...src,
      item_count: existing ? src.item_count : src.item_count + 1,
      last_buffered_at: item.synced_at,
    });
  }
  await txDone(tx);
}

export async function getItem(
  sourceId: SiteId,
  stableId: string
): Promise<BufferedItem | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_ITEMS, 'readonly');
  const row = (await asPromise(tx.objectStore(STORE_ITEMS).get([sourceId, stableId]))) as
    | BufferedItem
    | undefined;
  return row ?? null;
}

export async function getSource(sourceId: SiteId): Promise<BufferedSource | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_SOURCES, 'readonly');
  const row = (await asPromise(tx.objectStore(STORE_SOURCES).get(sourceId))) as
    | BufferedSource
    | undefined;
  return row ?? null;
}

export async function getAllSources(): Promise<BufferedSource[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_SOURCES, 'readonly');
  return (await asPromise(tx.objectStore(STORE_SOURCES).getAll())) as BufferedSource[];
}

// Cursor-based iteration so callers (export, replay) don't have to
// materialize the entire buffer in memory. Heavy ChatGPT histories
// can be hundreds of MB.
export async function forEachItem(
  sourceId: SiteId,
  cb: (item: BufferedItem) => void | Promise<void>
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_ITEMS, 'readonly');
  const index = tx.objectStore(STORE_ITEMS).index(INDEX_BY_SOURCE);
  await new Promise<void>((resolve, reject) => {
    const req = index.openCursor(IDBKeyRange.only(sourceId));
    req.onsuccess = async () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        await cb(cursor.value as BufferedItem);
      } catch (err) {
        reject(err);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteItem(sourceId: SiteId, stableId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_ITEMS, STORE_SOURCES], 'readwrite');
  const items = tx.objectStore(STORE_ITEMS);
  const sources = tx.objectStore(STORE_SOURCES);
  const existing = await asPromise(items.get([sourceId, stableId]));
  if (existing) {
    items.delete([sourceId, stableId]);
    const src = (await asPromise(sources.get(sourceId))) as BufferedSource | undefined;
    if (src && src.item_count > 0) {
      sources.put({ ...src, item_count: src.item_count - 1 });
    }
  }
  await txDone(tx);
}

// Used after a successful buffer→Miyo replay. Wipes all items for a
// source and zeroes the count, but leaves the source row intact so
// display metadata persists.
export async function clearSourceItems(sourceId: SiteId): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_ITEMS, STORE_SOURCES], 'readwrite');
  const items = tx.objectStore(STORE_ITEMS);
  const sources = tx.objectStore(STORE_SOURCES);
  const index = items.index(INDEX_BY_SOURCE);

  await new Promise<void>((resolve, reject) => {
    const req = index.openCursor(IDBKeyRange.only(sourceId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  const src = (await asPromise(sources.get(sourceId))) as BufferedSource | undefined;
  if (src) {
    sources.put({ ...src, item_count: 0, last_buffered_at: null });
  }
  await txDone(tx);
}

export async function markExported(sourceId: SiteId, ts: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SOURCES, 'readwrite');
  const store = tx.objectStore(STORE_SOURCES);
  const src = (await asPromise(store.get(sourceId))) as BufferedSource | undefined;
  if (src) {
    store.put({ ...src, last_exported_at: ts });
  }
  await txDone(tx);
}
