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
import type { PopupSnapshot, SiteAdapter, SiteRowSnapshot } from '../framework/types.js';

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

  let safePost = (msg: unknown): void => {
    try {
      port.postMessage(msg);
    } catch {
      // Popup closed — work continues silently to completion.
    }
  };
  port.onDisconnect.addListener(() => {
    safePost = () => {};
  });

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'start' && typeof msg.site === 'string') {
      const adapter = getAdapter(msg.site);
      if (!adapter) {
        safePost({
          type: 'done',
          site: msg.site,
          result: { kind: 'aborted', reason: 'unknown_site' },
        });
        return;
      }
      void (async () => {
        const result = await runSync(adapter, {
          onProgress: ({ completed, total }) => {
            safePost({ type: 'progress', site: adapter.id, completed, total });
          },
        });
        safePost({ type: 'done', site: adapter.id, result });
      })();
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void probeAll();
});
chrome.runtime.onStartup.addListener(() => {
  void probeAll();
});
