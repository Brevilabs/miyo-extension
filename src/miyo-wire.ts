// Wire shapes and pure helpers for the Miyo Desktop local service
// (http://127.0.0.1:8742). Chrome-free on purpose: this module is
// shared by the service worker, the popup, and the node:test unit
// tests (see tsconfig.test.json).

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

export interface MiyoCookiesBody {
  version: 1;
  platform: MiyoPlatform;
  cookies: CookieLike[];
  captured_at: number; // ms epoch
}

// POST /v0/chats/cookies request body.
export function buildCookiesBody(
  platform: MiyoPlatform,
  cookies: CookieLike[],
  capturedAt: number
): MiyoCookiesBody {
  return {
    version: 1,
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

// GET /v0/chats/status response.
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
