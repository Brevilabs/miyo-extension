// Service worker entry.
//
// Responsibilities, in order of complexity:
//
//   1. Snapshot building. The popup opens a port and asks for a
//      snapshot; we probe each site's session, try to talk to Miyo,
//      and (when Miyo answers) compute a per-site delta count. The
//      whole probe completes in ~1 s and the popup renders once.
//
//   2. Capture dispatch. The popup tells us to capture a site in
//      either 'zip' or 'miyo' mode; we own the run so it survives
//      popup-close. Progress streams back over the port.
//
//   3. Badge animation while a run is in flight.
//
// What we DO NOT do anymore:
//   • chrome.alarms keepalive. A 200-item run finishes well inside
//     the SW idle threshold; if it dies, the cache (zip) or Miyo's
//     index (Miyo) makes the retry idempotent.
//   • Folder permissions, destinations, downloads-fallback. All gone.
//   • Per-site state, sync progress, meta reconciliation. All gone.

import { ADAPTERS, getAdapter } from '../adapters/index.js';
import {
  captureForExport,
  captureToMiyo,
  indexFromMetadata,
  probeMiyoDelta,
} from '../framework/capture.js';
import { cachedCount } from '../framework/cache.js';
import { MiyoClient, MiyoUnavailableError } from '../framework/miyo.js';
import type {
  PopupSnapshot,
  SiteAdapter,
  SiteId,
  SiteRow,
  SiteSession,
  TimeRange,
} from '../framework/types.js';
import { DEFAULT_TIME_RANGE } from '../framework/types.js';

// Convert a TimeRange to an epoch-ms window [sinceMs, untilMs) for
// capture filtering. Either bound may be null for open-ended.
//
// Presets are now-relative: untilMs is open-ended (null) so newly
// arrived items are included. Custom uses an inclusive end date:
// untilMs is set to the day *after* `untilISODate` at 00:00 local, so
// the user-picked end date is fully included in the window.
function rangeToWindow(range: TimeRange): {
  sinceMs: number | null;
  untilMs: number | null;
} {
  const DAY_MS = 86_400_000;
  if (range.kind === 'custom') {
    const sinceMs = Date.parse(`${range.sinceISODate}T00:00`);
    const untilStart = new Date(`${range.untilISODate}T00:00`);
    const untilMs = Number.isFinite(untilStart.getTime())
      ? untilStart.getTime() + DAY_MS // exclusive upper = start of next day
      : null;
    return {
      sinceMs: Number.isFinite(sinceMs) ? sinceMs : null,
      untilMs,
    };
  }
  const now = Date.now();
  let sinceMs: number | null;
  switch (range.preset) {
    case '24h':
      sinceMs = now - DAY_MS;
      break;
    case '7d':
      sinceMs = now - 7 * DAY_MS;
      break;
    case '30d':
      sinceMs = now - 30 * DAY_MS;
      break;
    case '90d':
      sinceMs = now - 90 * DAY_MS;
      break;
    case 'all':
      sinceMs = null;
      break;
  }
  return { sinceMs, untilMs: null };
}

// ──────────────────────────────────────────────────────────────────
// Miyo client lifecycle
// ──────────────────────────────────────────────────────────────────
//
// One MiyoClient cache pointer in the SW. Re-probed fresh on every
// popup snapshot (`forceProbe: true`) so the connected/disconnected
// state always reflects Miyo's current liveness — not a stale "we
// connected earlier this session" reading. Within a single capture
// run, the run holds its own client reference, so wiping the cache
// here doesn't disturb it.
//
// For non-snapshot callers (the capture dispatch path), we still
// reuse the cache if it's alive — a single popup interaction does
// snapshot → start capture, so the capture inherits the fresh probe.

let miyo: MiyoClient | null = null;

async function getMiyo(forceProbe = false): Promise<MiyoClient | null> {
  if (!forceProbe && miyo && miyo.isAlive()) return miyo;
  // Drop the cache pointer (do NOT call disconnect() — that would
  // mark an in-flight capture's client dead).
  miyo = null;
  try {
    miyo = await MiyoClient.connect();
    return miyo;
  } catch (err) {
    // Expected for every user without the Miyo desktop app — keep
    // quiet here, the zip-mode UI is the answer.
    if (!(err instanceof MiyoUnavailableError)) {
      console.warn('miyo connect failed', err);
    }
    miyo = null;
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Snapshot
// ──────────────────────────────────────────────────────────────────

async function probeSession(adapter: SiteAdapter): Promise<SiteSession> {
  try {
    return await adapter.probeSession();
  } catch {
    return { signedIn: false, email: null };
  }
}

async function buildRow(
  adapter: SiteAdapter,
  miyoIndexFor: Map<string, string> | null
): Promise<SiteRow> {
  const sessionPromise = probeSession(adapter);

  // When Miyo is connected we compute the live delta against its
  // index. The probe is a single listItems call per site, paged up to
  // MAX_PROBE_PAGES (see capture.ts) — fast enough for popup open.
  let miyoTotal: number | null = null;
  let newAvailable: number | null = null;
  let newSaturated = false;

  if (miyoIndexFor) {
    miyoTotal = miyoIndexFor.size;
    const session = await sessionPromise;
    if (session.signedIn) {
      try {
        const probe = await probeMiyoDelta(adapter, miyoIndexFor);
        newAvailable = probe.count;
        newSaturated = probe.saturated;
      } catch {
        // Best-effort. UI shows "—" for unknown counts.
      }
    }
  }

  const cached = miyoIndexFor === null ? await cachedCount(adapter.id) : null;
  const session = await sessionPromise;

  return {
    id: adapter.id,
    label: adapter.label,
    home_url: adapter.home_url,
    brand_color: adapter.brand_color ?? null,
    session,
    cached_count: cached,
    miyo_total: miyoTotal,
    new_available: newAvailable,
    new_available_saturated: newSaturated,
  };
}

async function buildSnapshot(): Promise<PopupSnapshot> {
  // Force a fresh /v0/health probe on every popup open — see getMiyo()
  // comment for why we drop the cache here.
  const client = await getMiyo(true);
  let miyoIndices: Map<SiteId, Map<string, string>> | null = null;

  if (client) {
    miyoIndices = new Map();
    // Ensure the app folder + read metadata for each source in
    // parallel. ensureAppFolder is idempotent and returns the
    // existing metadata inline so we don't need a second GET.
    // Tolerate per-source failure — show "—" for that row instead
    // of failing the whole snapshot.
    await Promise.all(
      ADAPTERS.map(async (a) => {
        try {
          const info = await client.ensureAppFolder(a.id, a.label);
          miyoIndices!.set(a.id, indexFromMetadata(info.metadata));
        } catch {
          miyoIndices!.set(a.id, new Map());
        }
      })
    );
  }

  const sites = await Promise.all(
    ADAPTERS.map((a) => buildRow(a, miyoIndices?.get(a.id) ?? null))
  );

  const snapshot: PopupSnapshot = {
    miyo_connected: client !== null,
    sites,
  };

  // Cache for stale-while-revalidate in the popup. Best-effort —
  // a storage write failure shouldn't fail the snapshot.
  void chrome.storage.local.set({ last_snapshot: snapshot });

  return snapshot;
}

// ──────────────────────────────────────────────────────────────────
// Toolbar badge — capture-in-progress indicator
// ──────────────────────────────────────────────────────────────────

const BADGE_FRAMES = ['•', '• •', '• • •'];
const BADGE_FRAME_MS = 450;
const BADGE_COLOR = '#0f766e';

let badgeAnimationTimer: ReturnType<typeof setInterval> | null = null;

function showBadge(label: string): void {
  void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  void chrome.action.setTitle({ title: `Miyo Capture — capturing ${label}…` });
  let frame = 0;
  void chrome.action.setBadgeText({ text: BADGE_FRAMES[frame]! });
  if (badgeAnimationTimer !== null) clearInterval(badgeAnimationTimer);
  badgeAnimationTimer = setInterval(() => {
    frame = (frame + 1) % BADGE_FRAMES.length;
    void chrome.action.setBadgeText({ text: BADGE_FRAMES[frame]! });
  }, BADGE_FRAME_MS);
}

function clearBadge(): void {
  if (badgeAnimationTimer !== null) {
    clearInterval(badgeAnimationTimer);
    badgeAnimationTimer = null;
  }
  void chrome.action.setBadgeText({ text: '' });
  void chrome.action.setTitle({ title: 'Miyo Capture' });
}

// Defensive: on SW wake-up, runningRun is null but the badge state
// is owned by the browser and may have survived a previous instance's
// death. Clear it once at module load.
clearBadge();

// ──────────────────────────────────────────────────────────────────
// Capture run dispatch
// ──────────────────────────────────────────────────────────────────

interface RunningRun {
  siteId: SiteId;
  mode: 'zip' | 'miyo';
  subscribers: Set<chrome.runtime.Port>;
  progress: { phase: 'listing' | 'fetching'; completed: number; total: number | null };
  cancelRequested: boolean;
}

let runningRun: RunningRun | null = null;
const ACTIVE_RUN_KEY = 'active_run';

async function setActiveRunMirror(siteId: SiteId | null): Promise<void> {
  if (siteId === null) {
    await chrome.storage.local.remove(ACTIVE_RUN_KEY);
  } else {
    await chrome.storage.local.set({
      [ACTIVE_RUN_KEY]: { site: siteId, started_at: Date.now() },
    });
  }
}

function broadcast(entry: RunningRun, msg: unknown): void {
  for (const port of entry.subscribers) {
    try {
      port.postMessage(msg);
    } catch {
      // Subscriber gone; cleanup happens via onDisconnect.
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'snapshot') {
        sendResponse(await buildSnapshot());
        return;
      }
      sendResponse({ error: 'unknown_message' });
    } catch (err) {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'capture') return;

  const safePost = (msg: unknown): void => {
    try {
      port.postMessage(msg);
    } catch {
      // already gone
    }
  };

  port.onDisconnect.addListener(() => {
    if (runningRun) runningRun.subscribers.delete(port);
  });

  port.onMessage.addListener((msg) => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as {
      type?: string;
      site?: string;
      mode?: 'zip' | 'miyo';
      range?: TimeRange;
    };

    if (m.type === 'cancel' && typeof m.site === 'string') {
      if (runningRun && runningRun.siteId === m.site) {
        runningRun.cancelRequested = true;
      }
      return;
    }

    if (m.type === 'attach' && typeof m.site === 'string') {
      if (runningRun && runningRun.siteId === m.site) {
        runningRun.subscribers.add(port);
        safePost({
          type: 'progress',
          site: m.site,
          phase: runningRun.progress.phase,
          completed: runningRun.progress.completed,
          total: runningRun.progress.total,
        });
      } else {
        safePost({ type: 'not_running', site: m.site });
      }
      return;
    }

    if (m.type !== 'start' || typeof m.site !== 'string') return;
    if (m.mode !== 'zip' && m.mode !== 'miyo') return;

    const adapter = getAdapter(m.site);
    if (!adapter) {
      safePost({
        type: 'done',
        site: m.site,
        result: { kind: 'aborted', reason: 'unknown_site' },
      });
      return;
    }

    // Reattach if this site is already running.
    if (runningRun && runningRun.siteId === adapter.id) {
      runningRun.subscribers.add(port);
      safePost({
        type: 'progress',
        site: adapter.id,
        phase: runningRun.progress.phase,
        completed: runningRun.progress.completed,
        total: runningRun.progress.total,
      });
      return;
    }

    if (runningRun) {
      safePost({
        type: 'done',
        site: adapter.id,
        result: { kind: 'aborted', reason: 'busy' },
      });
      return;
    }

    const entry: RunningRun = {
      siteId: adapter.id,
      mode: m.mode,
      subscribers: new Set([port]),
      progress: { phase: 'listing', completed: 0, total: null },
      cancelRequested: false,
    };
    runningRun = entry;
    showBadge(adapter.label);
    void setActiveRunMirror(adapter.id);

    void (async () => {
      try {
        const callbacks = {
          onProgress: ({
            phase,
            completed,
            total,
          }: {
            phase: 'listing' | 'fetching';
            completed: number;
            total: number | null;
          }) => {
            entry.progress = { phase, completed, total };
            broadcast(entry, {
              type: 'progress',
              site: adapter.id,
              phase,
              completed,
              total,
            });
          },
          isCancelled: () => entry.cancelRequested,
        };

        let result;
        if (m.mode === 'miyo') {
          const client = await getMiyo();
          if (!client) {
            result = { kind: 'aborted' as const, reason: 'miyo_unavailable' };
          } else {
            result = await captureToMiyo(adapter, client, callbacks);
          }
        } else {
          const range: TimeRange = m.range ?? DEFAULT_TIME_RANGE;
          const { sinceMs, untilMs } = rangeToWindow(range);
          result = await captureForExport(adapter, sinceMs, untilMs, callbacks);
        }
        broadcast(entry, { type: 'done', site: adapter.id, result });
      } catch (err) {
        broadcast(entry, {
          type: 'done',
          site: adapter.id,
          result: {
            kind: 'aborted',
            reason: err instanceof Error ? err.message : String(err),
          },
        });
      } finally {
        if (runningRun === entry) runningRun = null;
        clearBadge();
        await setActiveRunMirror(null);
      }
    })();
  });
});
