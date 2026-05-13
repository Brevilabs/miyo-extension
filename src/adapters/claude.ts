// Claude.ai site adapter.
//
// Chat-shaped — returns ChatConversation; framework derives filename
// and renders markdown.

import type {
  ChatSiteAdapter,
  ItemListPage,
  SiteSession,
} from '../framework/types.js';
import { classifyHttp } from '../framework/rate-limit.js';
import type { ChatConversation, ChatMessage } from '../framework/chat.js';

interface ClaudeOrgEntry {
  uuid: string;
  name: string;
}

interface ClaudeListItem {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface ClaudeFullConversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: Array<{
    uuid: string;
    text: string;
    sender: 'human' | 'assistant';
    created_at: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

interface ClaudeAccountInfo {
  account?: { email_address?: string; email?: string };
}

const ORG_CACHE_KEY = 'org:claude';
// Claude's /chat_conversations endpoint historically returned the full
// list. As of 2026 it paginates server-side, defaulting to a small page
// (~6–30 most-recent) when called without query params. We pass an
// explicit ?limit and ?offset so we control the page size; 200 is a
// round-trip-friendly balance for users with hundreds of chats.
const PAGE_SIZE = 200;

async function claudeApi<T>(urlPath: string): Promise<T> {
  const res = await fetch(`https://claude.ai${urlPath}`, {
    headers: {
      accept: 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
    },
    credentials: 'include',
  });
  await classifyHttp(res, `GET ${urlPath}`);
  return (await res.json()) as T;
}

async function getCachedOrgId(): Promise<string | null> {
  const obj = await chrome.storage.session.get(ORG_CACHE_KEY);
  return (obj[ORG_CACHE_KEY] as string | undefined) ?? null;
}

async function setCachedOrgId(id: string | null): Promise<void> {
  if (id === null) {
    await chrome.storage.session.remove(ORG_CACHE_KEY);
  } else {
    await chrome.storage.session.set({ [ORG_CACHE_KEY]: id });
  }
}

async function discoverOrgId(): Promise<string> {
  const cached = await getCachedOrgId();
  if (cached) return cached;
  const orgs = await claudeApi<ClaudeOrgEntry[]>('/api/organizations');
  const first = orgs[0];
  if (!first) throw new Error('No Claude organizations returned for this account');
  await setCachedOrgId(first.uuid);
  return first.uuid;
}

// The /chat_conversations endpoint is unstable across Claude releases —
// sometimes a bare array, sometimes wrapped in { conversations: [...] }
// or { data: [...] } with optional paging metadata. We accept any of
// these so a future shape tweak from Anthropic doesn't silently truncate
// the user's library to 0 again.
function extractList(raw: unknown): ClaudeListItem[] {
  if (Array.isArray(raw)) return raw as ClaudeListItem[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['conversations', 'data', 'items', 'results']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as ClaudeListItem[];
    }
  }
  return [];
}

function extractTotal(raw: unknown): number | null {
  // For a bare-array response we can't tell whether this is the whole
  // library or one paginated page — returning the array length here
  // would mislead the progress bar (e.g. "12 of 200" when the real
  // total is 1,000). Leave it null and let the framework show an
  // indeterminate count instead.
  if (Array.isArray(raw)) return null;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['total', 'total_count', 'count']) {
      const v = obj[key];
      if (typeof v === 'number') return v;
    }
  }
  return null;
}

function messageText(m: ClaudeFullConversation['chat_messages'][number]): string {
  if (Array.isArray(m.content) && m.content.length) {
    const parts = m.content.map((c) => c.text ?? '').filter(Boolean);
    if (parts.length) return parts.join('\n\n');
  }
  return m.text ?? '';
}

function toMessages(full: ClaudeFullConversation): ChatMessage[] {
  return full.chat_messages
    .map<ChatMessage>((m) => ({
      role: m.sender === 'human' ? 'user' : 'assistant',
      text: messageText(m).trim(),
      created_at: m.created_at,
    }))
    .filter((m) => m.text);
}

export const claudeAdapter: ChatSiteAdapter = {
  id: 'claude',
  label: 'Claude',
  home_url: 'https://claude.ai',
  brand_color: '#c66439',
  kind: 'chat',

  async probeSession(): Promise<SiteSession> {
    try {
      const orgs = await claudeApi<ClaudeOrgEntry[]>('/api/organizations');
      if (!orgs.length) return { signedIn: false, email: null };
      const orgId = orgs[0]!.uuid;
      await setCachedOrgId(orgId);
      const account = await claudeApi<ClaudeAccountInfo>(
        `/api/organizations/${orgId}/account`
      ).catch(() => null);
      return {
        signedIn: true,
        email: account?.account?.email_address ?? account?.account?.email ?? null,
      };
    } catch {
      return { signedIn: false, email: null };
    }
  },

  async listItems(cursor: string | null): Promise<ItemListPage> {
    const orgId = await discoverOrgId();
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    // Pass ?limit and ?offset explicitly. The endpoint behaves one of
    // two ways and we detect which from the response — don't trust the
    // server to respect our params:
    //   • Modern: respects ?limit, returns ≤ PAGE_SIZE rows for this
    //     offset. We advance the offset by what we got.
    //   • Legacy: ignores params, returns the entire library every call.
    //     We slice client-side so each page progresses and termination
    //     is correct (otherwise next_cursor never resolves to null).
    const raw = await claudeApi<unknown>(
      `/api/organizations/${orgId}/chat_conversations?limit=${PAGE_SIZE}&offset=${offset}`
    );
    const fullList = extractList(raw);
    const serverPaginated = fullList.length <= PAGE_SIZE;

    let pageRows: ClaudeListItem[];
    let next_cursor: string | null;
    let total: number | null;

    if (serverPaginated) {
      pageRows = fullList;
      next_cursor = fullList.length < PAGE_SIZE ? null : String(offset + fullList.length);
      total = extractTotal(raw);
    } else {
      // Legacy: server gave us the whole library. Sort once, slice the
      // page we need, and use the full-list length as the authoritative
      // total. next_cursor is null once we've sliced past the end.
      const sortedAll = fullList
        .slice()
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      pageRows = sortedAll.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + PAGE_SIZE;
      next_cursor = nextOffset >= sortedAll.length ? null : String(nextOffset);
      total = sortedAll.length;
    }

    // Page-local newest-first sort. Redundant for the legacy branch
    // (already sorted) but cheap, and required for the modern branch
    // since the server's per-page order isn't guaranteed.
    const sorted = pageRows.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const items = sorted.map((it) => ({ id: it.uuid, updated_at: it.updated_at }));
    return { items, next_cursor, total };
  },

  async fetchConversation(id: string): Promise<ChatConversation> {
    const orgId = await discoverOrgId();
    const full = await claudeApi<ClaudeFullConversation>(
      `/api/organizations/${orgId}/chat_conversations/${id}?tree=True&rendering_mode=raw`
    );
    return {
      site: 'claude',
      conversation_id: full.uuid,
      title: full.name,
      url: `https://claude.ai/chat/${full.uuid}`,
      created_at: full.created_at,
      updated_at: full.updated_at,
      messages: toMessages(full),
    };
  },
};
