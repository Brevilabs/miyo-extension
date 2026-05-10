// Service worker entry.
//
// Responsibilities:
//   1. Snapshot building for the popup (transport availability +
//      per-site session + buffer counts).
//   2. Session probing — runs each adapter's probeSession on
//      startup, install, and on popup-driven refresh.
//   3. The sync orchestrator's host. The popup opens a port named
//      'sync' and tells us which site to sync; we run runSync and
//      pipe progress back over the port.
//   4. The buffer→Miyo replay host. Same port, different message
//      type. Replay only runs when Miyo is reachable; the popup
//      gates the button on that state.
//
// We deliberately do NOT auto-sync. The only trigger is a user
// clicking Sync now in the popup. There are no alarms, no cookie
// listeners that fan out to fetches, no timers.

import { ADAPTERS, getAdapter } from '../adapters/index.js';
import { runSync } from '../framework/sync.js';
import { runBufferReplay } from '../framework/replay.js';
import { getSiteState, patchSiteState } from '../framework/state.js';
import { getAllSources } from '../framework/buffer.js';
import { snapshotTransports } from '../framework/transports/index.js';
import type { PopupSnapshot, SiteId } from '../framework/types.js';

async function buildSnapshot(): Promise<PopupSnapshot> {
  const [transports, bufferedSources] = await Promise.all([
    snapshotTransports(),
    getAllSources(),
  ]);
  const buffersById = new Map(bufferedSources.map((s) => [s.source_id, s]));
  const sites = await Promise.all(
    ADAPTERS.map(async (a) => {
      const s = await getSiteState(a.id);
      const buf = buffersById.get(a.id);
      return {
        id: a.id,
        label: a.label,
        session: s.last_session,
        last_sync_at: s.last_sync_at,
        last_sync_error: s.last_sync_error,
        buffered_count: buf?.item_count ?? 0,
        last_exported_at: buf?.last_exported_at ?? null,
      };
    })
  );
  return { transports, sites, active_sync: null };
}

async function probeAll(): Promise<void> {
  await Promise.all(
    ADAPTERS.map(async (a) => {
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
          onProgress: ({ completed, total, mode }) => {
            safePost({ type: 'progress', site: adapter.id, completed, total, mode });
          },
        });
        safePost({ type: 'done', site: adapter.id, result });
      })();
      return;
    }

    if (msg?.type === 'replay' && typeof msg.site === 'string') {
      const site = msg.site as SiteId;
      void (async () => {
        const result = await runBufferReplay(site, {
          onProgress: ({ completed, total }) => {
            safePost({ type: 'replay-progress', site, completed, total });
          },
        });
        safePost({ type: 'replay-done', site, result });
      })();
      return;
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void probeAll();
});
chrome.runtime.onStartup.addListener(() => {
  void probeAll();
});
