// Popup UI.
//
// Vanilla DOM, no framework — keeps the extension lean and
// review-friendly.
//
// What the popup shows:
//   1. Transport status banner. Miyo connected → "Saving to Miyo".
//      Miyo not running → standalone-buffer pitch with a "Get Miyo"
//      link as the primary CTA. The pitch is the conversion lever;
//      keep it present, not animated, no modal (extension.md:159).
//   2. Per-site row. Sign-in state, last sync time, sync button.
//      When the local buffer for that source has items, an actions
//      row appears underneath: "Send to Miyo" (only when Miyo is
//      reachable — replays the buffer through the HTTP transport)
//      and "Export to disk" (always present in standalone, opens
//      the export tab to emit a zip via chrome.downloads with a
//      saveAs picker).
//
// Sync writes to the local buffer (or to Miyo over HTTP). It never
// auto-writes to disk. Disk only happens via explicit Export.

import type { PopupSnapshot, SiteId } from '../framework/types.js';
import type { TransportMode } from '../framework/transports/index.js';

type SyncDone = {
  type: 'done';
  site: SiteId;
  result:
    | { kind: 'completed'; written: number; errors: number; mode: TransportMode }
    | { kind: 'paused'; written: number; reason: string; mode: TransportMode }
    | { kind: 'aborted'; reason: string };
};

type ReplayDone = {
  type: 'replay-done';
  site: SiteId;
  result:
    | { kind: 'completed'; replayed: number }
    | { kind: 'aborted'; reason: string; replayed: number };
};

interface UIState {
  snapshot: PopupSnapshot | null;
  initializing: boolean;
  syncing: SiteId | null;
  syncProgress: { completed: number; total: number | null; mode: TransportMode } | null;
  replaying: SiteId | null;
  replayProgress: { completed: number; total: number } | null;
  banner: { kind: 'info' | 'error'; text: string } | null;
}

const ui: UIState = {
  snapshot: null,
  initializing: true,
  syncing: null,
  syncProgress: null,
  replaying: null,
  replayProgress: null,
  banner: null,
};

const root = document.getElementById('root')!;

function fmtTime(ts: number | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString();
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '"'
            ? '&quot;'
            : '&#39;'
  );
}

function transportBlock(): string {
  if (!ui.snapshot) return '';
  const t = ui.snapshot.transports;
  if (t.active === 'miyo') {
    const label = t.miyo.label ?? 'Miyo';
    return `
      <div class="banner ok">
        <div class="row">
          <span class="muted">Connected to ${escape(label)} · indexed for search</span>
        </div>
      </div>`;
  }
  if (t.active === 'buffer') {
    return `
      <div class="banner">
        <div class="row">
          <span><strong>Local-only mode.</strong> <span class="muted">Sync stores locally; export by hand.</span></span>
          <a href="https://miyo.md" target="_blank" rel="noopener">Get Miyo</a>
        </div>
        <div class="row sub">
          <span class="muted">Install Miyo to stream syncs into an indexed library and query your history from any AI via MCP.</span>
        </div>
      </div>`;
  }
  return `
    <div class="banner">
      <span class="error">No delivery transport available. Reload the extension and try again.</span>
    </div>`;
}

function renderSiteRow(s: PopupSnapshot['sites'][number]): string {
  if (!ui.snapshot) return '';
  const transportOk = ui.snapshot.transports.active !== null;
  const miyoActive = ui.snapshot.transports.active === 'miyo';
  const signedIn = !!s.session?.signedIn;
  const isSyncing = ui.syncing === s.id;
  const isReplaying = ui.replaying === s.id;
  const anyBusy = ui.syncing !== null || ui.replaying !== null;
  const syncDisabled = !transportOk || !signedIn || (anyBusy && !isSyncing);

  const meta: string[] = [];
  if (signedIn) {
    meta.push(`<div class="meta">${escape(s.session?.email ?? 'Signed in')}</div>`);
  } else {
    meta.push(
      `<div class="meta muted">Not signed in. Open ${escape(s.label)} in a tab and sign in, then click Refresh.</div>`
    );
  }
  meta.push(`<div class="meta">Last sync: ${fmtTime(s.last_sync_at)}</div>`);
  if (s.buffered_count > 0) {
    const exported = s.last_exported_at ? ` · exported ${fmtTime(s.last_exported_at)}` : '';
    meta.push(
      `<div class="bufinfo">${s.buffered_count} conversation${s.buffered_count === 1 ? '' : 's'} buffered locally${exported}</div>`
    );
  }
  if (s.last_sync_error) {
    meta.push(`<div class="err"><span class="error">${escape(s.last_sync_error)}</span></div>`);
  }

  let progress = '';
  if (isSyncing && ui.syncProgress) {
    const { completed, total } = ui.syncProgress;
    progress = total
      ? `<div class="progress">Fetched ${completed} of ${total}</div>`
      : `<div class="progress">Fetched ${completed}</div>`;
  } else if (isReplaying && ui.replayProgress) {
    const { completed, total } = ui.replayProgress;
    progress = `<div class="progress">Sending ${completed} of ${total} to Miyo…</div>`;
  }

  const syncBtnLabel = isSyncing ? 'Syncing…' : 'Sync';
  let actions = '';
  if (s.buffered_count > 0 && !isSyncing && !isReplaying) {
    const parts: string[] = [];
    if (miyoActive) {
      parts.push(
        `<button class="primary small" data-action="replay" data-site="${escape(s.id)}" ${anyBusy ? 'disabled' : ''}>Send to Miyo</button>`
      );
    }
    parts.push(
      `<button class="link" data-action="export" data-site="${escape(s.id)}" ${anyBusy ? 'disabled' : ''}>Export to disk</button>`
    );
    actions = `<div class="actions">${parts.join('')}</div>`;
  }

  return `
    <div class="site-row">
      <div class="header">
        <span class="label">${escape(s.label)}</span>
        <button class="small" data-action="sync" data-site="${escape(s.id)}" ${syncDisabled ? 'disabled' : ''}>${syncBtnLabel}</button>
      </div>
      ${meta.join('')}
      ${progress}
      ${actions}
    </div>`;
}

function renderSites(): string {
  if (!ui.snapshot) return '';
  return ui.snapshot.sites.map(renderSiteRow).join('');
}

function render(): void {
  if (ui.initializing) {
    root.innerHTML = `<h1>Miyo</h1><p class="muted">Loading…</p>`;
    return;
  }
  root.innerHTML = `
    <h1>Miyo</h1>
    ${
      ui.banner
        ? `<div class="banner"><span class="${ui.banner.kind === 'error' ? 'error' : 'muted'}">${escape(ui.banner.text)}</span></div>`
        : ''
    }
    ${transportBlock()}
    <h2>Sites</h2>
    ${renderSites()}
    <footer>
      <button class="link" data-action="refresh">Refresh</button>
    </footer>
  `;

  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const site = btn.dataset.site as SiteId | undefined;
      if (action === 'sync' && site) void onSync(site);
      else if (action === 'replay' && site) void onReplay(site);
      else if (action === 'export' && site) onExport(site);
      else if (action === 'refresh') void onRefresh();
    });
  });
}

async function onSync(site: SiteId): Promise<void> {
  ui.banner = null;
  if (!ui.snapshot || ui.snapshot.transports.active === null) {
    ui.banner = { kind: 'error', text: 'No delivery transport available.' };
    render();
    return;
  }

  ui.syncing = site;
  ui.syncProgress = { completed: 0, total: null, mode: ui.snapshot.transports.active };
  render();

  const port = chrome.runtime.connect({ name: 'sync' });
  port.postMessage({ type: 'start', site });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'progress' && msg.site === site) {
      ui.syncProgress = { completed: msg.completed, total: msg.total, mode: msg.mode };
      render();
    } else if (msg?.type === 'done') {
      const done = msg as SyncDone;
      ui.syncing = null;
      ui.syncProgress = null;
      if (done.result.kind === 'completed') {
        const dest = done.result.mode === 'miyo' ? 'Miyo' : 'local buffer';
        ui.banner = {
          kind: 'info',
          text:
            done.result.errors > 0
              ? `Synced ${done.result.written} to ${dest} (${done.result.errors} failed).`
              : `Synced ${done.result.written} to ${dest}.`,
        };
      } else if (done.result.kind === 'paused') {
        ui.banner = {
          kind: 'info',
          text: `Paused at ${done.result.written}. Click Sync again to continue.`,
        };
      } else if (done.result.reason === 'miyo_unreachable') {
        ui.banner = {
          kind: 'error',
          text: 'Miyo went away mid-sync. Restart it and click Sync to resume.',
        };
      } else if (done.result.reason === 'no_transport') {
        ui.banner = {
          kind: 'error',
          text: 'No delivery transport available. Reload the extension and try again.',
        };
      } else {
        ui.banner = { kind: 'error', text: `Sync stopped: ${done.result.reason}` };
      }
      port.disconnect();
      void onRefresh();
    }
  });
  port.onDisconnect.addListener(() => {
    if (ui.syncing === site) {
      ui.syncing = null;
      ui.syncProgress = null;
      render();
    }
  });
}

async function onReplay(site: SiteId): Promise<void> {
  ui.banner = null;
  ui.replaying = site;
  ui.replayProgress = { completed: 0, total: 0 };
  render();

  const port = chrome.runtime.connect({ name: 'sync' });
  port.postMessage({ type: 'replay', site });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'replay-progress' && msg.site === site) {
      ui.replayProgress = { completed: msg.completed, total: msg.total };
      render();
    } else if (msg?.type === 'replay-done') {
      const done = msg as ReplayDone;
      ui.replaying = null;
      ui.replayProgress = null;
      if (done.result.kind === 'completed') {
        ui.banner = {
          kind: 'info',
          text:
            done.result.replayed > 0
              ? `Sent ${done.result.replayed} buffered conversation${done.result.replayed === 1 ? '' : 's'} to Miyo.`
              : 'Buffer was already empty.',
        };
      } else if (done.result.reason === 'miyo_unreachable') {
        ui.banner = {
          kind: 'error',
          text: `Miyo unreachable. Sent ${done.result.replayed} so far — restart Miyo and click again to resume.`,
        };
      } else {
        ui.banner = {
          kind: 'error',
          text: `Replay stopped: ${done.result.reason}`,
        };
      }
      port.disconnect();
      void onRefresh();
    }
  });
  port.onDisconnect.addListener(() => {
    if (ui.replaying === site) {
      ui.replaying = null;
      ui.replayProgress = null;
      render();
    }
  });
}

function onExport(site: SiteId): void {
  // Open the dedicated export tab. Doing this in a tab (rather than
  // the popup itself) means the OS save dialog can't yank a closing
  // popup out from under the in-flight blob URL.
  const url = chrome.runtime.getURL(`export.html?source=${encodeURIComponent(site)}`);
  void chrome.tabs.create({ url });
}

async function onRefresh(): Promise<void> {
  try {
    ui.snapshot = (await chrome.runtime.sendMessage({ type: 'probe' })) as PopupSnapshot;
  } catch (err) {
    ui.banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
  }
  render();
}

async function init(): Promise<void> {
  render();
  try {
    ui.snapshot = (await chrome.runtime.sendMessage({ type: 'open' })) as PopupSnapshot;
  } catch (err) {
    ui.banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
  } finally {
    ui.initializing = false;
    render();
  }
}

void init();
