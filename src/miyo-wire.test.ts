import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPushCookiesMessage,
  platformForCookieDomain,
  syncStateCopy,
  syncStatePill,
  type CookieLike,
  type MiyoPlatformStatus,
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

function status(overrides: Partial<MiyoPlatformStatus>): MiyoPlatformStatus {
  return {
    label: 'ChatGPT',
    state: 'synced',
    email: null,
    conversation_count: 0,
    last_sync_at: null,
    syncing: null,
    connected: true,
    folder_name: 'ChatGPT',
    ...overrides,
  };
}

test('maps sync states to popup copy', () => {
  assert.equal(syncStateCopy(status({ state: 'synced', conversation_count: 42 })), 'Synced · 42 conversations');
  assert.equal(syncStateCopy(status({ state: 'synced', conversation_count: 1 })), 'Synced · 1 conversation');
  assert.equal(syncStateCopy(status({ state: 'syncing' })), 'Syncing…');
  assert.equal(
    syncStateCopy(status({ state: 'syncing', syncing: { completed: 3, total: 10 } })),
    'Syncing… 3 of 10'
  );
  assert.equal(
    syncStateCopy(status({ state: 'syncing', syncing: { completed: 3, total: null } })),
    'Syncing…'
  );
  assert.equal(
    syncStateCopy(status({ state: 'waiting_for_browser' })),
    'Session expired — open the site to refresh'
  );
  assert.equal(syncStateCopy(status({ state: 'not_connected' })), 'Waiting for first sync');
  assert.equal(syncStateCopy(status({ state: 'paused' })), 'Paused');
  assert.equal(syncStateCopy(status({ state: 'error' })), 'Sync error');
});

test('maps every state to an existing pill class', () => {
  assert.equal(syncStatePill('synced'), 'status-ready');
  assert.equal(syncStatePill('syncing'), 'status-syncing');
  assert.equal(syncStatePill('paused'), 'status-paused');
  assert.equal(syncStatePill('not_connected'), 'status-off');
  assert.equal(syncStatePill('waiting_for_browser'), 'status-warn');
  assert.equal(syncStatePill('error'), 'status-error');
});
