// Miyo HTTP client.
//
// Implements the app-folder + metadata protocol specified in
// docs/MIYO_INTERFACE.md.
//
// Miyo desktop binds an HTTP server to 127.0.0.1:8742. The extension
// probes /v0/health on every popup open. If Miyo answers with
// service:"running", the popup renders the "Send to Miyo" UI; any
// failure (refused, slow, non-JSON, service !== "running") falls back
// to zip mode silently.
//
// Endpoint summary:
//   GET  /v0/health                         — detection
//   POST /v0/app-folder                     — create-or-get
//   GET  /v0/app-folder/:app_id/metadata    — read blob
//   PUT  /v0/app-folder/:app_id/metadata    — write blob
//   POST /v0/file                           — write a .md
//
// `app_id` is the source application — "chatgpt", "claude_ai", etc.
// The first three endpoints are new ones Miyo must implement; the
// last two reuse Miyo's existing surface.

import type {
  AppFolderMetadata,
  CapturedItem,
  SiteId,
} from './types.js';

const MIYO_BASE = 'http://127.0.0.1:8742';
const HEALTH_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 10_000;

export class MiyoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiyoUnavailableError';
  }
}

interface HealthResponse {
  status?: string;
  service?: string;
}

export interface AppFolderInfo {
  folder_name: string;
  folder_path: string;
  app_id: string;
  label: string;
  metadata: AppFolderMetadata | null;
  metadata_updated_at: number | null;
}

export class MiyoClient {
  private alive = true;
  public miyoStatus: string = 'unknown';

  private constructor(status: string) {
    this.miyoStatus = status;
  }

  // Probe + handshake. Resolves with a ready client; rejects with
  // MiyoUnavailableError if Miyo isn't running or doesn't answer
  // /v0/health correctly within HEALTH_TIMEOUT_MS.
  static async connect(): Promise<MiyoClient> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${MIYO_BASE}/v0/health`, {}, HEALTH_TIMEOUT_MS);
    } catch (err) {
      throw new MiyoUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      throw new MiyoUnavailableError(`health returned ${res.status}`);
    }
    let body: HealthResponse;
    try {
      body = (await res.json()) as HealthResponse;
    } catch (err) {
      throw new MiyoUnavailableError(`health body not JSON: ${err}`);
    }
    // service:"running" is the right signal — status may be "degraded"
    // when search/embedding aren't ready, but capture writes still
    // work (we only need /v0/file, /v0/app-folder, /v0/folder).
    if (body.service !== 'running') {
      throw new MiyoUnavailableError(`service is "${body.service ?? '<unset>'}"`);
    }
    return new MiyoClient(body.status ?? 'unknown');
  }

  isAlive(): boolean {
    return this.alive;
  }

  // No persistent connection to close. Sets `alive` to false so any
  // queued callers short-circuit. The HTTP server keeps running;
  // the next MiyoClient.connect() picks it back up.
  disconnect(): void {
    this.alive = false;
  }

  // Create-or-get the app folder for an app (chatgpt, claude, ...).
  // Idempotent. Returns the folder name (for use in writeFile) and
  // any existing metadata blob inline so the caller can skip a
  // second GET.
  async ensureAppFolder(appId: SiteId, label: string): Promise<AppFolderInfo> {
    return this.request('POST', `/v0/app-folder`, {
      app_id: appId,
      label,
    }) as Promise<AppFolderInfo>;
  }

  // Replace the metadata blob for an app. The blob is the
  // extension's index of what's been captured.
  async putMetadata(appId: SiteId, metadata: AppFolderMetadata): Promise<void> {
    await this.request(
      'PUT',
      `/v0/app-folder/${encodeURIComponent(appId)}/metadata`,
      metadata
    );
  }

  // Write one captured item as a markdown file in the app folder.
  // `force:true` is the right default for re-syncs — the filename
  // is deterministic per item, so a re-capture at a newer
  // updated_at should overwrite the prior file cleanly.
  //
  // Throws MiyoUnavailableError on connection failure (marks client
  // dead). Throws a plain Error on per-item failures (4xx/5xx other
  // than 507); the capture loop handles those as "skip + continue".
  async writeFile(folderName: string, item: CapturedItem): Promise<void> {
    if (!this.alive) {
      throw new MiyoUnavailableError('client marked dead');
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${MIYO_BASE}/v0/file`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder: folderName,
            filename: item.filename,
            content: item.markdown,
            force: true,
          }),
        },
        REQUEST_TIMEOUT_MS
      );
    } catch (err) {
      this.alive = false;
      throw new MiyoUnavailableError(err instanceof Error ? err.message : String(err));
    }

    if (res.ok) return;

    // 507 (out of space) is fatal — propagate as unavailable so the
    // loop aborts. Other 4xx/5xx are per-item failures.
    if (res.status === 507) {
      this.alive = false;
      throw new MiyoUnavailableError('storage_full');
    }
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      if (body.error || body.detail) {
        detail = `${body.error ?? res.status}: ${body.detail ?? ''}`.trim();
      }
    } catch {
      // best-effort
    }
    throw new Error(`POST /v0/file failed: ${detail}`);
  }

  // Generic typed request used by ensureAppFolder and putMetadata.
  // Connection failures mark the client dead; HTTP-level errors
  // throw MiyoUnavailableError too (the alternative — partial state
  // where the client thinks it's connected but Miyo refused — is
  // worse than aborting the run).
  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown
  ): Promise<unknown> {
    if (!this.alive) {
      throw new MiyoUnavailableError('client marked dead');
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${MIYO_BASE}${path}`,
        {
          method,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        REQUEST_TIMEOUT_MS
      );
    } catch (err) {
      this.alive = false;
      throw new MiyoUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      this.alive = false;
      throw new MiyoUnavailableError(`${method} ${path} returned ${res.status}`);
    }
    try {
      return await res.json();
    } catch (err) {
      this.alive = false;
      throw new MiyoUnavailableError(`${method} ${path} body not JSON: ${err}`);
    }
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
