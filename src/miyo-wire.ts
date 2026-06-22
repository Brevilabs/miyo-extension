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

// `status` payload the host returns for a { type: 'status' } message. Mirrors
// the desktop service's v2 multi-account shape (service-node manager.ts
// `ChatSyncStatus`): each platform carries an `accounts` array rather than a
// single flat status. The popup shows one pill per platform, so it collapses
// the array with summarizePlatform() below.
export type MiyoSyncState =
  | 'not_connected'
  | 'connecting'
  | 'waiting_for_browser'
  | 'syncing'
  | 'synced'
  | 'error';

export interface MiyoAccountStatus {
  slot_id: string;
  account_id: string | null;
  email: string | null;
  label: string | null;
  connected: boolean;
  state: MiyoSyncState;
  conversation_count: number;
  last_sync_at: number | null; // ms epoch
  syncing: { completed: number; total: number | null } | null;
}

export interface MiyoPlatformStatus {
  platform: MiyoPlatform;
  label: string;
  folder_path: string | null;
  folder_name: string | null;
  accounts: MiyoAccountStatus[];
}

export interface MiyoChatsStatus {
  version: number;
  configured: boolean;
  parent_path: string | null;
  platforms: Partial<Record<MiyoPlatform, MiyoPlatformStatus>>;
}

// A platform's accounts collapsed into the single state + counts the popup's
// one status pill renders.
export interface MiyoPlatformSummary {
  state: MiyoSyncState;
  conversationCount: number;
  syncing: { completed: number; total: number | null } | null;
}

// State precedence when a platform has several accounts: an actively-working
// or failing account should win over a quietly-synced one, so the single pill
// surfaces whatever most needs the user's attention. Lower index = higher
// priority.
const STATE_PRIORITY: MiyoSyncState[] = [
  'syncing',
  'connecting',
  'error',
  'waiting_for_browser',
  'synced',
  'not_connected',
];

function combineSyncing(
  a: { completed: number; total: number | null } | null,
  b: { completed: number; total: number | null } | null
): { completed: number; total: number | null } | null {
  if (!a) return b;
  if (!b) return a;
  // A null total means "unknown size"; one unknown makes the sum unknown.
  return {
    completed: a.completed + b.completed,
    total: a.total === null || b.total === null ? null : a.total + b.total,
  };
}

// Collapse a platform's accounts into one summary for the popup's single
// status pill. Returns null when there are no accounts yet — the popup keeps
// showing "Checking…" until the first account appears. Conversation counts sum
// across accounts; progress sums across whichever accounts are syncing.
export function summarizePlatform(p: MiyoPlatformStatus): MiyoPlatformSummary | null {
  if (p.accounts.length === 0) return null;
  let state: MiyoSyncState = 'not_connected';
  let rank = STATE_PRIORITY.length;
  let conversationCount = 0;
  let syncing: { completed: number; total: number | null } | null = null;
  for (const a of p.accounts) {
    conversationCount += a.conversation_count;
    const r = STATE_PRIORITY.indexOf(a.state);
    if (r !== -1 && r < rank) {
      rank = r;
      state = a.state;
    }
    if (a.state === 'syncing') syncing = combineSyncing(syncing, a.syncing);
  }
  return { state, conversationCount, syncing };
}

// Human copy for a platform's collapsed sync state, shown in the popup's
// status view.
export function syncStateCopy(s: MiyoPlatformSummary): string {
  switch (s.state) {
    case 'synced': {
      const n = s.conversationCount;
      return `Synced · ${n} conversation${n === 1 ? '' : 's'}`;
    }
    case 'syncing':
      return s.syncing && s.syncing.total !== null
        ? `Syncing… ${s.syncing.completed} of ${s.syncing.total}`
        : 'Syncing…';
    case 'connecting':
      return 'Connecting…';
    case 'waiting_for_browser':
      return 'Session expired — open the site to refresh';
    case 'not_connected':
      return 'Waiting for first sync';
    case 'error':
      return 'Sync error';
  }
}

// Status-pill tone for a platform's collapsed sync state. Maps onto the
// existing popup.css `.status-*` pill classes.
export function syncStatePill(state: MiyoSyncState): string {
  switch (state) {
    case 'synced':
      return 'status-ready';
    case 'syncing':
    case 'connecting':
      return 'status-syncing';
    case 'not_connected':
      return 'status-off';
    case 'waiting_for_browser':
      return 'status-warn';
    case 'error':
      return 'status-error';
  }
}
