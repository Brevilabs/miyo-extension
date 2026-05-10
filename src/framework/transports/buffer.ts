// Buffer transport — stores rendered items in IndexedDB.
//
// Used when the Miyo desktop app is not running. Replaces the prior
// "auto-write to ~/Downloads/Miyo" transport. Sync now lands data in
// a durable local buffer; the user later clicks Export to emit a zip
// via chrome.downloads with saveAs:true (so they can pick any folder
// — escaping the Downloads-only chrome.downloads jail). The README
// ships inside the export zip, not as a side-effect of sync.
//
// Trade-off vs the old downloads transport: bulk-sync no longer
// auto-populates disk, so consumers (Claude Code, Cursor, …) need a
// manual export to see fresh chats. That friction is intentional —
// the upgrade path is "Install Miyo and your sync streams straight
// into the indexed library."

import { putItem, upsertSource } from '../buffer.js';
import type { ItemPayload, SyncFinishPayload, SyncStartPayload, Transport } from './types.js';

export const bufferTransport: Transport = {
  mode: 'buffer',

  async health() {
    if (typeof indexedDB === 'undefined') {
      return { available: false, label: null };
    }
    return { available: true, label: 'Local buffer' };
  },

  async postSyncStart(sourceId: string, payload: SyncStartPayload): Promise<void> {
    await upsertSource({
      source_id: sourceId,
      label: payload.label,
      home_url: payload.home_url,
      brand_color: payload.brand_color,
      icon_data_url: payload.icon_data_url,
      signed_in_email: payload.signed_in_email,
    });
  },

  async postItem(sourceId: string, payload: ItemPayload): Promise<void> {
    await putItem({
      source_id: sourceId,
      stable_id: payload.stable_id,
      filename: payload.filename,
      body: payload.body,
      updated_at: payload.updated_at,
      synced_at: Date.now(),
    });
  },

  async postSyncFinish(_sourceId: string, _payload: SyncFinishPayload): Promise<void> {
    // No-op. Export is a separate, explicit user action.
  },
};
