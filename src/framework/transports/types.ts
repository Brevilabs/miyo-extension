// Transport contract — both miyo.ts and downloads.ts implement this.
// Sync orchestrator picks one at the start of each run and uses it for
// every per-item delivery in that run.

export type TransportMode = 'miyo' | 'buffer';

export interface TransportHealth {
  available: boolean;
  // Short human-readable label for the popup, e.g. "Miyo v1.2.0" or
  // "~/Downloads/Miyo". Null if the transport isn't available.
  label: string | null;
}

export interface SyncStartPayload {
  signed_in_email: string | null;
  // Source display metadata. Carried on every sync/start so the Miyo
  // desktop can render any new source_id without a release —
  // adding a source is a pure extension change. Desktop caches the
  // latest metadata per source_id.
  label: string;
  home_url: string;
  brand_color?: string;
  icon_data_url?: string;
}

export interface ItemPayload {
  filename: string;
  body: string;
  // Adapter's stable item id; lets Miyo dedupe + handle renames.
  // Downloads transport ignores it (no rename support there).
  stable_id: string;
  updated_at: string | null;
}

export interface SyncFinishPayload {
  written: number;
  errors: number;
  cursor_updated_at: string | null;
  error_summary: string | null;
}

export interface Transport {
  mode: TransportMode;
  health(): Promise<TransportHealth>;
  postSyncStart(sourceId: string, payload: SyncStartPayload): Promise<void>;
  postItem(sourceId: string, payload: ItemPayload): Promise<void>;
  postSyncFinish(sourceId: string, payload: SyncFinishPayload): Promise<void>;
}
