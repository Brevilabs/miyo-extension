// HTTP transport to the Miyo desktop app.
//
// Used when the Miyo desktop app is running on the same machine.
// Rendered markdown is POSTed to the local service-node process; Miyo
// writes the file under its per-source destination, indexes it, and
// surfaces the source in the Synced apps UI.
//
// Endpoints (all JSON, all require X-Miyo-Extension: 1):
//   GET  /v0/sources/health
//   POST /v0/sources/<source_id>/sync/start
//   POST /v0/sources/<source_id>/items
//   POST /v0/sources/<source_id>/sync/finish
//
// Transport-level failures throw MiyoUnreachableError so the sync
// orchestrator can short-circuit the whole run with a clear "Miyo
// went away" message rather than logging hundreds of per-item
// errors.

import type {
  ItemPayload,
  SyncFinishPayload,
  SyncStartPayload,
  Transport,
  TransportHealth,
} from './types.js';

const MIYO_BASE = 'http://127.0.0.1:8742';
const EXTENSION_HEADER = { 'X-Miyo-Extension': '1' };

export class MiyoUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiyoUnreachableError';
  }
}

async function postJson(urlPath: string, payload: unknown): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${MIYO_BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...EXTENSION_HEADER },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new MiyoUnreachableError(
      `POST ${urlPath} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 5xx and network-style failures count as Miyo unreachable for
    // orchestrator purposes — they're our infra failing, not the
    // upstream site. 4xx from Miyo is a protocol bug; surface as
    // MiyoUnreachableError too because there's no recovery path
    // mid-sync.
    throw new MiyoUnreachableError(`POST ${urlPath} → ${res.status}: ${body.slice(0, 200)}`);
  }
}

export const miyoTransport: Transport = {
  mode: 'miyo',

  async health(): Promise<TransportHealth> {
    try {
      const res = await fetch(`${MIYO_BASE}/v0/sources/health`, {
        method: 'GET',
        headers: EXTENSION_HEADER,
      });
      if (!res.ok) return { available: false, label: null };
      const json = (await res.json().catch(() => ({}))) as { version?: string };
      const v = json.version ? ` v${json.version}` : '';
      return { available: true, label: `Miyo${v}` };
    } catch {
      return { available: false, label: null };
    }
  },

  async postSyncStart(sourceId: string, payload: SyncStartPayload): Promise<void> {
    await postJson(`/v0/sources/${encodeURIComponent(sourceId)}/sync/start`, payload);
  },

  async postItem(sourceId: string, payload: ItemPayload): Promise<void> {
    await postJson(`/v0/sources/${encodeURIComponent(sourceId)}/items`, payload);
  },

  async postSyncFinish(sourceId: string, payload: SyncFinishPayload): Promise<void> {
    await postJson(`/v0/sources/${encodeURIComponent(sourceId)}/sync/finish`, payload);
  },
};
