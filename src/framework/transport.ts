// HTTP transport to the Miyo desktop app.
//
// All sync output flows through this module. The extension does not
// touch the file system itself; it POSTs rendered markdown to Miyo's
// service-node process running on localhost. Miyo writes the file
// under the per-source destination directory, indexes it, and surfaces
// the source in the Synced apps UI.
//
// Endpoints (all JSON, all require X-Miyo-Extension: 1):
//   GET  /v0/sources/health
//   POST /v0/sources/<source_id>/sync/start
//   POST /v0/sources/<source_id>/items
//   POST /v0/sources/<source_id>/sync/finish
//
// On any transport-level failure we throw MiyoUnreachableError so the
// sync orchestrator can short-circuit the whole run with a clear
// "Miyo went away" message rather than logging hundreds of per-item
// errors.

const MIYO_BASE = 'http://127.0.0.1:8742';
const EXTENSION_HEADER = { 'X-Miyo-Extension': '1' };

export class MiyoUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiyoUnreachableError';
  }
}

export interface MiyoHealth {
  running: boolean;
  version: string | null;
}

export async function health(): Promise<MiyoHealth> {
  try {
    const res = await fetch(`${MIYO_BASE}/v0/sources/health`, {
      method: 'GET',
      headers: EXTENSION_HEADER,
    });
    if (!res.ok) return { running: false, version: null };
    const json = (await res.json().catch(() => ({}))) as { version?: string };
    return { running: true, version: json.version ?? null };
  } catch {
    return { running: false, version: null };
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

export interface SyncStartPayload {
  signed_in_email: string | null;
}

export async function postSyncStart(
  sourceId: string,
  payload: SyncStartPayload
): Promise<void> {
  await postJson(`/v0/sources/${encodeURIComponent(sourceId)}/sync/start`, payload);
}

export interface ItemPayload {
  // Filename relative to the connector's destination directory.
  filename: string;
  // Markdown body to write.
  body: string;
  // Adapter's stable item id; lets Miyo dedupe across syncs and
  // detect filename renames.
  stable_id: string;
  // Item's last-modified time (ISO 8601). Used for connector-level
  // diagnostics; not for sync gating (the extension owns the cursor).
  updated_at: string | null;
}

export async function postItem(sourceId: string, payload: ItemPayload): Promise<void> {
  await postJson(`/v0/sources/${encodeURIComponent(sourceId)}/items`, payload);
}

export interface SyncFinishPayload {
  written: number;
  errors: number;
  cursor_updated_at: string | null;
  // Free-form summary string for the connector's last_error field. Null
  // on a clean finish.
  error_summary: string | null;
}

export async function postSyncFinish(
  sourceId: string,
  payload: SyncFinishPayload
): Promise<void> {
  await postJson(`/v0/sources/${encodeURIComponent(sourceId)}/sync/finish`, payload);
}
