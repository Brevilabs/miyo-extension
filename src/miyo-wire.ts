// Wire shapes and pure helpers for the Miyo Desktop native-messaging
// host (`md.miyo.chatsync`). Chrome-free on purpose: this module is
// shared by the service worker, the popup, and the node:test unit
// tests (see tsconfig.test.json).
//
// The desktop installs a native-messaging host the extension talks to
// over chrome.runtime.connectNative / sendNativeMessage. Chrome frames
// each message (4-byte length prefix); we only deal in plain JSON.

// Platforms the desktop chat-sync understands. These match the
// extension's adapter ids (src/adapters/) byte-for-byte.
export type MiyoPlatform = 'chatgpt' | 'claude_ai';

export const MIYO_PLATFORMS: MiyoPlatform[] = ['chatgpt', 'claude_ai'];

// The registrable domain whose cookies each platform's sync needs.
export const MIYO_PLATFORM_DOMAINS: Record<MiyoPlatform, string> = {
  chatgpt: 'chatgpt.com',
  claude_ai: 'claude.ai',
};

// Subset of chrome.cookies.Cookie we read. Declared structurally so
// the mapper stays testable without @types/chrome.
export interface CookieLike {
  name: string;
  value: string;
  domain: string;
  path: string;
  // Seconds since epoch; absent for session cookies.
  expirationDate?: number;
}

// ──────────────────────────────────────────────────────────────────
// Native-messaging envelopes
// ──────────────────────────────────────────────────────────────────

// Messages the extension sends to the host. Chrome handles framing;
// these are the plain JSON payloads.
export interface MiyoPingMessage {
  type: 'ping';
}

export interface MiyoStatusMessage {
  type: 'status';
}

export interface MiyoPushCookiesMessage {
  type: 'push_cookies';
  platform: MiyoPlatform;
  cookies: CookieLike[];
  captured_at: number; // ms epoch
}

export type MiyoOutboundMessage =
  | MiyoPingMessage
  | MiyoStatusMessage
  | MiyoPushCookiesMessage;

// Host replies.
export interface MiyoPingReply {
  ok: true;
  running: boolean;
}

export interface MiyoStatusReply {
  ok: boolean;
  status?: MiyoChatsStatus;
}

// push_cookies reply: { ok: true } on success, or
// { ok: false, reason: 'miyo_not_running' | 'rejected' | ... }.
export interface MiyoPushReply {
  ok: boolean;
  reason?: string;
}

// The `push_cookies` payload the host expects. Pure mapper: strips the
// extra fields chrome.cookies attaches (httpOnly, secure, session, …)
// down to the four the host reads, dropping expirationDate for session
// cookies.
export function buildPushCookiesMessage(
  platform: MiyoPlatform,
  cookies: CookieLike[],
  capturedAt: number
): MiyoPushCookiesMessage {
  return {
    type: 'push_cookies',
    platform,
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
    })),
    captured_at: capturedAt,
  };
}

// Which platform a changed cookie belongs to, or null if neither.
// Cookie domains come in three shapes: "chatgpt.com" (host-only),
// ".chatgpt.com" (domain cookie), "ab.chatgpt.com" (subdomain).
export function platformForCookieDomain(domain: string): MiyoPlatform | null {
  const host = domain.startsWith('.') ? domain.slice(1) : domain;
  for (const platform of MIYO_PLATFORMS) {
    const base = MIYO_PLATFORM_DOMAINS[platform];
    if (host === base || host.endsWith(`.${base}`)) return platform;
  }
  return null;
}

// `status` payload the host returns for a { type: 'status' } message.
export type MiyoSyncState =
  | 'not_connected'
  | 'waiting_for_browser'
  | 'paused'
  | 'syncing'
  | 'synced'
  | 'error';

export interface MiyoPlatformStatus {
  label: string;
  state: MiyoSyncState;
  email: string | null;
  conversation_count: number;
  last_sync_at: number | null; // ms epoch
  syncing: { completed: number; total: number | null } | null;
  connected: boolean;
  folder_name: string;
}

export interface MiyoChatsStatus {
  version: number;
  configured: boolean;
  parent_path: string | null;
  platforms: Partial<Record<MiyoPlatform, MiyoPlatformStatus>>;
}

// Human copy for one platform's sync state, shown in the popup's
// status view.
export function syncStateCopy(p: MiyoPlatformStatus): string {
  switch (p.state) {
    case 'synced': {
      const n = p.conversation_count;
      return `Synced · ${n} conversation${n === 1 ? '' : 's'}`;
    }
    case 'syncing':
      return p.syncing && p.syncing.total !== null
        ? `Syncing… ${p.syncing.completed} of ${p.syncing.total}`
        : 'Syncing…';
    case 'waiting_for_browser':
      return 'Session expired — open the site to refresh';
    case 'not_connected':
      return 'Waiting for first sync';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Sync error';
  }
}

// Status-pill tone for one platform's sync state. Maps onto the
// existing popup.css `.status-*` pill classes.
export function syncStatePill(state: MiyoSyncState): string {
  switch (state) {
    case 'synced':
      return 'status-ready';
    case 'syncing':
      return 'status-syncing';
    case 'paused':
      return 'status-paused';
    case 'not_connected':
      return 'status-off';
    case 'waiting_for_browser':
      return 'status-warn';
    case 'error':
      return 'status-error';
  }
}
