// Per-site request pacing.
//
// One global pacer per site keeps a strict floor between fetches so the
// extension never produces request bursts that look like scraping
// behavior to bot detection. Backoff multiplies the floor on
// 429/5xx responses.
//
// All adapters route their network calls through `paced(site, fn)` —
// they cannot opt out. This is structural: the per-site pacer is the
// only way the framework keeps every adapter honest.
//
// Pacer state is mirrored to chrome.storage.session so that a service-
// worker death (idle, crash, browser internals) does not reset the
// backoff multiplier. Without this, a 429 that escalated backoff to
// 30s would be forgotten on the next SW wake — the next call would
// fire immediately and re-hit the rate limit. We use session storage
// (not local) because pacer state is meaningful only within a single
// browser session; once the browser fully restarts, a fresh start
// from FLOOR_MS is fine.

const FLOOR_MS = 1500;
const BACKOFF_MAX_MS = 60_000;

interface PacerState {
  // Earliest moment the next request is allowed to start.
  earliest_at: number;
  // Current backoff multiplier; resets to 1 after a successful call.
  backoff: number;
}

const pacers = new Map<string, PacerState>();
const loadedSites = new Set<string>();

function pacerStorageKey(site: string): string {
  return `pacer:${site}`;
}

async function loadPacer(site: string): Promise<PacerState> {
  if (!loadedSites.has(site)) {
    const key = pacerStorageKey(site);
    try {
      const obj = await chrome.storage.session.get(key);
      const stored = obj[key] as PacerState | undefined;
      if (stored && typeof stored.earliest_at === 'number' && typeof stored.backoff === 'number') {
        pacers.set(site, { earliest_at: stored.earliest_at, backoff: stored.backoff });
      }
    } catch {
      // session storage unavailable (e.g., in tests). Fall back to
      // ephemeral state — same behavior as before this change.
    }
    loadedSites.add(site);
  }
  let p = pacers.get(site);
  if (!p) {
    p = { earliest_at: 0, backoff: 1 };
    pacers.set(site, p);
  }
  return p;
}

async function savePacer(site: string, state: PacerState): Promise<void> {
  try {
    await chrome.storage.session.set({ [pacerStorageKey(site)]: state });
  } catch {
    // Same fallback as loadPacer — pacer continues to work in memory.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class FatalError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'FatalError';
  }
}

export async function paced<T>(site: string, fn: () => Promise<T>): Promise<T> {
  const pacer = await loadPacer(site);
  const wait = pacer.earliest_at - Date.now();
  if (wait > 0) await sleep(wait);

  try {
    const result = await fn();
    pacer.backoff = 1;
    pacer.earliest_at = Date.now() + FLOOR_MS;
    await savePacer(site, pacer);
    return result;
  } catch (err) {
    // On a retryable error, advance the floor by an exponentially
    // growing backoff before re-throwing so the next paced call this
    // site makes waits longer. We do not retry here — that's the
    // sync orchestrator's job; pacing just sets the floor.
    if (err instanceof RetryableError) {
      pacer.backoff = Math.min(pacer.backoff * 2, BACKOFF_MAX_MS / FLOOR_MS);
      pacer.earliest_at = Date.now() + FLOOR_MS * pacer.backoff;
    } else {
      pacer.earliest_at = Date.now() + FLOOR_MS;
    }
    await savePacer(site, pacer);
    throw err;
  }
}

// Helper for adapters: classify a fetch Response into pacer-aware
// errors. 429 and 5xx → retryable; 401/403 → fatal sign-in needed;
// other 4xx → fatal protocol error.
export async function classifyHttp(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  const summary = body.slice(0, 200);
  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(`${label} → ${res.status}: ${summary}`, res.status);
  }
  throw new FatalError(`${label} → ${res.status}: ${summary}`, res.status);
}
