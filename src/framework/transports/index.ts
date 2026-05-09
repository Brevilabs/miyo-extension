// Transport selection.
//
// The extension supports two delivery transports:
//
//   1. Miyo (HTTP to the local desktop app) — preferred. Files land
//      in whatever per-source library directory the user configured
//      in Miyo, get indexed for search, and feed the Synced apps UI.
//
//   2. Downloads (~/Downloads/Miyo/<source>/) — fallback. Used when
//      Miyo isn't running. Lets the extension be useful immediately
//      after install, before the user has Miyo. When they later
//      install Miyo and start it, the next sync auto-promotes to the
//      richer transport.
//
// Selection happens once per sync run, at the start. Mid-run mode
// switches would split items across two locations and confuse the
// user; one run = one transport.

import { downloadsTransport } from './downloads.js';
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
  const dlHealth = await downloadsTransport.health();
  if (dlHealth.available) {
    return { transport: downloadsTransport, label: dlHealth.label ?? '~/Downloads/Miyo' };
  }
  return null;
}

// Snapshot for the popup. Reports both transports' availability so
// the UI can show "Connected to Miyo" vs "Saving to Downloads · Get
// Miyo for indexed search."
export interface TransportSnapshot {
  active: TransportMode | null;
  miyo: { available: boolean; label: string | null };
  downloads: { available: boolean; label: string | null };
}

export async function snapshotTransports(): Promise<TransportSnapshot> {
  const [miyo, downloads] = await Promise.all([
    miyoTransport.health(),
    downloadsTransport.health(),
  ]);
  const active: TransportMode | null = miyo.available
    ? 'miyo'
    : downloads.available
      ? 'downloads'
      : null;
  return { active, miyo, downloads };
}
