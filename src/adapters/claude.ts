// Claude.ai site adapter.
//
// Lifted from the Miyo desktop app's previous claude-adapter. Cookies
// are attached automatically by the browser when fetching from the
// extension's host_permissions context.
//
// Claude's `/chat_conversations` endpoint returns the full list with no
// server-side pagination — we sort and slice locally. The list payload
// is ~100B per row even for thousands of conversations, so this is
// cheap to refetch.

import type {
  ConversationListPage,
  RawConversation,
  RawMessage,
  SiteAdapter,
  SiteSession,
} from '../framework/types.js';
import { classifyHttp } from '../framework/rate-limit.js';

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
const PAGE_SIZE = 50;

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

function messageText(m: ClaudeFullConversation['chat_messages'][number]): string {
  if (Array.isArray(m.content) && m.content.length) {
    const parts = m.content.map((c) => c.text ?? '').filter(Boolean);
    if (parts.length) return parts.join('\n\n');
  }
  return m.text ?? '';
}

function toMessages(full: ClaudeFullConversation): RawMessage[] {
  return full.chat_messages
    .map<RawMessage>((m) => ({
      role: m.sender === 'human' ? 'user' : 'assistant',
      text: messageText(m).trim(),
      created_at: m.created_at,
    }))
    .filter((m) => m.text);
}

export const claudeAdapter: SiteAdapter = {
  id: 'claude',
  label: 'Claude',
  subdir: 'claude',

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

  async listConversations(cursor: string | null): Promise<ConversationListPage> {
    const orgId = await discoverOrgId();
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const list = await claudeApi<ClaudeListItem[]>(
      `/api/organizations/${orgId}/chat_conversations`
    );
    const sorted = list.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const slice = sorted.slice(offset, offset + PAGE_SIZE);
    const items = slice.map((it) => ({
      id: it.uuid,
      title: it.name || 'Untitled',
      updated_at: it.updated_at,
    }));
    const next_offset = offset + PAGE_SIZE;
    const next_cursor = next_offset >= sorted.length ? null : String(next_offset);
    return { items, next_cursor, total: sorted.length };
  },

  async fetchConversation(id: string): Promise<RawConversation> {
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
