// File System Access API wrapper.
//
// `pickLibraryDirectory` and `requestLibraryPermission` must be called
// from a user gesture (popup click). Everything else — querying
// permission, writing markdown, renaming on title change — is safe
// from the service worker.
//
// The directory handle is persisted in IndexedDB. chrome.storage cannot
// hold structured-cloneable browser objects like FileSystemDirectoryHandle.

const DB_NAME = 'miyo-extension';
const DB_VERSION = 1;
const STORE = 'handles';
const HANDLE_KEY = 'library';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      })
  );
}

function dbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function dbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

export type PermissionState = 'granted' | 'prompt' | 'denied';

export async function getStoredLibraryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await dbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
  return handle ?? null;
}

export async function clearStoredLibraryHandle(): Promise<void> {
  await dbDelete(HANDLE_KEY);
}

// User-gesture context only — call from the popup.
export async function pickLibraryDirectory(): Promise<FileSystemDirectoryHandle> {
  // showDirectoryPicker is exposed on Window; service worker callers
  // would hit ReferenceError before any of our code runs.
  const handle = await (
    self as unknown as {
      showDirectoryPicker: (opts: {
        mode: 'read' | 'readwrite';
        id?: string;
        startIn?: string;
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker({
    mode: 'readwrite',
    id: 'miyo-library',
    startIn: 'documents',
  });
  await dbPut(HANDLE_KEY, handle);
  return handle;
}

export async function queryLibraryPermission(
  handle: FileSystemDirectoryHandle
): Promise<PermissionState> {
  // queryPermission is part of the File System Access API permission
  // descriptor surface; not yet in lib.dom.d.ts at the time of writing.
  const result = await (
    handle as unknown as {
      queryPermission: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    }
  ).queryPermission({ mode: 'readwrite' });
  return result;
}

// User-gesture context only — call from the popup.
export async function requestLibraryPermission(
  handle: FileSystemDirectoryHandle
): Promise<PermissionState> {
  const result = await (
    handle as unknown as {
      requestPermission: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    }
  ).requestPermission({ mode: 'readwrite' });
  return result;
}

async function getSubdir(
  root: FileSystemDirectoryHandle,
  subdir: string
): Promise<FileSystemDirectoryHandle> {
  const parts = subdir.split('/').filter(Boolean);
  let cur = root;
  for (const p of parts) {
    cur = await cur.getDirectoryHandle(p, { create: true });
  }
  return cur;
}

// Write markdown into <root>/<subdir>/<filename>. If `oldFilename` is
// provided and differs from `filename`, the new file is written first
// and then the old one is removed — so a crash between the two leaves
// a duplicate, never a missing file. The orphan duplicate is
// reconciled on the next successful sync (the filenames map points at
// the new name).
export async function writeMarkdown(args: {
  root: FileSystemDirectoryHandle;
  subdir: string;
  filename: string;
  body: string;
  oldFilename?: string | null;
}): Promise<void> {
  const dir = await getSubdir(args.root, args.subdir);
  const file = await dir.getFileHandle(args.filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(args.body);
  await writable.close();

  if (args.oldFilename && args.oldFilename !== args.filename) {
    try {
      await dir.removeEntry(args.oldFilename);
    } catch (err) {
      // Old file may have been removed by the user already — ignore.
      // Any other error is non-fatal: the new file exists, so the
      // sync result is correct even if the old one lingers.
      if (!(err instanceof DOMException) || err.name !== 'NotFoundError') {
        console.warn('writeMarkdown: failed to remove old file', args.oldFilename, err);
      }
    }
  }
}
