// Downloads-folder transport.
//
// Used when the Miyo desktop app is not running. Each rendered item
// is dropped into ~/Downloads/Miyo/<source>/<filename> via the
// chrome.downloads API. The user can later install Miyo and switch
// modes by simply running the app — the next sync will detect Miyo
// and route through HTTP instead.
//
// Trade-offs:
//   - File location is fixed under Downloads (the API does not allow
//     arbitrary paths). Acceptable for the standalone "sampler" use
//     case; the user's chosen library folder takes over once Miyo is
//     installed.
//   - No filename-rename support. If a conversation's title changes
//     between syncs the new file lands beside the old one. The
//     sampler mode tolerates this; Miyo mode handles renames
//     properly via the receiver's stable_id dedupe.
//   - sync_start / sync_finish are no-ops here; there is no Miyo to
//     inform.

import type { ItemPayload, SyncFinishPayload, SyncStartPayload, Transport } from './types.js';

export class DownloadsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadsUnavailableError';
  }
}

function buildDataUrl(body: string): string {
  // chrome.downloads.download cannot consume blob: URLs created in
  // the service worker context (URL.createObjectURL is unavailable
  // there). A data: URL works in every MV3 environment we target.
  // Markdown bodies are bounded by per-conversation size and the
  // base64 conversion stays cheap.
  const utf8 = new TextEncoder().encode(body);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return `data:text/markdown;base64,${btoa(binary)}`;
}

export const downloadsTransport: Transport = {
  mode: 'downloads',

  async health() {
    if (typeof chrome === 'undefined' || !chrome.downloads?.download) {
      return { available: false, label: null };
    }
    return { available: true, label: '~/Downloads/Miyo' };
  },

  async postSyncStart(_sourceId: string, _payload: SyncStartPayload): Promise<void> {
    // No-op: nothing to inform.
  },

  async postItem(sourceId: string, payload: ItemPayload): Promise<void> {
    const url = buildDataUrl(payload.body);
    try {
      await chrome.downloads.download({
        url,
        filename: `Miyo/${sourceId}/${payload.filename}`,
        conflictAction: 'overwrite',
        saveAs: false,
      });
    } catch (err) {
      throw new DownloadsUnavailableError(
        `chrome.downloads failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  async postSyncFinish(_sourceId: string, _payload: SyncFinishPayload): Promise<void> {
    // No-op.
  },
};
