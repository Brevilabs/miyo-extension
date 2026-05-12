// Popup UI.
//
// Vanilla DOM, no framework — keeps the extension lean and
// review-friendly.
//
// One screen, one concept: the list of supported sites. Each site is
// either enabled (with a destination, a capture count, and a sync
// button), paused, or not-yet-enabled. The enable flow opens a modal
// that asks for a destination folder (Chromium) or confirms the
// downloads-folder default (Firefox/Safari).
//
// The popup writes config directly to chrome.storage.local and
// IndexedDB via the destinations module — the background service
// worker mediates only sync runs.

import {
  getSiteConfig,
  setSiteConfig,
  setFolderHandle,
  requestPermission,
  hasPermission,
  getFolderHandle,
  supportsFolderPicker,
  defaultDownloadsSubpath,
} from '../framework/destinations.js';
import { META_FILENAME, parseMeta } from '../framework/meta.js';
import type {
  PopupSnapshot,
  SiteId,
  SiteRowSnapshot,
} from '../framework/types.js';

// ──────────────────────────────────────────────────────────────────
// Types for messages from background
// ──────────────────────────────────────────────────────────────────

type SyncDone = {
  type: 'done';
  site: SiteId;
  result:
    | { kind: 'completed'; written: number; errors: number }
    | { kind: 'paused'; written: number; reason: string }
    | { kind: 'aborted'; reason: string };
};

// ──────────────────────────────────────────────────────────────────
// UI state
// ──────────────────────────────────────────────────────────────────

interface UIState {
  snapshot: PopupSnapshot | null;
  initializing: boolean;
  syncing: SiteId | null;
  syncProgress: { completed: number; total: number | null } | null;
  enableModal: { siteId: SiteId; label: string; error: string | null } | null;
  banner: { kind: 'info' | 'error'; text: string } | null;
}

const ui: UIState = {
  snapshot: null,
  initializing: true,
  syncing: null,
  syncProgress: null,
  enableModal: null,
  banner: null,
};

const root = document.getElementById('root')!;

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

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

function fmtTime(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString();
}

// Browser global type bridge for showDirectoryPicker. The popup runs
// in an extension page context which has `window`; the global cast
// keeps this file portable.
interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
  id?: string;
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}
type ShowDirectoryPicker = (opts?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;

// ──────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────

function renderSiteRow(s: SiteRowSnapshot): string {
  const isSyncing = ui.syncing === s.id;
  const anyBusy = ui.syncing !== null;

  if (!s.enabled) {
    return `
      <div class="site-row">
        <div class="header">
          <span class="label">${escape(s.label)}</span>
          <button class="small" data-action="enable" data-site="${escape(s.id)}" ${anyBusy ? 'disabled' : ''}>Enable →</button>
        </div>
        <div class="meta muted">Save your ${escape(s.label)} conversations as markdown.</div>
      </div>`;
  }

  // Enabled
  const statusDot = s.paused
    ? '⏸'
    : s.destination_missing
      ? '⚠'
      : s.destination_needs_reauth
        ? '○'
        : '●';
  const dest = s.destination_missing
    ? '<span class="error">folder no longer available</span>'
    : s.destination_label
      ? `<span class="muted">→ ${escape(s.destination_label)}</span>`
      : '<span class="muted">→ no destination</span>';

  const meta: string[] = [];
  if (s.session?.signedIn) {
    meta.push(
      `<div class="meta">${s.session.email ? `Signed in as ${escape(s.session.email)}` : 'Signed in'}</div>`
    );
  } else if (s.session) {
    meta.push(
      `<div class="meta muted">Not signed in. Open ${escape(s.label)} in a tab and sign in.</div>`
    );
  }

  const countPart =
    s.captures_count !== null
      ? `${s.captures_count} capture${s.captures_count === 1 ? '' : 's'}`
      : null;
  const lastSyncPart = `last sync ${fmtTime(s.last_sync_at)}`;
  const detail = countPart ? `${countPart} · ${lastSyncPart}` : lastSyncPart;
  meta.push(`<div class="meta">${detail}</div>`);

  if (s.destination_needs_reauth) {
    meta.push(
      `<div class="meta muted">Needs folder access for this session — click Sync to grant.</div>`
    );
  } else if (s.last_sync_error && s.last_sync_error !== 'permission_revoked') {
    meta.push(
      `<div class="err"><span class="error">${escape(explainAbort(s.last_sync_error))}</span></div>`
    );
  }

  let progress = '';
  if (isSyncing && ui.syncProgress) {
    const { completed, total } = ui.syncProgress;
    progress = total
      ? `<div class="progress">Syncing ${completed} of ${total}…</div>`
      : `<div class="progress">Syncing ${completed}…</div>`;
  }

  // Actions row
  const actions: string[] = [];
  if (s.destination_missing) {
    actions.push(
      `<button class="primary small" data-action="reconnect" data-site="${escape(s.id)}" ${anyBusy ? 'disabled' : ''}>Reconnect</button>`
    );
  } else if (s.paused) {
    actions.push(
      `<button class="primary small" data-action="resume" data-site="${escape(s.id)}" ${anyBusy ? 'disabled' : ''}>Resume</button>`
    );
  } else {
    const syncDisabled = anyBusy && !isSyncing;
    actions.push(
      `<button class="primary small" data-action="sync" data-site="${escape(s.id)}" ${syncDisabled ? 'disabled' : ''}>${isSyncing ? 'Syncing…' : 'Sync now'}</button>`
    );
    if (!isSyncing) {
      actions.push(
        `<button class="link" data-action="pause" data-site="${escape(s.id)}">Pause</button>`
      );
    }
  }
  if (!isSyncing) {
    actions.push(
      `<button class="link" data-action="change-destination" data-site="${escape(s.id)}">Change folder</button>`
    );
    actions.push(
      `<button class="link" data-action="disable" data-site="${escape(s.id)}">Disable</button>`
    );
  }

  return `
    <div class="site-row">
      <div class="header">
        <span class="label">${statusDot} ${escape(s.label)}${s.paused ? ' (paused)' : ''}</span>
        ${dest}
      </div>
      ${meta.join('')}
      ${progress}
      <div class="actions">${actions.join('')}</div>
    </div>`;
}

function renderEnableModal(): string {
  if (!ui.enableModal) return '';
  const { label, error } = ui.enableModal;
  // Capability check must run in the popup (window context) — the
  // background service worker is a ServiceWorkerGlobalScope and never
  // has showDirectoryPicker, regardless of browser.
  const canPickFolder = supportsFolderPicker();

  const body = canPickFolder
    ? `
        <p class="muted">Pick a folder on your computer. Your ${escape(label)} captures will be saved there as one markdown file per conversation.</p>
        <div class="actions">
          <button class="primary" data-action="modal-pick-folder">Choose folder</button>
          <button class="link" data-action="modal-cancel">Cancel</button>
        </div>`
    : `
        <p class="muted">Your browser doesn't support folder selection. ${escape(label)} captures will be saved to your Downloads folder:</p>
        <p><code>~/Downloads/${escape(defaultDownloadsSubpath(label))}</code></p>
        <div class="actions">
          <button class="primary" data-action="modal-use-downloads">Save to Downloads</button>
          <button class="link" data-action="modal-cancel">Cancel</button>
        </div>`;

  return `
    <div class="modal-backdrop">
      <div class="modal">
        <h1>Enable ${escape(label)} capture</h1>
        ${error ? `<p class="error">${escape(error)}</p>` : ''}
        ${body}
      </div>
    </div>`;
}

function render(): void {
  if (ui.initializing) {
    root.innerHTML = `<h1>Miyo Capture</h1><p class="muted">Loading…</p>`;
    return;
  }
  const sites = ui.snapshot?.sites ?? [];
  const noneEnabled = sites.every((s) => !s.enabled);

  root.innerHTML = `
    <h1>Miyo Capture</h1>
    ${
      ui.banner
        ? `<div class="banner"><span class="${ui.banner.kind === 'error' ? 'error' : 'muted'}">${escape(ui.banner.text)}</span></div>`
        : ''
    }
    ${
      noneEnabled
        ? `<p class="muted">Capture your AI chats as local markdown. Pick a site to start.</p>`
        : ''
    }
    ${sites.map(renderSiteRow).join('')}
    ${renderEnableModal()}
  `;

  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const site = btn.dataset.site as SiteId | undefined;
      if (action === 'enable' && site) void onEnable(site);
      else if (action === 'sync' && site) void onSync(site);
      else if (action === 'pause' && site) void onPause(site);
      else if (action === 'resume' && site) void onResume(site);
      else if (action === 'disable' && site) void onDisable(site);
      else if (action === 'reconnect' && site) void onReconnect(site);
      else if (action === 'change-destination' && site) void onEnable(site);
      else if (action === 'modal-pick-folder') void onPickFolder();
      else if (action === 'modal-use-downloads') void onUseDownloads();
      else if (action === 'modal-cancel') onModalCancel();
    });
  });
}

// ──────────────────────────────────────────────────────────────────
// Actions
// ──────────────────────────────────────────────────────────────────

function findSite(siteId: SiteId): SiteRowSnapshot | null {
  return ui.snapshot?.sites.find((s) => s.id === siteId) ?? null;
}

function onEnable(siteId: SiteId): void {
  const s = findSite(siteId);
  if (!s) return;
  ui.enableModal = { siteId, label: s.label, error: null };
  render();
}

function onModalCancel(): void {
  ui.enableModal = null;
  render();
}

async function onPickFolder(): Promise<void> {
  if (!ui.enableModal) return;
  const { siteId } = ui.enableModal;

  const picker = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker })
    .showDirectoryPicker;
  if (!picker) {
    ui.enableModal = { ...ui.enableModal, error: 'Folder picker not supported by this browser.' };
    render();
    return;
  }

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({
      mode: 'readwrite',
      id: `miyo-capture-${siteId}`,
      startIn: 'documents',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // User cancelled — keep modal open so they can retry or cancel.
      return;
    }
    ui.enableModal = {
      ...ui.enableModal,
      error: err instanceof Error ? err.message : String(err),
    };
    render();
    return;
  }

  // Conflict check: does the folder already belong to another source?
  try {
    const fh = await handle.getFileHandle(META_FILENAME);
    const file = await fh.getFile();
    const existing = parseMeta(await file.text());
    if (existing && existing.source.id !== siteId) {
      ui.enableModal = {
        ...ui.enableModal,
        error: `This folder already holds captures from ${existing.source.label}. Pick a different folder.`,
      };
      render();
      return;
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
      ui.enableModal = {
        ...ui.enableModal,
        error: err instanceof Error ? err.message : String(err),
      };
      render();
      return;
    }
  }

  await setFolderHandle(siteId, handle);
  await setSiteConfig(siteId, {
    enabled: true,
    paused: false,
    destination: { kind: 'folder' },
  });
  ui.enableModal = null;
  ui.banner = null;
  // Refresh first so the site row renders as enabled, then kick off
  // the first sync. The user just told us where their data should go;
  // they expect it to start arriving immediately.
  await onRefresh();
  void onSync(siteId);
}

async function onUseDownloads(): Promise<void> {
  if (!ui.enableModal) return;
  const { siteId, label } = ui.enableModal;
  await setSiteConfig(siteId, {
    enabled: true,
    paused: false,
    destination: { kind: 'downloads', subpath: defaultDownloadsSubpath(label) },
  });
  ui.enableModal = null;
  ui.banner = null;
  await onRefresh();
  void onSync(siteId);
}

async function onSync(siteId: SiteId): Promise<void> {
  ui.banner = null;

  // For folder destinations, ensure permission is granted before
  // handing off to the background. The popup click is a user gesture,
  // so requestPermission can prompt here; the SW cannot. If permission
  // is already granted, requestPermission returns 'granted' without
  // any user-facing prompt.
  const site = findSite(siteId);
  if (site?.destination_kind === 'folder') {
    const handle = await getFolderHandle(siteId);
    if (handle && !(await hasPermission(handle))) {
      const granted = await requestPermission(handle);
      if (!granted) {
        ui.banner = {
          kind: 'error',
          text: 'Folder access denied. Cannot sync until you grant access.',
        };
        render();
        return;
      }
      // Permission state changed; reflect it in the snapshot.
      site.destination_needs_reauth = false;
    }
  }

  ui.syncing = siteId;
  ui.syncProgress = { completed: 0, total: null };
  render();

  const port = chrome.runtime.connect({ name: 'sync' });
  port.postMessage({ type: 'start', site: siteId });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'progress' && msg.site === siteId) {
      ui.syncProgress = { completed: msg.completed, total: msg.total };
      render();
    } else if (msg?.type === 'done') {
      const done = msg as SyncDone;
      ui.syncing = null;
      ui.syncProgress = null;
      if (done.result.kind === 'completed') {
        ui.banner = {
          kind: 'info',
          text:
            done.result.errors > 0
              ? `Captured ${done.result.written} new (${done.result.errors} failed).`
              : `Captured ${done.result.written} new.`,
        };
      } else if (done.result.kind === 'paused') {
        ui.banner = {
          kind: 'info',
          text: `Paused at ${done.result.written}. Click Sync to continue.`,
        };
      } else {
        ui.banner = { kind: 'error', text: explainAbort(done.result.reason) };
      }
      port.disconnect();
      void onRefresh();
    }
  });
  port.onDisconnect.addListener(() => {
    if (ui.syncing === siteId) {
      ui.syncing = null;
      ui.syncProgress = null;
      render();
    }
  });
}

function explainAbort(reason: string): string {
  switch (reason) {
    case 'paused':
      return 'This site is paused. Resume to sync.';
    case 'not_enabled':
      return 'This site is not enabled.';
    case 'not_configured':
      return 'Pick a destination folder first.';
    case 'handle_missing':
    case 'permission_revoked':
      return 'Folder access lost. Reconnect to resume.';
    case 'signed_out':
      return 'You are signed out of this site. Sign in and try again.';
    default:
      if (reason.startsWith('destination_belongs_to_')) {
        return `This folder is for another source (${reason.replace('destination_belongs_to_', '')}). Pick a different folder.`;
      }
      return `Sync stopped: ${reason}`;
  }
}

async function onPause(siteId: SiteId): Promise<void> {
  await setSiteConfig(siteId, { paused: true });
  await onRefresh();
}

async function onResume(siteId: SiteId): Promise<void> {
  await setSiteConfig(siteId, { paused: false });
  await onRefresh();
}

async function onDisable(siteId: SiteId): Promise<void> {
  const cfg = await getSiteConfig(siteId);
  // Keep destination so re-enable is one click. Disable just sets the
  // flag; nothing is deleted.
  await setSiteConfig(siteId, { ...cfg, enabled: false, paused: false });
  await onRefresh();
}

async function onReconnect(siteId: SiteId): Promise<void> {
  const handle = await getFolderHandle(siteId);
  if (!handle) {
    // Handle is gone entirely — fall back to the enable flow.
    onEnable(siteId);
    return;
  }
  const ok = await requestPermission(handle);
  if (!ok) {
    ui.banner = { kind: 'error', text: 'Permission denied. The folder cannot be accessed.' };
    render();
    return;
  }
  await onRefresh();
}

// File System Access permissions can be 'granted' for the popup window
// but reported differently from the service worker. The popup runs in
// a real window context, so its hasPermission() answer is the truth.
// We reconcile each folder site here so the UI reflects what writes
// will actually be allowed to do.
async function enrichPermissions(snapshot: PopupSnapshot): Promise<void> {
  await Promise.all(
    snapshot.sites.map(async (site) => {
      if (!site.enabled || site.destination_kind !== 'folder') return;
      const handle = await getFolderHandle(site.id);
      if (!handle) {
        site.destination_missing = true;
        return;
      }
      // Handle is in IndexedDB but permission may need re-granting
      // for this session — that's a soft state, not "missing."
      site.destination_needs_reauth = !(await hasPermission(handle));
    })
  );
}

async function onRefresh(): Promise<void> {
  try {
    ui.snapshot = (await chrome.runtime.sendMessage({ type: 'snapshot' })) as PopupSnapshot;
    if (ui.snapshot) await enrichPermissions(ui.snapshot);
  } catch (err) {
    ui.banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
  }
  render();
}

async function init(): Promise<void> {
  render();
  try {
    ui.snapshot = (await chrome.runtime.sendMessage({ type: 'open' })) as PopupSnapshot;
    if (ui.snapshot) await enrichPermissions(ui.snapshot);
  } catch (err) {
    ui.banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
  } finally {
    ui.initializing = false;
    render();
  }
}

void init();
