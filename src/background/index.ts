// Service worker entry.
//
// Responsibilities:
//
//   1. Snapshot building. The popup asks for a snapshot; we probe
//      each site's session in parallel and check whether Miyo is
//      reachable. No per-site Miyo round trips — the popup only
//      needs connectivity + session, not counts.
//
//   2. Capture dispatch. The popup tells us to capture a site in
//      either 'local' or 'miyo' mode; we own the run so it survives
//      popup-close. Progress streams back over the port. Cancel and
//      Pause are flags read by the capture loop's shouldStop hook.
//
//   3. Badge animation while a run is in flight.

import { ADAPTERS, getAdapter } from '../adapters/index.js';
import { captureToStore } from '../framework/capture.js';
import { IdbStore, MiyoStore } from '../framework/capture-store.js';
import type { Store } from '../framework/capture-store.js';
import { MiyoClient, MiyoUnavailableError } from '../framework/miyo.js';
import { clearItems } from '../framework/store.js';
import {
  clearPendingRun,
  readPendingRun,
  updatePendingRun,
  writePendingRun,
} from '../framework/run-state.js';
import type {
  CaptureMode,
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
    // quiet here, the local-mode (Download) UI is the answer.
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

async function buildRow(adapter: SiteAdapter): Promise<SiteRow> {
  const session = await probeSession(adapter);
  return {
    id: adapter.id,
    label: adapter.label,
    home_url: adapter.home_url,
    brand_color: adapter.brand_color ?? null,
    session,
  };
}

async function buildSnapshot(): Promise<PopupSnapshot> {
  const client = await getMiyo(true);
  const [sites, pendingRun] = await Promise.all([
    Promise.all(ADAPTERS.map((a) => buildRow(a))),
    readPendingRun(),
  ]);

  const snapshot: PopupSnapshot = {
    miyo_connected: client !== null,
    sites,
    pending_run: pendingRun,
  };

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
  mode: CaptureMode;
  subscribers: Set<chrome.runtime.Port>;
  progress: { phase: 'listing' | 'fetching'; completed: number; total: number | null };
  cancelRequested: boolean;
  // Soft halt: capture flushes its state and returns aborted/paused;
  // pending_run is left intact so Resume picks up at the same cursor.
  pauseRequested: boolean;
}

let runningRun: RunningRun | null = null;

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
      mode?: CaptureMode;
      range?: TimeRange;
    };

    if (m.type === 'cancel' && typeof m.site === 'string') {
      if (runningRun && runningRun.siteId === m.site) {
        runningRun.cancelRequested = true;
      }
      return;
    }

    if (m.type === 'pause' && typeof m.site === 'string') {
      if (runningRun && runningRun.siteId === m.site) {
        runningRun.pauseRequested = true;
      }
      return;
    }

    if (m.type === 'discard') {
      void (async () => {
        if (runningRun?.mode === 'local') {
          runningRun.cancelRequested = true;
        }
        const run = await readPendingRun();
        if (run) {
          await clearItems(run.siteId);
          await clearPendingRun();
        }
      })();
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

    const isStart = m.type === 'start' && typeof m.site === 'string';
    const isResume = m.type === 'resume';
    if (!isStart && !isResume) return;

    void (async () => {
      let siteId: SiteId;
      let mode: CaptureMode;
      let range: TimeRange | null;

      if (isResume) {
        const run = await readPendingRun();
        if (!run) {
          safePost({
            type: 'done',
            site: '',
            result: { kind: 'aborted', reason: 'no_pending_run' },
          });
          return;
        }
        siteId = run.siteId;
        mode = run.mode;
        range = run.range;
        await writePendingRun({ ...run, status: 'capturing' });
      } else {
        if (m.mode !== 'local' && m.mode !== 'miyo') return;
        siteId = m.site as SiteId;
        mode = m.mode;
        range = m.range ?? null;
      }

      const adapter = getAdapter(siteId);
      if (!adapter) {
        safePost({
          type: 'done',
          site: siteId,
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

      if (!isResume) {
        const existing = await readPendingRun();
        if (existing) {
          safePost({
            type: 'done',
            site: adapter.id,
            result: { kind: 'aborted', reason: 'pending_run_exists' },
          });
          return;
        }
        const usedRange: TimeRange = range ?? DEFAULT_TIME_RANGE;
        await writePendingRun({
          siteId: adapter.id,
          mode,
          range: usedRange,
          started_at: Date.now(),
          status: 'capturing',
          written: 0,
          errors: 0,
          cursor: null,
        });
        range = usedRange;
      }

      const resumeFrom = isResume ? (await readPendingRun())?.written ?? 0 : 0;
      const entry: RunningRun = {
        siteId: adapter.id,
        mode,
        subscribers: new Set([port]),
        progress: {
          phase: 'listing',
          completed: resumeFrom,
          total: null,
        },
        cancelRequested: false,
        pauseRequested: false,
      };
      runningRun = entry;
      showBadge(adapter.label);

      try {
        const callbacks = {
          onProgress: ({
            phase,
            completed,
            total,
            note,
          }: {
            phase: 'listing' | 'fetching';
            completed: number;
            total: number | null;
            note?: string;
          }) => {
            entry.progress = { phase, completed, total };
            broadcast(entry, {
              type: 'progress',
              site: adapter.id,
              phase,
              completed,
              total,
              note,
            });
          },
          shouldStop: () =>
            entry.cancelRequested ? 'cancelled' : entry.pauseRequested ? 'paused' : null,
        };

        const usedRange: TimeRange = range ?? DEFAULT_TIME_RANGE;
        const { sinceMs, untilMs } = rangeToWindow(usedRange);

        let store: Store;
        let result;
        if (mode === 'miyo') {
          const client = await getMiyo();
          if (!client) {
            result = { kind: 'aborted' as const, reason: 'miyo_unavailable' };
          } else {
            try {
              const folder = await client.ensureAppFolder(adapter.id, adapter.label);
              store = new MiyoStore(client, adapter.id, folder.folder_name);
            } catch (err) {
              const reason =
                err instanceof MiyoUnavailableError
                  ? 'miyo_unavailable'
                  : err instanceof Error
                    ? err.message
                    : String(err);
              result = { kind: 'aborted' as const, reason };
              store = null as unknown as Store;
            }
            if (!result) {
              result = await captureToStore(
                adapter,
                store!,
                'miyo',
                sinceMs,
                untilMs,
                callbacks
              );
            }
          }
        } else {
          store = new IdbStore(adapter.id);
          result = await captureToStore(
            adapter,
            store,
            'local',
            sinceMs,
            untilMs,
            callbacks
          );
        }

        // 'ready' is the popup's signal to zip+clear (local) or just
        // banner+clear (Miyo). User-Stop wipes everything; other
        // aborts (paused, miyo_unavailable, etc.) leave the record so
        // the user can Resume.
        if (result.kind === 'completed') {
          await updatePendingRun({
            status: 'ready',
            written: result.written,
            errors: result.errors,
          });
        } else if (result.reason === 'cancelled') {
          if (mode === 'local') await clearItems(adapter.id);
          await clearPendingRun();
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
      }
    })();
  });
});
