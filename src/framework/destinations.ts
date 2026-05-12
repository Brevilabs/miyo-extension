// Per-site destination config and FileSystemDirectoryHandle storage.
//
// chrome.storage.local holds the JSON-serializable config (enabled,
// paused, destination kind + subpath). FileSystemDirectoryHandle is
// structured-cloneable but not JSON, so handles live in an IndexedDB
// object store keyed by site id.
//
// Permission state on a directory handle does not always survive a
// browser restart — the browser may need to re-prompt the user.
// requestPermission must run inside a user gesture (i.e. a popup
// click), never from the service worker.

import { sanitizeTitleForFilename } from './filename.js';
import type { SiteId } from './types.js';

export type DestinationKind = 'folder' | 'downloads';

export type Destination =
  | { kind: 'folder' } // handle lives in IndexedDB keyed by siteId
  | { kind: 'downloads'; subpath: string };

export interface SiteConfig {
  enabled: boolean;
  paused: boolean;
  destination: Destination | null;
}

const EMPTY_CONFIG: SiteConfig = {
  enabled: false,
  paused: false,
  destination: null,
};

function configKey(siteId: SiteId): string {
  return `config:${siteId}`;
}

export async function getSiteConfig(siteId: SiteId): Promise<SiteConfig> {
  const key = configKey(siteId);
  const obj = await chrome.storage.local.get(key);
  const stored = obj[key] as SiteConfig | undefined;
  return stored ? { ...EMPTY_CONFIG, ...stored } : { ...EMPTY_CONFIG };
}

export async function setSiteConfig(
  siteId: SiteId,
  patch: Partial<SiteConfig>
): Promise<SiteConfig> {
  const cur = await getSiteConfig(siteId);
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [configKey(siteId)]: next });
  return next;
}

// ──────────────────────────────────────────────────────────────────
// FileSystemDirectoryHandle storage in IndexedDB
// ──────────────────────────────────────────────────────────────────

const DB_NAME = 'miyo-capture';
const DB_VERSION = 1;
const HANDLES_STORE = 'handles';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(HANDLES_STORE)) {
          d.createObjectStore(HANDLES_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const d = await db();
  const tx = d.transaction(HANDLES_STORE, mode);
  const result = await fn(tx.objectStore(HANDLES_STORE));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return result;
}

export function getFolderHandle(
  siteId: SiteId
): Promise<FileSystemDirectoryHandle | null> {
  return withStore('readonly', async (s) => {
    const v = await asPromise(s.get(siteId));
    return (v as FileSystemDirectoryHandle | undefined) ?? null;
  });
}

export function setFolderHandle(
  siteId: SiteId,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  return withStore('readwrite', async (s) => {
    await asPromise(s.put(handle, siteId));
  });
}

export function clearFolderHandle(siteId: SiteId): Promise<void> {
  return withStore('readwrite', async (s) => {
    await asPromise(s.delete(siteId));
  });
}

// ──────────────────────────────────────────────────────────────────
// Capability detection
// ──────────────────────────────────────────────────────────────────

export function supportsFolderPicker(): boolean {
  return (
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

// ──────────────────────────────────────────────────────────────────
// Permission helpers
// ──────────────────────────────────────────────────────────────────
// queryPermission can be called anywhere. requestPermission must be
// inside a user gesture — only safe to call from the popup, never
// from the background service worker.

type PermissionState = 'granted' | 'denied' | 'prompt';

interface HandleWithPermissions {
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export async function hasPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as HandleWithPermissions;
  if (typeof h.queryPermission !== 'function') return true;
  return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
}

export async function requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as HandleWithPermissions;
  if (typeof h.requestPermission !== 'function') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export function defaultDownloadsSubpath(label: string): string {
  return `Miyo Captures/${sanitizeTitleForFilename(label)}`;
}
