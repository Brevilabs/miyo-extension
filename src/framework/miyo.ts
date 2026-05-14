// Miyo HTTP client.
//
// Wire protocol is in docs/MIYO_INTERFACE.md. Miyo desktop binds at
// 127.0.0.1:8742. The extension probes /v0/health on every popup
// open with a 1.5s timeout — any failure falls back to local mode
// (Download → zip) silently.
//
// The extension treats Miyo as a content-addressed store. Per-item
// existence checks go through items/missing (bulk). There is no
// metadata blob: Miyo owns the (app_id, item_id) → filename index.

import type { CapturedItem, SiteId } from './types.js';

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
  app_id: string;
  label: string;
  folder_name: string;
  folder_path: string;
  count: number;
}

export class MiyoClient {
  private alive = true;
  public miyoStatus: string = 'unknown';

  private constructor(status: string) {
    this.miyoStatus = status;
  }

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
    // status may be "degraded" (search/embeddings still warming)
    // but capture writes only need service:"running".
    if (body.service !== 'running') {
      throw new MiyoUnavailableError(`service is "${body.service ?? '<unset>'}"`);
    }
    return new MiyoClient(body.status ?? 'unknown');
  }

  isAlive(): boolean {
    return this.alive;
  }

  // Marks the client dead so queued callers short-circuit. The HTTP
  // server keeps running; the next MiyoClient.connect() picks it
  // back up.
  disconnect(): void {
    this.alive = false;
  }

  async ensureAppFolder(appId: SiteId, label: string): Promise<AppFolderInfo> {
    return this.request('POST', `/v0/app-folder`, {
      app_id: appId,
      label,
    }) as Promise<AppFolderInfo>;
  }

  // Bulk presence check. Returns the subset of itemIds that Miyo
  // doesn't yet have. One HTTP call per source page; the capture
  // loop diffs each list page through this.
  async filterMissing(appId: SiteId, itemIds: string[]): Promise<string[]> {
    if (itemIds.length === 0) return [];
    const result = (await this.request(
      'POST',
      `/v0/app-folder/${encodeURIComponent(appId)}/items/missing`,
      { item_ids: itemIds }
    )) as { missing?: unknown };
    return Array.isArray(result.missing)
      ? result.missing.filter((s): s is string => typeof s === 'string')
      : [];
  }

  // Write one captured item. item_id is forwarded so Miyo can index
  // (app_id, item_id) → filename for the next filterMissing call.
  //
  // Throws MiyoUnavailableError on connection failure or storage-full;
  // throws a plain Error on per-item failures (4xx/5xx other than 507)
  // — the capture loop counts those as errors and continues.
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
            item_id: item.item_id,
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

  // HTTP-level errors throw MiyoUnavailableError too — the alternative
  // (client thinks it's connected but Miyo refused) is worse than
  // aborting the run.
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
