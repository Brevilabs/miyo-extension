// Transport selection.
//
// The extension supports two delivery transports:
//
//   1. Miyo (HTTP to the local desktop app) — preferred. Files land
//      in whatever per-source library directory the user configured
//      in Miyo, get indexed for search, and feed the Synced apps UI.
//
//   2. Buffer (IndexedDB) — fallback. Rendered items are stored
//      locally; the user explicitly clicks Export to emit a zip via
//      chrome.downloads (saveAs lets them pick any folder). Lets the
//      extension be useful immediately after install, before the
//      user has Miyo. When they later install Miyo and start it, the
//      next sync auto-promotes to the richer per-item streaming
//      transport, and the popup offers a one-time replay of any
//      items still in the buffer.
//
// Selection happens once per sync run, at the start. Mid-run mode
// switches would split items across two locations and confuse the
// user; one run = one transport.

import { bufferTransport } from './buffer.js';
import { miyoTransport, MiyoUnreachableError } from './miyo.js';
import type { Transport, TransportMode } from './types.js';

export { MiyoUnreachableError };
export type { Transport, TransportMode } from './types.js';

export interface ResolvedTransport {
  transport: Transport;
  label: string;
}

// Picks the best available transport. Caller uses the returned
// `transport` for the entire sync run.
export async function selectTransport(): Promise<ResolvedTransport | null> {
  const miyoHealth = await miyoTransport.health();
  if (miyoHealth.available) {
    return { transport: miyoTransport, label: miyoHealth.label ?? 'Miyo' };
  }
  const bufHealth = await bufferTransport.health();
  if (bufHealth.available) {
    return { transport: bufferTransport, label: bufHealth.label ?? 'Local buffer' };
  }
  return null;
}

// Snapshot for the popup. Reports both transports' availability so
// the UI can show "Connected to Miyo" vs "Buffered locally · Install
// Miyo".
export interface TransportSnapshot {
  active: TransportMode | null;
  miyo: { available: boolean; label: string | null };
  buffer: { available: boolean; label: string | null };
}

export async function snapshotTransports(): Promise<TransportSnapshot> {
  const [miyo, buffer] = await Promise.all([
    miyoTransport.health(),
    bufferTransport.health(),
  ]);
  const active: TransportMode | null = miyo.available
    ? 'miyo'
    : buffer.available
      ? 'buffer'
      : null;
  return { active, miyo, buffer };
}
