// Writer abstraction.
//
// One Writer instance per active sync run; corresponds to a specific
// destination configured by the user. Two implementations:
//
//   FolderWriter (Chrome/Edge/Brave/Arc): wraps a
//   FileSystemDirectoryHandle. Reads and writes the destination
//   folder directly. .miyo-capture.json is the dedup source of truth.
//
//   DownloadsWriter (Firefox/Safari, or Chrome users who declined the
//   folder picker): wraps chrome.downloads. Write-only — readMeta()
//   always returns null. The sync orchestrator falls back to a hint
//   cache in chrome.storage.local for dedup on these platforms.

import {
  META_FILENAME,
  parseMeta,
  serializeMeta,
  type CaptureFolderMeta,
} from './meta.js';
import {
  getFolderHandle,
  getSiteConfig,
  type SiteConfig,
} from './destinations.js';
import type { SiteId } from './types.js';

export type WriterKind = 'folder' | 'downloads';

export interface Writer {
  kind: WriterKind;
  write(filename: string, body: string): Promise<void>;
  readMeta(): Promise<CaptureFolderMeta | null>;
  writeMeta(meta: CaptureFolderMeta): Promise<void>;
}

export class FolderWriter implements Writer {
  readonly kind = 'folder' as const;
  constructor(private readonly handle: FileSystemDirectoryHandle) {}

  async write(filename: string, body: string): Promise<void> {
    const fh = await this.handle.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(body);
    } finally {
      await w.close();
    }
  }

  async readMeta(): Promise<CaptureFolderMeta | null> {
    let fh: FileSystemFileHandle;
    try {
      fh = await this.handle.getFileHandle(META_FILENAME);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return null;
      throw err;
    }
    const file = await fh.getFile();
    const text = await file.text();
    return parseMeta(text);
  }

  async writeMeta(meta: CaptureFolderMeta): Promise<void> {
    const fh = await this.handle.getFileHandle(META_FILENAME, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(serializeMeta(meta));
    } finally {
      await w.close();
    }
  }
}

// chrome.downloads is reliable with data: URLs in MV3 service workers;
// Blob URLs via URL.createObjectURL have historically had quirks in
// that context.
function toDataUrl(text: string, mime: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};charset=utf-8;base64,${btoa(bin)}`;
}

export class DownloadsWriter implements Writer {
  readonly kind = 'downloads' as const;
  // subpath is relative to the browser's Downloads directory; no
  // leading or trailing slash. e.g. 'Miyo Captures/ChatGPT'.
  constructor(private readonly subpath: string) {}

  async write(filename: string, body: string): Promise<void> {
    const url = toDataUrl(body, 'text/markdown');
    await chrome.downloads.download({
      url,
      filename: `${this.subpath}/${filename}`,
      conflictAction: 'overwrite',
      saveAs: false,
    });
  }

  async readMeta(): Promise<CaptureFolderMeta | null> {
    return null;
  }

  async writeMeta(meta: CaptureFolderMeta): Promise<void> {
    const url = toDataUrl(serializeMeta(meta), 'application/json');
    await chrome.downloads.download({
      url,
      filename: `${this.subpath}/${META_FILENAME}`,
      conflictAction: 'overwrite',
      saveAs: false,
    });
  }
}

export type MakeWriterResult =
  | { ok: true; writer: Writer }
  | { ok: false; reason: 'not_configured' | 'handle_missing' };

// Note: no permission check here. queryPermission from the service
// worker is unreliable for handles granted in a popup window, and
// even when accurate the right place to surface "needs reconnect"
// is the popup (which has user-gesture context). Writer operations
// throw NotAllowedError on permission revocation; sync.ts converts
// that to a clean abort and the popup prompts the user.
export async function makeWriter(
  siteId: SiteId,
  config?: SiteConfig
): Promise<MakeWriterResult> {
  const cfg = config ?? (await getSiteConfig(siteId));
  if (!cfg.destination) return { ok: false, reason: 'not_configured' };
  if (cfg.destination.kind === 'downloads') {
    return { ok: true, writer: new DownloadsWriter(cfg.destination.subpath) };
  }
  const handle = await getFolderHandle(siteId);
  if (!handle) return { ok: false, reason: 'handle_missing' };
  return { ok: true, writer: new FolderWriter(handle) };
}
