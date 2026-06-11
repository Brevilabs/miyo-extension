// Link to the Miyo Desktop native-messaging host (`md.miyo.chatsync`).
//
// When the user flips "Sync to Miyo Desktop" on, the extension pushes
// the ChatGPT / Claude session cookies to the desktop app, which then
// syncs chat history in the background on the user's machine. The
// extension's job is only cookie delivery + status display; no chat
// data flows through the extension in this mode.
//
// Transport is Chrome native messaging: the desktop installs a host
// named `md.miyo.chatsync` whose native-messaging manifest allow-lists
// this extension's (pinned) ID. There is no loopback port to probe —
// the host fails closed, replying { ok: false, reason: 'miyo_not_running' }
// when the real Miyo service isn't reachable.
//
// Push triggers: SW init / browser startup, a 30-minute alarm, and
// cookie changes on the two sites (debounced ~5s per platform). Every
// push is fire-and-forget: if Miyo isn't running the host rejects and
// we silently wait for the next trigger.
//
// The `cookies` permission is optional (requested by the popup the
// first time the toggle is enabled) so a default install shows no
// cookie warning. The `nativeMessaging` permission is required (in
// manifest.json) so both the SW and the popup can call the host.

import {
  buildPushCookiesMessage,
  platformForCookieDomain,
  MIYO_PLATFORMS,
  MIYO_PLATFORM_DOMAINS,
  type MiyoChatsStatus,
  type MiyoOutboundMessage,
  type MiyoPingReply,
  type MiyoPlatform,
  type MiyoPushReply,
  type MiyoStatusReply,
} from './miyo-wire.js';

export const MIYO_HOST_NAME = 'md.miyo.chatsync';
export const MIYO_SYNC_ENABLED_KEY = 'miyo_sync_enabled';

const SYNC_ALARM = 'miyo-sync-push';
const SYNC_ALARM_PERIOD_MINUTES = 30;
const COOKIE_CHANGE_DEBOUNCE_MS = 5000;

// ──────────────────────────────────────────────────────────────────
// Native-messaging transport (also imported by the popup — popups may
// call chrome.runtime.sendNativeMessage once nativeMessaging is granted)
// ──────────────────────────────────────────────────────────────────

// Reply shape when the host couldn't be reached at all (not installed,
// failed to launch, …). chrome.runtime.lastError carries a message like
// "Specified native messaging host not found" — we map that to a
// uniform { ok: false, reason: 'no_host' } so callers never throw.
interface NoHostReply {
  ok: false;
  reason: 'no_host';
}

// Promise wrapper around chrome.runtime.sendNativeMessage that resolves
// (never rejects) with the host's reply, or { ok:false, reason:'no_host' }
// when the host is missing / unreachable.
function sendNativeMessage<T extends { ok: boolean }>(
  message: MiyoOutboundMessage
): Promise<T | NoHostReply> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(MIYO_HOST_NAME, message, (reply: unknown) => {
        if (chrome.runtime.lastError || reply == null) {
          resolve({ ok: false, reason: 'no_host' });
          return;
        }
        resolve(reply as T);
      });
    } catch {
      // Some Chrome builds throw synchronously when the host is absent.
      resolve({ ok: false, reason: 'no_host' });
    }
  });
}

// Is Miyo Desktop running? `ping` returns { ok:true, running } when the
// host is installed; a missing host (no_host) means Miyo isn't installed.
// Either way we never throw — the popup must not hang.
export async function probeMiyo(): Promise<boolean> {
  const reply = await sendNativeMessage<MiyoPingReply>({ type: 'ping' });
  return reply.ok === true && reply.running === true;
}

export async function fetchMiyoStatus(): Promise<MiyoChatsStatus | null> {
  const reply = await sendNativeMessage<MiyoStatusReply>({ type: 'status' });
  if (!reply.ok) return null;
  return (reply as MiyoStatusReply).status ?? null;
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
// `cookies` permission isn't granted, the host is missing, or Miyo
// isn't running — the next trigger retries.
export async function pushCookies(platform: MiyoPlatform): Promise<void> {
  // chrome.cookies is undefined until the optional permission is
  // granted; its presence *is* the grant check.
  if (!chrome.cookies) return;
  // getAll({ domain }) matches the domain and all subdomains, so
  // ".chatgpt.com" / "ab.chatgpt.com" cookies are included.
  const cookies = await chrome.cookies.getAll({ domain: MIYO_PLATFORM_DOMAINS[platform] });
  // Signed out → no cookies. Skip: the desktop rejects an empty array, so
  // pushing it just burns a round-trip that retries forever.
  if (cookies.length === 0) return;
  const message = buildPushCookiesMessage(platform, cookies, Date.now());
  // Fire-and-forget: on { ok:false } (miyo_not_running / rejected) or a
  // missing host the next alarm, cookie change, or SW start retries.
  await sendNativeMessage<MiyoPushReply>(message);
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

  // If the user revokes the `cookies` permission from Chrome settings,
  // the chrome.cookies namespace (and our listener) disappears and pushes
  // silently no-op. Turn sync off so the stored flag — and the popup —
  // stop claiming sync is on. Reset the registration latch so a later
  // re-grant re-attaches the listener.
  chrome.permissions.onRemoved.addListener((perms) => {
    if (!perms.permissions?.includes('cookies')) return;
    cookieListenerRegistered = false;
    void disableMiyoSync();
  });

  void resumeIfEnabled();
}
