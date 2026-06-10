// Link to the Miyo Desktop local service (http://127.0.0.1:8742).
//
// When the user flips "Sync to Miyo Desktop" on, the extension pushes
// the ChatGPT / Claude session cookies to the desktop app, which then
// syncs chat history in the background on the user's machine. The
// extension's job is only cookie delivery + status display; no chat
// data flows through the extension in this mode.
//
// Push triggers: SW init / browser startup, a 30-minute alarm, and
// cookie changes on the two sites (debounced ~5s per platform). Every
// push is fire-and-forget: if Miyo isn't running the fetch fails and
// we silently wait for the next trigger.
//
// The `cookies` permission is optional (requested by the popup the
// first time the toggle is enabled) so a default install shows no
// cookie warning.

import {
  buildCookiesBody,
  platformForCookieDomain,
  MIYO_PLATFORMS,
  MIYO_PLATFORM_DOMAINS,
  type MiyoChatsStatus,
  type MiyoPlatform,
} from './miyo-wire.js';

export const MIYO_BASE_URL = 'http://127.0.0.1:8742';
export const MIYO_SYNC_ENABLED_KEY = 'miyo_sync_enabled';

const SYNC_ALARM = 'miyo-sync-push';
const SYNC_ALARM_PERIOD_MINUTES = 30;
const PROBE_TIMEOUT_MS = 1500;
const COOKIE_CHANGE_DEBOUNCE_MS = 5000;

// ──────────────────────────────────────────────────────────────────
// HTTP (also imported by the popup — no chrome.* in these two)
// ──────────────────────────────────────────────────────────────────

// Is Miyo Desktop running? Short timeout so the popup never hangs on
// a machine without Miyo installed.
export async function probeMiyo(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${MIYO_BASE_URL}/v0/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchMiyoStatus(): Promise<MiyoChatsStatus | null> {
  try {
    const res = await fetch(`${MIYO_BASE_URL}/v0/chats/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as MiyoChatsStatus;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Enabled flag
// ──────────────────────────────────────────────────────────────────

export async function isMiyoSyncEnabled(): Promise<boolean> {
  try {
    const obj = await chrome.storage.local.get(MIYO_SYNC_ENABLED_KEY);
    return obj[MIYO_SYNC_ENABLED_KEY] === true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────
// Cookie push
// ──────────────────────────────────────────────────────────────────

// Push one platform's cookies to Miyo. Silently no-ops when the
// `cookies` permission isn't granted or Miyo isn't running — the next
// trigger retries.
export async function pushCookies(platform: MiyoPlatform): Promise<void> {
  // chrome.cookies is undefined until the optional permission is
  // granted; its presence *is* the grant check.
  if (!chrome.cookies) return;
  try {
    // getAll({ domain }) matches the domain and all subdomains, so
    // ".chatgpt.com" / "ab.chatgpt.com" cookies are included.
    const cookies = await chrome.cookies.getAll({ domain: MIYO_PLATFORM_DOMAINS[platform] });
    const body = buildCookiesBody(platform, cookies, Date.now());
    await fetch(`${MIYO_BASE_URL}/v0/chats/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // Miyo not running (or transient failure) — the next alarm,
    // cookie change, or SW start retries.
  }
}

export async function pushAllCookies(): Promise<void> {
  await Promise.all(MIYO_PLATFORMS.map((p) => pushCookies(p)));
}

// ──────────────────────────────────────────────────────────────────
// Enable / disable (called from the SW message handler)
// ──────────────────────────────────────────────────────────────────

export async function enableMiyoSync(): Promise<void> {
  await chrome.storage.local.set({ [MIYO_SYNC_ENABLED_KEY]: true });
  registerCookieListener();
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_ALARM_PERIOD_MINUTES });
  await pushAllCookies();
}

// Stops pushing; never touches desktop-side data.
export async function disableMiyoSync(): Promise<void> {
  await chrome.storage.local.set({ [MIYO_SYNC_ENABLED_KEY]: false });
  await chrome.alarms.clear(SYNC_ALARM);
  for (const platform of MIYO_PLATFORMS) {
    const timer = debounceTimers.get(platform);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.delete(platform);
  }
}

// ──────────────────────────────────────────────────────────────────
// Background wire-up
// ──────────────────────────────────────────────────────────────────

const debounceTimers = new Map<MiyoPlatform, ReturnType<typeof setTimeout>>();

function onCookieChanged(changeInfo: chrome.cookies.CookieChangeInfo): void {
  const platform = platformForCookieDomain(changeInfo.cookie.domain);
  if (platform === null) return;
  const existing = debounceTimers.get(platform);
  if (existing !== undefined) clearTimeout(existing);
  debounceTimers.set(
    platform,
    setTimeout(() => {
      debounceTimers.delete(platform);
      void (async () => {
        if (await isMiyoSyncEnabled()) await pushCookies(platform);
      })();
    }, COOKIE_CHANGE_DEBOUNCE_MS)
  );
}

let cookieListenerRegistered = false;

// MV3 wants listeners registered synchronously at SW top level. For
// the optional `cookies` permission the namespace only exists once the
// permission is granted: on a granted profile this runs at module
// load; on the very first grant it runs from permissions.onAdded.
function registerCookieListener(): void {
  if (cookieListenerRegistered || !chrome.cookies) return;
  chrome.cookies.onChanged.addListener(onCookieChanged);
  cookieListenerRegistered = true;
}

// If sync is enabled, make sure the periodic alarm exists and push
// fresh cookies now. Runs on every SW init so a killed-and-revived
// worker self-heals.
async function resumeIfEnabled(): Promise<void> {
  if (!(await isMiyoSyncEnabled())) return;
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_ALARM_PERIOD_MINUTES });
  await pushAllCookies();
}

// Called once from the SW entry (src/background/index.ts) at module
// top level, synchronously, so all listeners survive SW restarts.
export function initMiyoLink(): void {
  registerCookieListener();

  chrome.runtime.onStartup.addListener(() => {
    void resumeIfEnabled();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM) return;
    void (async () => {
      if (await isMiyoSyncEnabled()) await pushAllCookies();
    })();
  });

  // First-ever grant happens while this SW instance is alive; attach
  // the cookie listener without waiting for a restart.
  chrome.permissions.onAdded.addListener((perms) => {
    if (perms.permissions?.includes('cookies')) registerCookieListener();
  });

  void resumeIfEnabled();
}
