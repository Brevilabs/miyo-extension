// Metadata file written to the root of each destination folder.
//
// Identifies the folder as belonging to a particular Miyo Capture
// source (ChatGPT, Claude, …), and acts as the source of truth for
// dedup: the captures map records every conversation we have written,
// keyed by the adapter's stable item id.
//
// On Chrome / Edge / Brave / Arc (File System Access API), the
// extension reads this file at the start of each sync to know what
// has already been captured. On Firefox / Safari (downloads-only),
// the file is written so external tools (Miyo Desktop, future
// integrations) can read it, but the extension cannot read it back —
// dedup on those browsers falls back to a hint cache in
// chrome.storage.local.

export const META_FILENAME = '.miyo-capture.json';
export const META_SCHEMA_URL = 'https://miyo.md/schema/capture-folder/v1';
export const META_VERSION = 1;

export interface CaptureRecord {
  filename: string;
  updated_at: string | null;
}

export interface SourceIdentity {
  id: string;
  label: string;
  home_url: string;
  brand_color?: string;
}

export interface CaptureFolderMeta {
  $schema: string;
  version: number;
  source: SourceIdentity;
  session?: {
    signed_in_email: string | null;
    probed_at: string;
  };
  sync?: {
    last_at: string;
    cursor_updated_at: string | null;
  };
  captures: Record<string, CaptureRecord>;
  writer_version: string;
}

export function emptyMeta(source: SourceIdentity, writerVersion: string): CaptureFolderMeta {
  return {
    $schema: META_SCHEMA_URL,
    version: META_VERSION,
    source: {
      id: source.id,
      label: source.label,
      home_url: source.home_url,
      ...(source.brand_color ? { brand_color: source.brand_color } : {}),
    },
    captures: {},
    writer_version: writerVersion,
  };
}

export function mergeCapture(
  meta: CaptureFolderMeta,
  stable_id: string,
  record: CaptureRecord
): CaptureFolderMeta {
  return {
    ...meta,
    captures: { ...meta.captures, [stable_id]: record },
  };
}

export function hasCapture(meta: CaptureFolderMeta, stable_id: string): boolean {
  return Object.prototype.hasOwnProperty.call(meta.captures, stable_id);
}

export function parseMeta(text: string): CaptureFolderMeta | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const m = obj as Partial<CaptureFolderMeta>;
  if (typeof m.source?.id !== 'string') return null;
  if (typeof m.source?.label !== 'string') return null;
  if (typeof m.source?.home_url !== 'string') return null;
  if (typeof m.captures !== 'object' || m.captures === null) return null;
  return m as CaptureFolderMeta;
}

// Two-space indent: this file is human-readable as well as machine-read.
export function serializeMeta(meta: CaptureFolderMeta): string {
  return JSON.stringify(meta, null, 2) + '\n';
}
