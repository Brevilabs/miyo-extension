// Popup UI.
//
// Vanilla DOM, no framework — keeps the extension lean and
// review-friendly.
//
// The extension delivers markdown to the local Miyo desktop app over
// loopback HTTP. The popup's job is to (a) tell the user whether
// Miyo is running, (b) show per-site sign-in status, and (c) trigger
// sync runs that the background service worker executes.

import type { PopupSnapshot, SiteId } from '../framework/types.js';

type SyncDone = {
  type: 'done';
  site: SiteId;
  result:
    | { kind: 'completed'; written: number; errors: number }
    | { kind: 'paused'; written: number; reason: string }
    | { kind: 'aborted'; reason: string };
};

interface UIState {
  snapshot: PopupSnapshot | null;
  initializing: boolean;
  syncing: SiteId | null;
  progress: { completed: number; total: number | null } | null;
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

function miyoStatusBlock(): string {
  if (!ui.snapshot) return '';
  const m = ui.snapshot.miyo;
  if (m.state === 'connected') {
    const v = m.version ? ` v${escape(m.version)}` : '';
    return `<div class="banner ok"><span class="muted">Connected to Miyo${v}</span></div>`;
  }
  return `
    <div class="banner">
      <div class="row">
        <span class="error">Miyo desktop app is not running.</span>
        <button data-action="refresh">Retry</button>
      </div>
    </div>`;
}

function renderSites(): string {
  if (!ui.snapshot) return '';
  const miyoOk = ui.snapshot.miyo.state === 'connected';
  const anySyncing = ui.syncing !== null;

  return ui.snapshot.sites
    .map((s) => {
      const signedIn = !!s.session?.signedIn;
      const isCurrent = ui.syncing === s.id;
      const disabled = !miyoOk || !signedIn || (anySyncing && !isCurrent);

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
    ${miyoStatusBlock()}
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
  if (!ui.snapshot || ui.snapshot.miyo.state !== 'connected') {
    ui.banner = { kind: 'error', text: 'Miyo desktop app is not running.' };
    render();
    return;
  }

  ui.syncing = site;
  ui.progress = { completed: 0, total: null };
  render();

  const port = chrome.runtime.connect({ name: 'sync' });
  port.postMessage({ type: 'start', site });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'progress' && msg.site === site) {
      ui.progress = { completed: msg.completed, total: msg.total };
      render();
    } else if (msg?.type === 'done') {
      const done = msg as SyncDone;
      ui.syncing = null;
      ui.progress = null;
      if (done.result.kind === 'completed') {
        ui.banner = {
          kind: 'info',
          text:
            done.result.errors > 0
              ? `Synced ${done.result.written} (${done.result.errors} failed).`
              : `Synced ${done.result.written} conversations.`,
        };
      } else if (done.result.kind === 'paused') {
        ui.banner = {
          kind: 'info',
          text: `Paused at ${done.result.written}. Click Sync again to continue.`,
        };
      } else if (done.result.reason === 'miyo_unreachable') {
        ui.banner = {
          kind: 'error',
          text: 'Miyo desktop app went away mid-sync. Restart it and click Sync to resume.',
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
