import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPushCookiesMessage,
  platformForCookieDomain,
  summarizePlatform,
  syncStateCopy,
  syncStatePill,
  type CookieLike,
  type MiyoAccountStatus,
  type MiyoPlatformStatus,
  type MiyoPlatformSummary,
} from './miyo-wire.js';

// ---------------------------------------------------------------------------
// buildPushCookiesMessage
// ---------------------------------------------------------------------------

test('builds the push_cookies native message shape', () => {
  const cookies: CookieLike[] = [
    {
      name: '__Secure-next-auth.session-token',
      value: 'tok',
      domain: '.chatgpt.com',
      path: '/',
      expirationDate: 1_780_000_000,
    },
  ];
  const msg = buildPushCookiesMessage('chatgpt', cookies, 1_750_000_000_000);
  assert.deepEqual(msg, {
    type: 'push_cookies',
    platform: 'chatgpt',
    cookies: [
      {
        name: '__Secure-next-auth.session-token',
        value: 'tok',
        domain: '.chatgpt.com',
        path: '/',
        expirationDate: 1_780_000_000,
      },
    ],
    captured_at: 1_750_000_000_000,
  });
});

test('omits expirationDate for session cookies', () => {
  const msg = buildPushCookiesMessage(
    'claude_ai',
    [{ name: 'sessionKey', value: 'v', domain: 'claude.ai', path: '/' }],
    1
  );
  assert.equal(Object.prototype.hasOwnProperty.call(msg.cookies[0], 'expirationDate'), false);
});

test('strips extra cookie fields chrome attaches (httpOnly, secure, …)', () => {
  const chromeCookie = {
    name: 'n',
    value: 'v',
    domain: 'chatgpt.com',
    path: '/',
    httpOnly: true,
    secure: true,
    session: false,
    storeId: '0',
  };
  const msg = buildPushCookiesMessage('chatgpt', [chromeCookie as CookieLike], 1);
  assert.deepEqual(Object.keys(msg.cookies[0]!).sort(), ['domain', 'name', 'path', 'value']);
});

// ---------------------------------------------------------------------------
// platformForCookieDomain
// ---------------------------------------------------------------------------

test('matches host-only, dotted, and subdomain cookie domains', () => {
  assert.equal(platformForCookieDomain('chatgpt.com'), 'chatgpt');
  assert.equal(platformForCookieDomain('.chatgpt.com'), 'chatgpt');
  assert.equal(platformForCookieDomain('ab.chatgpt.com'), 'chatgpt');
  assert.equal(platformForCookieDomain('claude.ai'), 'claude_ai');
  assert.equal(platformForCookieDomain('.claude.ai'), 'claude_ai');
});

test('rejects lookalike and unrelated domains', () => {
  assert.equal(platformForCookieDomain('notchatgpt.com'), null);
  assert.equal(platformForCookieDomain('chatgpt.com.evil.example'), null);
  assert.equal(platformForCookieDomain('claude.ai.example'), null);
  assert.equal(platformForCookieDomain('example.com'), null);
});

// ---------------------------------------------------------------------------
// syncStateCopy / syncStatePill
// ---------------------------------------------------------------------------

function summary(overrides: Partial<MiyoPlatformSummary>): MiyoPlatformSummary {
  return { state: 'synced', conversationCount: 0, syncing: null, ...overrides };
}

test('maps sync states to popup copy', () => {
  assert.equal(syncStateCopy(summary({ state: 'synced', conversationCount: 42 })), 'Synced · 42 conversations');
  assert.equal(syncStateCopy(summary({ state: 'synced', conversationCount: 1 })), 'Synced · 1 conversation');
  assert.equal(syncStateCopy(summary({ state: 'syncing' })), 'Syncing…');
  assert.equal(
    syncStateCopy(summary({ state: 'syncing', syncing: { completed: 3, total: 10 } })),
    'Syncing… 3 of 10'
  );
  assert.equal(
    syncStateCopy(summary({ state: 'syncing', syncing: { completed: 3, total: null } })),
    'Syncing…'
  );
  assert.equal(syncStateCopy(summary({ state: 'connecting' })), 'Connecting…');
  assert.equal(
    syncStateCopy(summary({ state: 'waiting_for_browser' })),
    'Session expired — open the site to refresh'
  );
  assert.equal(syncStateCopy(summary({ state: 'not_connected' })), 'Waiting for first sync');
  assert.equal(syncStateCopy(summary({ state: 'error' })), 'Sync error');
});

test('maps every state to an existing pill class', () => {
  assert.equal(syncStatePill('synced'), 'status-ready');
  assert.equal(syncStatePill('syncing'), 'status-syncing');
  assert.equal(syncStatePill('connecting'), 'status-syncing');
  assert.equal(syncStatePill('not_connected'), 'status-off');
  assert.equal(syncStatePill('waiting_for_browser'), 'status-warn');
  assert.equal(syncStatePill('error'), 'status-error');
});

// ---------------------------------------------------------------------------
// summarizePlatform — collapses the v2 multi-account shape to one pill
// ---------------------------------------------------------------------------

function account(overrides: Partial<MiyoAccountStatus>): MiyoAccountStatus {
  return {
    slot_id: 'slot-1',
    account_id: 'acct-1',
    email: null,
    label: null,
    connected: true,
    state: 'synced',
    conversation_count: 0,
    last_sync_at: null,
    syncing: null,
    ...overrides,
  };
}

function platform(accounts: MiyoAccountStatus[]): MiyoPlatformStatus {
  return {
    platform: 'chatgpt',
    label: 'ChatGPT',
    folder_path: null,
    folder_name: null,
    accounts,
  };
}

test('returns null when a platform has no accounts (still "Checking…")', () => {
  assert.equal(summarizePlatform(platform([])), null);
});

test('passes a single account through, summing its conversation count', () => {
  assert.deepEqual(
    summarizePlatform(platform([account({ state: 'synced', conversation_count: 12 })])),
    { state: 'synced', conversationCount: 12, syncing: null }
  );
});

test('sums conversation counts across accounts', () => {
  const s = summarizePlatform(
    platform([
      account({ conversation_count: 12 }),
      account({ slot_id: 'slot-2', conversation_count: 30 }),
    ])
  );
  assert.equal(s?.conversationCount, 42);
});

test('surfaces the highest-priority account state (syncing wins over synced)', () => {
  const s = summarizePlatform(
    platform([
      account({ state: 'synced', conversation_count: 5 }),
      account({ slot_id: 'slot-2', state: 'syncing', syncing: { completed: 2, total: 8 } }),
    ])
  );
  assert.equal(s?.state, 'syncing');
  assert.deepEqual(s?.syncing, { completed: 2, total: 8 });
});

test('combines progress across concurrently-syncing accounts', () => {
  const s = summarizePlatform(
    platform([
      account({ state: 'syncing', syncing: { completed: 2, total: 8 } }),
      account({ slot_id: 'slot-2', state: 'syncing', syncing: { completed: 3, total: 10 } }),
    ])
  );
  assert.deepEqual(s?.syncing, { completed: 5, total: 18 });
});

test('an unknown total makes the combined total unknown', () => {
  const s = summarizePlatform(
    platform([
      account({ state: 'syncing', syncing: { completed: 2, total: null } }),
      account({ slot_id: 'slot-2', state: 'syncing', syncing: { completed: 3, total: 10 } }),
    ])
  );
  assert.deepEqual(s?.syncing, { completed: 5, total: null });
});

test('surfaces an erroring account over a synced one', () => {
  const s = summarizePlatform(
    platform([
      account({ state: 'synced', conversation_count: 9 }),
      account({ slot_id: 'slot-2', state: 'error' }),
    ])
  );
  assert.equal(s?.state, 'error');
  assert.equal(s?.conversationCount, 9);
});
