// Service worker entry.
//
// Responsibilities:
//   1. Snapshot building for the popup. Composes per-site config
//      (enabled / paused / destination), state (session, last sync),
//      and folder-derived info (capture count read from the
//      .miyo-capture.json in the destination folder, when available).
//   2. Session probing — runs each enabled adapter's probeSession on
//      startup, install, and on popup-driven refresh.
//   3. The sync orchestrator's host. The popup opens a port named
//      'sync' and tells us which site to sync; we run runSync and
//      pipe progress back over the port.
//
// We deliberately do NOT auto-sync. The only trigger is a user
// clicking Sync now in the popup. There are no alarms, no cookie
// listeners that fan out to fetches, no timers.
//
// Per-site config writes (enable / disable / pause / resume / set
// destination) are handled directly by the popup writing to
// chrome.storage.local and IndexedDB. They do not require the
// background to mediate.

import { ADAPTERS, getAdapter } from '../adapters/index.js';
import { runSync } from '../framework/sync.js';
import { getSiteState, patchSiteState } from '../framework/state.js';
import { getSiteConfig, getFolderHandle } from '../framework/destinations.js';
import { makeWriter } from '../framework/writer.js';
import type {
  PopupSnapshot,
  SiteAdapter,
  SiteId,
  SiteRowSnapshot,
} from '../framework/types.js';

// ──────────────────────────────────────────────────────────────────
// Keepalive
// ──────────────────────────────────────────────────────────────────
//
// MV3 service workers are idle-killed after ~30s without chrome.* API
// events. A long-running sync mostly awaits fetch() and IndexedDB,
// which reset the timer most of the time but not reliably between
// fetches. We belt-and-suspender with chrome.alarms: a recurring alarm
// is a chrome event that wakes the SW even if it had gone idle, and
// (more importantly) keeps it from being marked idle in the first
// place. The listener does nothing — the wake-up itself is the point.

const KEEPALIVE_ALARM = 'sync-keepalive';

function startKeepalive(): void {
  // 30s is the minimum periodInMinutes-supported interval (0.5 min).
  // Right at the idle threshold, but reliable in practice because the
  // alarm fires *as* the SW is about to go idle, not after.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

function stopKeepalive(): void {
  void chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener(() => {
  // Wake-up only; the SW running this listener is itself the work.
});

// ──────────────────────────────────────────────────────────────────
// In-flight sync tracking
// ──────────────────────────────────────────────────────────────────
//
// One sync run at a time across all sites. Subscribers (popup ports)
// can attach mid-run; they all see the same progress stream. The
// active_sync entry in chrome.storage.local mirrors `runningSync.siteId`
// for the popup to read on init — necessary because a freshly-opened
// popup gets a new document context and doesn't know what the SW is
// doing until it asks.

interface RunningSync {
  siteId: SiteId;
  subscribers: Set<chrome.runtime.Port>;
  progress: { completed: number; total: number | null };
}

let runningSync: RunningSync | null = null;

const ACTIVE_SYNC_KEY = 'active_sync';

async function setActiveSyncState(site: SiteId | null): Promise<void> {
  if (site === null) {
    await chrome.storage.local.remove(ACTIVE_SYNC_KEY);
  } else {
    await chrome.storage.local.set({
      [ACTIVE_SYNC_KEY]: { site, started_at: Date.now() },
    });
  }
}

function broadcastToSubscribers(entry: RunningSync, msg: unknown): void {
  for (const port of entry.subscribers) {
    try {
      port.postMessage(msg);
    } catch {
      // Subscriber's popup closed; will be cleaned up on its own
      // onDisconnect. Ignore here.
    }
  }
}

async function buildSiteRow(adapter: SiteAdapter): Promise<SiteRowSnapshot> {
  const [config, state] = await Promise.all([
    getSiteConfig(adapter.id),
    getSiteState(adapter.id),
  ]);

  let destinationLabel: string | null = null;
  let destinationMissing = false;
  let capturesCount: number | null = null;

  if (config.destination?.kind === 'downloads') {
    destinationLabel = `~/Downloads/${config.destination.subpath}`;
  } else if (config.destination?.kind === 'folder') {
    const handle = await getFolderHandle(adapter.id);
    if (!handle) {
      destinationMissing = true;
      destinationLabel = '(folder no longer available)';
    } else {
      destinationLabel = handle.name;
      // Best-effort read of meta to surface the capture count. Failures
      // here (including permission issues) just leave the count null —
      // we don't try to diagnose permission state from the SW since
      // queryPermission cross-context is unreliable. The popup does
      // the real permission check in its window context.
      try {
        const wr = await makeWriter(adapter.id, config);
        if (wr.ok) {
          const meta = await wr.writer.readMeta();
          if (meta) capturesCount = Object.keys(meta.captures).length;
        }
      } catch {
        // Ignored; popup will reconcile.
      }
    }
  }

  return {
    id: adapter.id,
    label: adapter.label,
    home_url: adapter.home_url,
    enabled: config.enabled,
    paused: config.paused,
    destination_kind: config.destination?.kind ?? null,
    destination_label: destinationLabel,
    destination_missing: destinationMissing,
    // destination_needs_reauth is filled in by the popup — the SW
    // cannot reliably read FS Access permission state cross-context.
    destination_needs_reauth: false,
    captures_count: capturesCount,
    session: state.last_session,
    last_sync_at: state.last_sync_at,
    last_sync_error: state.last_sync_error,
  };
}

async function buildSnapshot(): Promise<PopupSnapshot> {
  const sites = await Promise.all(ADAPTERS.map(buildSiteRow));
  return {
    sites,
    active_sync: null,
  };
}

async function probeAll(): Promise<void> {
  // Only probe enabled sites — no need to hit network for sites the
  // user hasn't opted into.
  await Promise.all(
    ADAPTERS.map(async (a) => {
      const config = await getSiteConfig(a.id);
      if (!config.enabled) return;
      try {
        const session = await a.probeSession();
        await patchSiteState(a.id, { last_session: session, last_probe_at: Date.now() });
      } catch {
        await patchSiteState(a.id, {
          last_session: { signedIn: false, email: null },
          last_probe_at: Date.now(),
        });
      }
    })
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'open' || msg?.type === 'probe') {
        await probeAll();
        sendResponse(await buildSnapshot());
        return;
      }
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
  if (port.name !== 'sync') return;

  const safePost = (msg: unknown): void => {
    try {
      port.postMessage(msg);
    } catch {
      // Port already disconnected; ignored.
    }
  };

  port.onDisconnect.addListener(() => {
    if (runningSync) runningSync.subscribers.delete(port);
  });

  port.onMessage.addListener((msg) => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: string; site?: string };

    // Re-attach from a freshly-opened popup. No new run, no permission
    // check — the SW already has whatever access it needed for the
    // in-flight sync.
    if (m.type === 'attach' && typeof m.site === 'string') {
      if (runningSync && runningSync.siteId === m.site) {
        runningSync.subscribers.add(port);
        safePost({
          type: 'progress',
          site: m.site,
          completed: runningSync.progress.completed,
          total: runningSync.progress.total,
        });
      } else {
        // No matching run. The popup will clear its stale active_sync
        // and re-render to the idle state.
        safePost({ type: 'not_running', site: m.site });
      }
      return;
    }

    if (m.type !== 'start' || typeof m.site !== 'string') return;

    const adapter = getAdapter(m.site);
    if (!adapter) {
      safePost({
        type: 'done',
        site: m.site,
        result: { kind: 'aborted', reason: 'unknown_site' },
      });
      return;
    }

    // Dedup: if this site is already syncing, attach instead of starting
    // a second concurrent run.
    if (runningSync && runningSync.siteId === adapter.id) {
      runningSync.subscribers.add(port);
      safePost({
        type: 'progress',
        site: adapter.id,
        completed: runningSync.progress.completed,
        total: runningSync.progress.total,
      });
      return;
    }

    // A different site is already syncing — refuse, surface as aborted.
    if (runningSync) {
      safePost({
        type: 'done',
        site: adapter.id,
        result: { kind: 'aborted', reason: 'busy' },
      });
      return;
    }

    // Start a fresh run.
    const entry: RunningSync = {
      siteId: adapter.id,
      subscribers: new Set([port]),
      progress: { completed: 0, total: null },
    };
    runningSync = entry;
    startKeepalive();
    void setActiveSyncState(adapter.id);

    void (async () => {
      try {
        const result = await runSync(adapter, {
          onProgress: ({ completed, total }) => {
            entry.progress = { completed, total };
            broadcastToSubscribers(entry, {
              type: 'progress',
              site: adapter.id,
              completed,
              total,
            });
          },
        });
        broadcastToSubscribers(entry, { type: 'done', site: adapter.id, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        broadcastToSubscribers(entry, {
          type: 'done',
          site: adapter.id,
          result: { kind: 'aborted', reason: message },
        });
      } finally {
        if (runningSync === entry) runningSync = null;
        stopKeepalive();
        await setActiveSyncState(null);
      }
    })();
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void probeAll();
});
chrome.runtime.onStartup.addListener(() => {
  void probeAll();
});
