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

// Neutralize line-start `#` runs in message bodies. Miyo's chunker
// treats every `^#{1,6} .+` line as a section break — including matches
// inside fenced code blocks, since the regex isn't markdown-aware. A
// user or assistant message that quotes a header line ("# Heading",
// "## TODO", shell comments in a ```bash block, etc.) would silently
// split the surrounding turn into two sections.
//
// We prepend U+200B (zero-width space) so the line no longer starts
// with `#`. This works uniformly inside and outside code fences: the
// character is invisible to readers, but it both defeats the chunker's
// regex AND prevents CommonMark renderers from treating the line as a
// sub-heading (which we don't want either — sub-headings inside a turn
// would also break grouping for any future heading-aware tooling). A
// backslash escape (`\#`) would render as a literal `\#` inside fenced
// code, which is the visual norm for code-heavy chat transcripts.
const ZWSP = '​';
function neutralizeHeadingLines(text: string): string {
  return text.replace(/^(#{1,6} )/gm, ZWSP + '$1');
}

// Group an alternating message stream into conversational turns. A turn
// starts at each user message and absorbs the following assistant / tool
// / system replies. Leading non-user messages (e.g. a system preamble)
// form their own initial turn so nothing is dropped.
function groupTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length) turns.push(current);
  return turns;
}

// Renders a chat conversation as markdown:
//   YAML frontmatter (platform, conversation_id, title, url, timestamps)
//   then `# Title`, then one `## Turn · timestamp` section per
//   conversational turn (a user prompt plus the assistant replies that
//   follow it). Inside a turn, each message is introduced by a bold
//   `**Role · timestamp**` line — NOT a heading — so the turn stays one
//   section.
//
// The shape is chosen for Miyo's heading-based chunker: each turn is
// one section, which keeps a user prompt and its assistant reply in the
// same retrieval unit. The chunker may greedily pack multiple short
// turns into one chunk; long turns are split internally on paragraph
// boundaries.
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

  const turns = groupTurns(c.messages);
  for (const turn of turns) {
    const first = turn[0]!;
    const turnTs = formatTimestamp(first.created_at);
    lines.push(turnTs ? `## Turn · ${turnTs}` : `## Turn`);
    lines.push('');
    for (const m of turn) {
      const ts = formatTimestamp(m.created_at);
      const label = ts ? `**${ROLE_LABEL[m.role]} · ${ts}**` : `**${ROLE_LABEL[m.role]}**`;
      lines.push(label);
      lines.push('');
      const body = m.text.trim();
      lines.push(body ? neutralizeHeadingLines(body) : '_(empty)_');
      lines.push('');
    }
  }
  return lines.join('\n');
}
