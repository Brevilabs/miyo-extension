// Render a normalized conversation as markdown.
//
// Output is byte-compatible with the Miyo desktop app's previous
// markdown renderer (see Miyo/desktop/electron/src/main/connections/
// markdown.ts). Keeping them aligned means files written by either
// component land in the same library directory and the desktop's file
// watcher indexes them identically.

import type { RawConversation, RawMessage } from './types.js';

const ROLE_LABEL: Record<RawMessage['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function renderConversationMarkdown(c: RawConversation): string {
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
