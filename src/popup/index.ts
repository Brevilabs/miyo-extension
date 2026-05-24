// Popup UI.
//
// Each site card is a signed-in row → time-range picker + Download
// button. Capture runs buffer into IndexedDB; on completion the popup
// builds a zip from the buffer and triggers a download, then clears
// the buffer. Stop drops the buffer (the buffer *is* the data, so
// dropping it is the right "abandon" semantic).
//
// At most one run pends at a time. If a run is mid-capture or
// completed-but-not-downloaded, other site cards are gated until it's
// resolved. If the SW dies, the popup shows Resume on next open and
// the capture continues from the same cursor.
//
// Vanilla DOM. No framework — keeps the extension lean.

import { DEFAULT_TIME_RANGE } from '../framework/types.js';
import type {
  PopupSnapshot,
  SiteId,
  SiteRow,
  TimeRange,
  TimeRangePreset,
} from '../framework/types.js';
import { clearItems, getAllItems } from '../framework/store.js';
import { clearPendingRun } from '../framework/run-state.js';
import { buildZip } from '../framework/zip.js';

// ──────────────────────────────────────────────────────────────────
// Types & state
// ──────────────────────────────────────────────────────────────────

type CaptureDone = {
  type: 'done';
  site: SiteId;
  result:
    | { kind: 'completed'; written: number; errors: number }
    | { kind: 'aborted'; reason: string };
};

interface UIState {
  snapshot: PopupSnapshot | null;
  initializing: boolean;
  capturing: SiteId | null;
  captureProgress: {
    phase: 'listing' | 'fetching';
    completed: number;
    total: number | null;
    note?: string;
  } | null;
  capturePort: chrome.runtime.Port | null;
  banner: { kind: 'info' | 'error'; text: string } | null;
  ranges: Record<SiteId, TimeRange>;
  // Guards exportPendingAsZip against double-trigger (done broadcast
  // + open-time auto-zip both arriving).
  zipping: boolean;
}

const ui: UIState = {
  snapshot: null,
  initializing: true,
  capturing: null,
  captureProgress: null,
  capturePort: null,
  banner: null,
  ranges: {},
  zipping: false,
};

const RANGES_STORAGE_KEY = 'time_ranges';

function toISODateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayISODate(): string {
  return toISODateLocal(new Date());
}

// 7 days ago, local timezone.
function defaultSinceDate(): string {
  return toISODateLocal(new Date(Date.now() - 7 * 86_400_000));
}

// Sanitize: tolerate older shapes (custom without untilISODate) and
// reject malformed entries silently. Old entries get untilISODate
// filled with today so the window includes everything up to now.
async function loadRanges(): Promise<Record<SiteId, TimeRange>> {
  try {
    const obj = await chrome.storage.local.get(RANGES_STORAGE_KEY);
    const raw = (obj[RANGES_STORAGE_KEY] as Record<SiteId, unknown> | undefined) ?? {};
    const out: Record<SiteId, TimeRange> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'object' || v === null) continue;
      const r = v as { kind?: string; preset?: string; sinceISODate?: string; untilISODate?: string };
      if (r.kind === 'preset' && r.preset) {
        const presets: TimeRangePreset[] = ['24h', '7d', '30d', '90d', 'all'];
        if ((presets as string[]).includes(r.preset)) {
          out[k] = { kind: 'preset', preset: r.preset as TimeRangePreset };
        }
      } else if (
        r.kind === 'custom' &&
        typeof r.sinceISODate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.sinceISODate)
      ) {
        const untilOk =
          typeof r.untilISODate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.untilISODate);
        out[k] = {
          kind: 'custom',
          sinceISODate: r.sinceISODate,
          untilISODate: untilOk ? (r.untilISODate as string) : todayISODate(),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveRanges(): void {
  void chrome.storage.local.set({ [RANGES_STORAGE_KEY]: ui.ranges });
}

function getRange(siteId: SiteId, defaultPreset?: TimeRangePreset): TimeRange {
  const persisted = ui.ranges[siteId];
  if (persisted) return persisted;
  if (defaultPreset) return { kind: 'preset', preset: defaultPreset };
  return DEFAULT_TIME_RANGE;
}

const PRESET_LABELS: Record<TimeRangePreset, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All available',
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

const SITE_BRAND: Record<string, { color: string; soft: string; initial: string }> = {
  chatgpt: { color: '#10a37f', soft: '#e0f5ee', initial: 'C' },
  claude_ai: { color: '#c66439', soft: '#f8e7dc', initial: 'A' },
};

function brandFor(siteId: string, label: string): { color: string; soft: string; initial: string } {
  return (
    SITE_BRAND[siteId.toLowerCase()] ?? {
      color: '#0f766e',
      soft: '#d9f1ef',
      initial: label.charAt(0).toUpperCase() || '·',
    }
  );
}

function findSite(siteId: SiteId): SiteRow | null {
  return ui.snapshot?.sites.find((s) => s.id === siteId) ?? null;
}

// ──────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────

const DOWNLOAD_ICON = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8.5"/><path d="M4.5 7.5L8 11l3.5-3.5"/><path d="M3 13.5h10"/></svg>`;

function siteStatus(s: SiteRow, isCapturing: boolean): { cls: string; text: string } {
  if (isCapturing) return { cls: 'status-syncing', text: 'Capturing' };
  if (!s.session) return { cls: 'status-off', text: 'Checking…' };
  if (!s.session.signedIn) return { cls: 'status-warn', text: 'Sign in' };
  return { cls: 'status-ready', text: 'Ready' };
}

function renderProgress(): string {
  if (!ui.captureProgress) return '';
  const { phase, completed, total, note } = ui.captureProgress;
  let text: string;
  let determinate = false;
  if (note) {
    text = note;
  } else if (phase === 'listing') {
    text = 'Looking for new conversations…';
  } else {
    text = total ? `${completed} of ${total}` : `${completed} captured`;
    determinate = total !== null && total > 0;
  }
  const bar = determinate
    ? `<div class="progress-bar-container"><div class="progress-bar" style="width:${Math.min(100, Math.round((completed / total!) * 100))}%"></div></div>`
    : `<div class="progress-bar-container"><div class="progress-bar progress-bar-indeterminate"></div></div>`;
  return `<div class="site-progress">${bar}<span class="site-progress-text">${escape(text)}</span></div>`;
}

function renderSiteRow(s: SiteRow): string {
  const isCapturing = ui.capturing === s.id;
  const anyBusy = ui.capturing !== null;
  const brand = brandFor(s.id, s.label);
  const status = siteStatus(s, isCapturing);
  const cardStyle = `--svc-color:${brand.color};--svc-color-soft:${brand.soft};`;

  // Account line.
  const accountLine = s.session?.signedIn
    ? s.session.email
      ? `<span class="site-account">${escape(s.session.email)}</span>`
      : `<span class="site-account">signed in</span>`
    : s.session
      ? `<span class="site-account">not signed in</span>`
      : '';

  const pending = ui.snapshot?.pending_run ?? null;
  const ownsPending = pending !== null && pending.siteId === s.id;
  const otherOwnsPending = pending !== null && pending.siteId !== s.id;
  const isPaused = ownsPending && !isCapturing && pending.status === 'capturing';

  // Body sits between the card head and the progress bar. Either a
  // sign-in CTA (signed-out), or the range picker + action button
  // pair (everyone else). Mode only changes the button label.
  let body: string;
  if (!s.session?.signedIn) {
    body = `
      <div class="site-actions">
        <button class="primary-button" data-action="open-site" data-site="${escape(s.id)}">Sign in to ${escape(s.label)} →</button>
      </div>`;
  } else {
    // Stop drops the IndexedDB buffer mid-run — the buffer *is* the
    // data, so dropping it is the right "abandon" semantic.
    let actionHtml: string;
    if (isCapturing) {
      actionHtml = `<button class="link-button link-button-danger" data-action="cancel" data-site="${escape(s.id)}">Stop</button>`;
    } else if (isPaused) {
      actionHtml = `
        <button class="primary-button refresh-button site-range-action" data-action="resume" data-site="${escape(s.id)}">${DOWNLOAD_ICON}<span>Resume (${pending.written})</span></button>
        <button class="link-button link-button-danger" data-action="discard" data-site="${escape(s.id)}">Discard</button>`;
    } else if (otherOwnsPending) {
      actionHtml = `<button class="primary-button refresh-button site-range-action" disabled>${DOWNLOAD_ICON}<span>Download</span></button>`;
    } else {
      actionHtml = `<button class="primary-button refresh-button site-range-action" data-action="capture-local" data-site="${escape(s.id)}" ${anyBusy ? 'disabled' : ''}>${DOWNLOAD_ICON}<span>Download</span></button>`;
    }

    const range = ownsPending ? pending.range : getRange(s.id, '30d');
    body = renderRangePicker(s.id, range, actionHtml, isCapturing || isPaused);
  }

  const progress = isCapturing ? renderProgress() : '';
  const hint = otherOwnsPending
    ? `<div class="site-hint">A capture from ${escape(pending.siteId)} is pending — resolve it before starting a new one.</div>`
    : '';

  return `
    <div class="site-card" style="${cardStyle}">
      <div class="site-card-head">
        <div class="site-logo">${escape(brand.initial)}</div>
        <div class="site-title">
          <div class="site-name">${escape(s.label)}${accountLine}</div>
        </div>
        <span class="status-pill site-status ${status.cls}">${escape(status.text)}</span>
      </div>
      ${body}
      ${progress}
      ${hint}
    </div>`;
}

function renderRangePicker(
  siteId: SiteId,
  range: TimeRange,
  actionButtonHtml: string,
  disabled: boolean
): string {
  const presetValue = range.kind === 'preset' ? range.preset : 'custom';
  const presetOptions: Array<{ value: string; label: string }> = [
    { value: '24h', label: PRESET_LABELS['24h'] },
    { value: '7d', label: PRESET_LABELS['7d'] },
    { value: '30d', label: PRESET_LABELS['30d'] },
    { value: '90d', label: PRESET_LABELS['90d'] },
    { value: 'all', label: PRESET_LABELS.all },
    { value: 'custom', label: 'Custom…' },
  ];
  const optionsHtml = presetOptions
    .map(
      (o) =>
        `<option value="${escape(o.value)}"${o.value === presetValue ? ' selected' : ''}>${escape(o.label)}</option>`
    )
    .join('');
  const sinceValue =
    range.kind === 'custom' ? range.sinceISODate : defaultSinceDate();
  const untilValue =
    range.kind === 'custom' ? range.untilISODate : todayISODate();
  const dis = disabled ? 'disabled' : '';
  // Both date inputs only appear when "Custom…" is selected. They sit
  // on a second row so the 400px popup width can fit them comfortably.
  const customRow =
    range.kind === 'custom'
      ? `
        <div class="site-range-custom">
          <input type="date" class="site-range-date" data-site="${escape(siteId)}" data-edge="since" value="${escape(sinceValue)}" ${dis} />
          <span class="site-range-arrow">→</span>
          <input type="date" class="site-range-date" data-site="${escape(siteId)}" data-edge="until" value="${escape(untilValue)}" ${dis} />
        </div>`
      : '';
  return `
    <div class="site-range-row">
      <label class="site-range-label">Range</label>
      <select class="site-range-select" data-site="${escape(siteId)}" ${dis}>
        ${optionsHtml}
      </select>
      ${actionButtonHtml}
    </div>
    ${customRow}`;
}

function renderHeader(): string {
  return `
    <div class="pop-head">
      <div>
        <span class="pop-wordmark">miyo</span><span class="pop-wordmark-sub">capture</span>
      </div>
    </div>
    <p class="pop-tagline">Save your AI conversations as local markdown.</p>
  `;
}

function renderFooter(): string {
  return `
    <div class="pop-foot">
      <span class="pop-foot-tag">yours, on your machine</span>
      <span class="pop-ver">v${escape(chrome.runtime.getManifest().version)}</span>
    </div>
  `;
}

function render(): void {
  if (ui.initializing) {
    root.innerHTML = `${renderHeader()}<div class="pop-loading">loading…</div>`;
    return;
  }
  const sites = ui.snapshot?.sites ?? [];

  root.innerHTML = `
    ${renderHeader()}
    ${
      ui.banner
        ? `<div class="pop-banner ${ui.banner.kind === 'error' ? 'pop-banner-error' : 'pop-banner-info'}">${escape(ui.banner.text)}</div>`
        : ''
    }
    <div class="site-list">
      ${sites.map(renderSiteRow).join('')}
    </div>
    ${renderFooter()}
  `;

  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const site = btn.dataset.site as SiteId | undefined;
      if (action === 'capture-local' && site) onCapture(site);
      else if (action === 'cancel' && site) onCancel(site);
      else if (action === 'resume') void onResume();
      else if (action === 'discard') void onDiscard();
      else if (action === 'open-site' && site) onOpenSite(site);
    });
  });

  root.querySelectorAll<HTMLSelectElement>('select.site-range-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const site = sel.dataset.site as SiteId | undefined;
      if (!site) return;
      onRangePresetChange(site, sel.value);
    });
  });

  root.querySelectorAll<HTMLInputElement>('input.site-range-date').forEach((inp) => {
    inp.addEventListener('change', () => {
      const site = inp.dataset.site as SiteId | undefined;
      const edge = inp.dataset.edge as 'since' | 'until' | undefined;
      if (!site || !edge) return;
      onRangeCustomDateChange(site, edge, inp.value);
    });
  });
}

function onRangePresetChange(siteId: SiteId, value: string): void {
  if (value === 'custom') {
    const existing = getRange(siteId);
    const sinceISODate =
      existing.kind === 'custom' ? existing.sinceISODate : defaultSinceDate();
    const untilISODate =
      existing.kind === 'custom' ? existing.untilISODate : todayISODate();
    ui.ranges[siteId] = { kind: 'custom', sinceISODate, untilISODate };
  } else if (
    value === '24h' ||
    value === '7d' ||
    value === '30d' ||
    value === '90d' ||
    value === 'all'
  ) {
    ui.ranges[siteId] = { kind: 'preset', preset: value };
  } else {
    return;
  }
  saveRanges();
  render();
}

function onRangeCustomDateChange(
  siteId: SiteId,
  edge: 'since' | 'until',
  value: string
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const existing = getRange(siteId);
  const sinceISODate =
    existing.kind === 'custom' ? existing.sinceISODate : defaultSinceDate();
  const untilISODate =
    existing.kind === 'custom' ? existing.untilISODate : todayISODate();
  ui.ranges[siteId] = {
    kind: 'custom',
    sinceISODate: edge === 'since' ? value : sinceISODate,
    untilISODate: edge === 'until' ? value : untilISODate,
  };
  saveRanges();
  // Skip render() so the user isn't bumped out of the date input
  // mid-interaction. The visible value is already correct.
}

// ──────────────────────────────────────────────────────────────────
// Actions
// ──────────────────────────────────────────────────────────────────

function onCapture(siteId: SiteId): void {
  ui.banner = null;
  ui.capturing = siteId;
  ui.captureProgress = { phase: 'listing', completed: 0, total: null };
  const port = chrome.runtime.connect({ name: 'capture' });
  ui.capturePort = port;
  render();
  const range: TimeRange = getRange(siteId, '30d');
  port.postMessage({ type: 'start', site: siteId, range });
  wirePort(port, siteId);
}

function onCancel(siteId: SiteId): void {
  ui.capturePort?.postMessage({ type: 'cancel', site: siteId });
}

function onResume(): void {
  ui.banner = null;
  const pending = ui.snapshot?.pending_run ?? null;
  if (!pending) return;
  ui.capturing = pending.siteId;
  ui.captureProgress = {
    phase: 'fetching',
    completed: pending.written,
    total: null,
  };
  const port = chrome.runtime.connect({ name: 'capture' });
  ui.capturePort = port;
  render();
  port.postMessage({ type: 'resume' });
  wirePort(port, pending.siteId);
}

function onDiscard(): void {
  // The SW owns cleanup — it can also stop a running capture loop
  // (cancelRequested) which the popup can't.
  try {
    const port = chrome.runtime.connect({ name: 'capture' });
    port.postMessage({ type: 'discard' });
    port.disconnect();
  } catch {
    // ignore
  }
  // Small delay so the next snapshot reads the cleared state.
  setTimeout(() => void refresh(), 150);
}

function onOpenSite(siteId: SiteId): void {
  const site = findSite(siteId);
  if (site) void chrome.tabs.create({ url: site.home_url });
}

// Single-shot guarded by ui.zipping — fired both on 'done' and on
// popup-open when status is 'ready' (covers popup-closed-at-completion).
async function exportPendingAsZip(siteId: SiteId): Promise<void> {
  if (ui.zipping) return;
  ui.zipping = true;
  ui.banner = { kind: 'info', text: 'Preparing zip…' };
  render();
  try {
    const records = await getAllItems(siteId);
    if (records.length === 0) {
      await clearPendingRun();
      ui.banner = { kind: 'info', text: 'Nothing to download.' };
      ui.zipping = false;
      void refresh();
      return;
    }
    const files = records.map((r) => ({ filename: r.filename, content: r.markdown }));
    const blob = buildZip(files);
    const zipName = `miyo-capture-${siteId}-${todayISODate()}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation so the download has time to start.
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    // Only clear after the download was initiated successfully.
    await clearItems(siteId);
    await clearPendingRun();

    ui.banner = {
      kind: 'info',
      text: `Downloaded ${files.length} conversation${files.length === 1 ? '' : 's'} as ${zipName}.`,
    };
  } catch (err) {
    ui.banner = {
      kind: 'error',
      text: `Failed to build zip: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    ui.zipping = false;
    void refresh();
  }
}

function wirePort(port: chrome.runtime.Port, siteId: SiteId): void {
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'progress' && msg.site === siteId) {
      ui.captureProgress = {
        phase: (msg.phase as 'listing' | 'fetching' | undefined) ?? 'fetching',
        completed: msg.completed,
        total: msg.total,
        note: typeof msg.note === 'string' ? msg.note : undefined,
      };
      render();
      return;
    }
    if (msg?.type === 'not_running' && msg.site === siteId) {
      ui.capturing = null;
      ui.captureProgress = null;
      ui.capturePort = null;
      port.disconnect();
      void refresh();
      return;
    }
    if (msg?.type === 'done') {
      const done = msg as CaptureDone;
      ui.capturing = null;
      ui.captureProgress = null;
      ui.capturePort = null;
      port.disconnect();
      if (done.result.kind === 'completed') {
        void exportPendingAsZip(done.site);
      } else {
        const benign = done.result.reason === 'cancelled';
        ui.banner = {
          kind: benign ? 'info' : 'error',
          text: explainAbort(done.result.reason),
        };
        void refresh();
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (ui.capturing === siteId) {
      ui.capturing = null;
      ui.captureProgress = null;
      ui.capturePort = null;
      render();
    }
  });
}

function explainAbort(reason: string): string {
  switch (reason) {
    case 'cancelled':
      return 'Capture stopped.';
    case 'signed_out':
      return 'You are signed out. Sign in and try again.';
    case 'busy':
      return 'Another capture is already running.';
    case 'pending_run_exists':
      return 'A previous capture is pending — resolve it first.';
    case 'no_pending_run':
      return 'No pending capture to resume.';
    default:
      return `Capture stopped: ${reason}`;
  }
}

function attachToRunningRun(siteId: SiteId): void {
  ui.capturing = siteId;
  ui.captureProgress = { phase: 'listing', completed: 0, total: null };
  const port = chrome.runtime.connect({ name: 'capture' });
  ui.capturePort = port;
  port.postMessage({ type: 'attach', site: siteId });
  wirePort(port, siteId);
}

async function refresh(): Promise<void> {
  render();
  try {
    ui.snapshot = (await chrome.runtime.sendMessage({ type: 'snapshot' })) as PopupSnapshot;
  } catch (err) {
    ui.banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
  } finally {
    render();
  }
}

async function loadCachedSnapshot(): Promise<PopupSnapshot | null> {
  try {
    const obj = await chrome.storage.local.get('last_snapshot');
    return (obj.last_snapshot as PopupSnapshot | undefined) ?? null;
  } catch {
    return null;
  }
}

// Stale-while-revalidate: paint the cached snapshot immediately so
// the popup feels instant, then kick off a fresh snapshot request in
// the background and re-render when it lands. The fresh fetch can
// take 200–1500 ms (remote session probes); doing it off the paint
// path means the user sees content right away.
async function init(): Promise<void> {
  render();

  const [cached, ranges] = await Promise.all([loadCachedSnapshot(), loadRanges()]);
  ui.ranges = ranges;
  if (cached) {
    ui.snapshot = cached;
    ui.initializing = false;
    render();
    // Attach to any in-flight capture. If the SW isn't actually
    // running it (it was killed mid-run), it replies 'not_running'
    // and the popup flips to the Resume render.
    if (cached.pending_run?.status === 'capturing' && ui.capturing === null) {
      attachToRunningRun(cached.pending_run.siteId);
    }
  }

  try {
    const snapshot = (await chrome.runtime.sendMessage({
      type: 'snapshot',
    })) as PopupSnapshot;
    ui.snapshot = snapshot;
  } catch (err) {
    if (!cached) {
      ui.banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    ui.initializing = false;
    render();
  }

  // Capture completed while the popup was closed: zip the buffer and
  // download, then clear.
  const pending = ui.snapshot?.pending_run;
  if (pending && pending.status === 'ready' && !ui.zipping) {
    void exportPendingAsZip(pending.siteId);
  }
}

void init();
