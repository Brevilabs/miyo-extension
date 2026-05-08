// Chat-shaped rendering helper.
//
// A convenience for adapters whose data IS a chat — a sequence of
// alternating user/assistant messages. ChatGPT and Claude both use
// this. Future adapters whose data is not chat-shaped (notes,
// bookmarks, documents) should not use this module — they own their
// rendering entirely.

import { escapeYaml, formatTimestamp } from './markdown.js';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  text: string;
  created_at: string | null;
}

export interface ChatConversation {
  // Site identifier. Written to frontmatter as `platform: <site>` for
  // backward compatibility with the desktop-rendered files; when we
  // drop that compat we can rename to `site`.
  site: string;
  conversation_id: string;
  title: string;
  url: string;
  created_at: string | null;
  updated_at: string | null;
  messages: ChatMessage[];
}

const ROLE_LABEL: Record<ChatRole, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

// Renders a chat conversation as markdown:
//   YAML frontmatter (platform, conversation_id, title, url, timestamps)
//   followed by `# Title` and one `## Role · timestamp` section per
//   message.
//
// Output is byte-compatible with the Miyo desktop app's previous
// markdown renderer so existing libraries stay coherent.
export function renderChatConversationMarkdown(c: ChatConversation): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`platform: ${c.site}`);
  lines.push(`conversation_id: ${c.conversation_id}`);
  lines.push(`title: "${escapeYaml(c.title || 'Untitled')}"`);
  lines.push(`url: ${c.url}`);
  if (c.created_at) lines.push(`created_at: ${c.created_at}`);
  if (c.updated_at) lines.push(`updated_at: ${c.updated_at}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${c.title || 'Untitled'}`);
  lines.push('');
  for (const m of c.messages) {
    const ts = formatTimestamp(m.created_at);
    const header = ts ? `## ${ROLE_LABEL[m.role]} · ${ts}` : `## ${ROLE_LABEL[m.role]}`;
    lines.push(header);
    lines.push('');
    lines.push(m.text.trim() || '_(empty)_');
    lines.push('');
  }
  return lines.join('\n');
}
