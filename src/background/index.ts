// Service worker entry.
//
// Responsibilities:
//   1. Snapshot building for the popup (library state + per-site
//      session/sync state, all read from chrome.storage.local).
//   2. Session probing — runs each adapter's probeSession on
//      startup, install, and on popup-driven refresh.
//   3. The sync orchestrator's host. The popup opens a port named
//      'sync' and tells us which site to sync; we run runSync and
//      pipe progress back over the port.
//
// We deliberately do NOT auto-sync. The only trigger is a user
// clicking Sync now in the popup. There are no alarms, no cookie
// listeners that fan out to fetches, no timers.

import { ADAPTERS, getAdapter } from '../adapters/index.js';
import { runSync } from '../framework/sync.js';
import { getSiteState, patchSiteState } from '../framework/state.js';
import {
  getStoredLibraryHandle,
  queryLibraryPermission,
} from '../framework/storage.js';
import type { PopupSnapshot } from '../framework/types.js';

async function describeLibrary(): Promise<PopupSnapshot['library']> {
  const handle = await getStoredLibraryHandle();
  if (!handle) return { state: 'unset' };
  try {
    const perm = await queryLibraryPermission(handle);
    return perm === 'granted' ? { state: 'granted' } : { state: 'permission_required' };
  } catch (err) {
    return { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function buildSnapshot(): Promise<PopupSnapshot> {
  const library = await describeLibrary();
  const sites = await Promise.all(
    ADAPTERS.map(async (a) => {
      const s = await getSiteState(a.id);
      return {
        id: a.id,
        label: a.label,
        session: s.last_session,
        last_sync_at: s.last_sync_at,
        last_sync_error: s.last_sync_error,
      };
    })
  );
  return { library, sites, active_sync: null };
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
      // Popup closed — sync continues silently to completion.
    }
  };
  port.onDisconnect.addListener(() => {
    safePost = () => {};
  });

  port.onMessage.addListener((msg) => {
    if (msg?.type !== 'start' || typeof msg.site !== 'string') return;
    const adapter = getAdapter(msg.site);
    if (!adapter) {
      safePost({ type: 'done', site: msg.site, result: { kind: 'aborted', reason: 'unknown_site' } });
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
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void probeAll();
});
chrome.runtime.onStartup.addListener(() => {
  void probeAll();
});
