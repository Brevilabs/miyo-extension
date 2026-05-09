// ChatGPT site adapter.
//
// Chat-shaped — returns a normalized ChatConversation; the framework
// derives the filename and renders the markdown so output is uniform
// with every other chat adapter.

import type {
  ChatSiteAdapter,
  ItemListPage,
  SiteSession,
} from '../framework/types.js';
import { classifyHttp, FatalError } from '../framework/rate-limit.js';
import type { ChatConversation, ChatMessage } from '../framework/chat.js';

type ChatgptTime = number | string | null | undefined;

interface ChatgptListItem {
  id: string;
  title: string;
  create_time: ChatgptTime;
  update_time: ChatgptTime;
}

interface ChatgptMessageNode {
  id: string;
  parent: string | null;
  children: string[];
  message: {
    id: string;
    author: { role: 'user' | 'assistant' | 'system' | 'tool' };
    create_time: ChatgptTime;
    content: { content_type: string; parts?: unknown[]; text?: string };
  } | null;
}

interface ChatgptFullConversation {
  conversation_id: string;
  title: string;
  create_time: ChatgptTime;
  update_time: ChatgptTime;
  current_node: string;
  mapping: Record<string, ChatgptMessageNode>;
}

const PAGE_SIZE = 50;
const TOKEN_CACHE_KEY = 'token:chatgpt';

function toIsoString(value: ChatgptTime): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function decodeJwtExpiryMs(token: string): number {
  try {
    const segments = token.split('.');
    const payload = segments[1];
    if (!payload) return Date.now() + 30 * 60_000;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    if (typeof json.exp === 'number') return json.exp * 1000;
  } catch {
    // fall through
  }
  return Date.now() + 30 * 60_000;
}

interface CachedToken {
  value: string;
  expiresAt: number;
  email: string | null;
}

async function getCachedToken(): Promise<CachedToken | null> {
  const obj = await chrome.storage.session.get(TOKEN_CACHE_KEY);
  return (obj[TOKEN_CACHE_KEY] as CachedToken | undefined) ?? null;
}

async function setCachedToken(t: CachedToken | null): Promise<void> {
  if (t === null) {
    await chrome.storage.session.remove(TOKEN_CACHE_KEY);
  } else {
    await chrome.storage.session.set({ [TOKEN_CACHE_KEY]: t });
  }
}

async function fetchAccessToken(): Promise<CachedToken> {
  const cached = await getCachedToken();
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached;

  const res = await fetch('https://chatgpt.com/api/auth/session', {
    headers: { accept: 'application/json' },
    credentials: 'include',
  });
  if (res.status === 401 || res.status === 403) {
    await setCachedToken(null);
    throw new FatalError(`auth/session ${res.status}`, res.status);
  }
  await classifyHttp(res, 'auth/session');

  const json = (await res.json()) as { accessToken?: string; user?: { email?: string } };
  if (!json.accessToken) {
    await setCachedToken(null);
    throw new FatalError('No accessToken in /api/auth/session', 401);
  }

  const t: CachedToken = {
    value: json.accessToken,
    expiresAt: decodeJwtExpiryMs(json.accessToken),
    email: json.user?.email ?? null,
  };
  await setCachedToken(t);
  return t;
}

async function chatgptApi<T>(token: string, urlPath: string): Promise<T> {
  const res = await fetch(`https://chatgpt.com/backend-api${urlPath}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    credentials: 'include',
  });
  await classifyHttp(res, `GET ${urlPath}`);
  return (await res.json()) as T;
}

function nodeText(node: ChatgptMessageNode): string {
  const c = node.message?.content;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (Array.isArray(c.parts)) {
    return c.parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && 'text' in p) {
          return String((p as { text: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function flatten(full: ChatgptFullConversation): ChatMessage[] {
  const chain: ChatgptMessageNode[] = [];
  let cursor: string | null = full.current_node;
  while (cursor) {
    const node: ChatgptMessageNode | undefined = full.mapping[cursor];
    if (!node) break;
    chain.push(node);
    cursor = node.parent;
  }
  chain.reverse();
  const out: ChatMessage[] = [];
  for (const node of chain) {
    const msg = node.message;
    if (!msg) continue;
    const text = nodeText(node).trim();
    if (!text) continue;
    if (msg.author.role === 'system') continue;
    out.push({
      role: msg.author.role,
      text,
      created_at: toIsoString(msg.create_time),
    });
  }
  return out;
}

export const chatgptAdapter: ChatSiteAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  subdir: 'chatgpt',
  home_url: 'https://chatgpt.com',
  brand_color: '#10a37f',
  kind: 'chat',

  async probeSession(): Promise<SiteSession> {
    try {
      const t = await fetchAccessToken();
      return { signedIn: true, email: t.email };
    } catch {
      return { signedIn: false, email: null };
    }
  },

  async listItems(cursor: string | null): Promise<ItemListPage> {
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const t = await fetchAccessToken();
    const list = await chatgptApi<{ items: ChatgptListItem[]; total?: number }>(
      t.value,
      `/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`
    );
    const items = (list.items ?? []).flatMap((it) => {
      if (!it.id) return [];
      const iso = toIsoString(it.update_time);
      if (!iso) return [];
      return [{ id: it.id, updated_at: iso }];
    });
    const total = typeof list.total === 'number' ? list.total : null;
    const next_offset = offset + PAGE_SIZE;
    const next_cursor =
      items.length < PAGE_SIZE || (total !== null && next_offset >= total)
        ? null
        : String(next_offset);
    return { items, next_cursor, total };
  },

  async fetchConversation(id: string): Promise<ChatConversation> {
    const t = await fetchAccessToken();
    const full = await chatgptApi<ChatgptFullConversation>(t.value, `/conversation/${id}`);
    return {
      site: 'chatgpt',
      conversation_id: full.conversation_id,
      title: full.title,
      url: `https://chatgpt.com/c/${full.conversation_id}`,
      created_at: toIsoString(full.create_time),
      updated_at: toIsoString(full.update_time),
      messages: flatten(full),
    };
  },
};
