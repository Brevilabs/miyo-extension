// Popup UI.
//
// Vanilla DOM, no framework — keeps the extension lean and
// review-friendly.
//
// The popup's job is to (a) tell the user where files will go (Miyo
// library if Miyo is running, ~/Downloads/Miyo otherwise), (b) show
// per-site sign-in status, and (c) trigger sync runs that the
// background service worker executes.

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

interface UIState {
  snapshot: PopupSnapshot | null;
  initializing: boolean;
  syncing: SiteId | null;
  progress: { completed: number; total: number | null; mode: TransportMode } | null;
  banner: { kind: 'info' | 'error'; text: string } | null;
}

const ui: UIState = {
  snapshot: null,
  initializing: true,
  syncing: null,
  progress: null,
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
          <span class="muted">Saving to ${escape(label)} · indexed for search</span>
        </div>
      </div>`;
  }
  if (t.active === 'downloads') {
    return `
      <div class="banner">
        <div class="row">
          <span class="muted">Saving to <code>~/Downloads/Miyo</code></span>
          <a href="https://miyo.md" target="_blank" rel="noopener">Get Miyo</a>
        </div>
        <div class="row sub">
          <span class="muted">Install Miyo to choose your folder and get indexed search.</span>
        </div>
      </div>`;
  }
  return `
    <div class="banner">
      <span class="error">No delivery transport available. Reload the extension and try again.</span>
    </div>`;
}

function renderSites(): string {
  if (!ui.snapshot) return '';
  const transportOk = ui.snapshot.transports.active !== null;
  const anySyncing = ui.syncing !== null;

  return ui.snapshot.sites
    .map((s) => {
      const signedIn = !!s.session?.signedIn;
      const isCurrent = ui.syncing === s.id;
      const disabled = !transportOk || !signedIn || (anySyncing && !isCurrent);

      const meta: string[] = [];
      if (signedIn) {
        meta.push(`<div class="meta">${escape(s.session?.email ?? 'Signed in')}</div>`);
      } else {
        meta.push(
          `<div class="meta muted">Not signed in. Open ${escape(s.label)} in a tab and sign in, then click Refresh.</div>`
        );
      }
      meta.push(`<div class="meta">Last sync: ${fmtTime(s.last_sync_at)}</div>`);
      if (s.last_sync_error) {
        meta.push(`<div class="err"><span class="error">${escape(s.last_sync_error)}</span></div>`);
      }

      let progress = '';
      if (isCurrent && ui.progress) {
        const { completed, total } = ui.progress;
        progress = total
          ? `<div class="progress">Fetched ${completed} of ${total}</div>`
          : `<div class="progress">Fetched ${completed}</div>`;
      }

      const btnLabel = isCurrent ? 'Syncing…' : 'Sync now';
      return `
        <div class="site-row">
          <div class="label">${escape(s.label)}</div>
          ${meta.join('')}
          ${progress}
          <button data-action="sync" data-site="${escape(s.id)}" ${disabled ? 'disabled' : ''}>
            ${btnLabel}
          </button>
        </div>`;
    })
    .join('');
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
      <button data-action="refresh">Refresh</button>
    </footer>
  `;

  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'sync') void onSync(btn.dataset.site as SiteId);
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
  ui.progress = { completed: 0, total: null, mode: ui.snapshot.transports.active };
  render();

  const port = chrome.runtime.connect({ name: 'sync' });
  port.postMessage({ type: 'start', site });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'progress' && msg.site === site) {
      ui.progress = { completed: msg.completed, total: msg.total, mode: msg.mode };
      render();
    } else if (msg?.type === 'done') {
      const done = msg as SyncDone;
      ui.syncing = null;
      ui.progress = null;
      if (done.result.kind === 'completed') {
        const dest = done.result.mode === 'miyo' ? 'Miyo' : '~/Downloads/Miyo';
        ui.banner = {
          kind: 'info',
          text:
            done.result.errors > 0
              ? `Synced ${done.result.written} to ${dest} (${done.result.errors} failed).`
              : `Synced ${done.result.written} conversations to ${dest}.`,
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
      ui.progress = null;
      render();
    }
  });
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
