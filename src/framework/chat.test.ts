import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderChatConversationMarkdown,
  type ChatConversation,
  type ChatMessage,
} from './chat.js';

// The chunker in Miyo splits markdown into sections on this regex.
// Tests assert that our rendered output produces section breaks ONLY at
// the title and the per-turn `## Turn` headings — never inside message
// bodies, even when those bodies contain `#`-prefixed lines.
const CHUNKER_HEADING_RE = /^#{1,6} .+/gm;

function headings(md: string): string[] {
  return md.match(CHUNKER_HEADING_RE) ?? [];
}

function baseConvo(messages: ChatMessage[]): ChatConversation {
  return {
    site: 'claude_ai',
    conversation_id: 'conv-1',
    title: 'Test',
    url: 'https://example.test/c/conv-1',
    created_at: '2026-04-28T14:32:00Z',
    updated_at: '2026-04-28T14:35:00Z',
    messages,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

test('emits YAML frontmatter with platform, conversation_id, title, url, timestamps', () => {
  const md = renderChatConversationMarkdown(baseConvo([]));
  assert.match(md, /^---\nplatform: claude_ai\n/);
  assert.match(md, /conversation_id: conv-1\n/);
  assert.match(md, /title: "Test"\n/);
  assert.match(md, /url: https:\/\/example\.test\/c\/conv-1\n/);
  assert.match(md, /created_at: 2026-04-28T14:32:00Z\n/);
  assert.match(md, /updated_at: 2026-04-28T14:35:00Z\n/);
});

test('escapes double-quotes and newlines in title for safe YAML', () => {
  const md = renderChatConversationMarkdown({
    ...baseConvo([]),
    title: 'A "quoted"\ntitle',
  });
  assert.match(md, /title: "A \\"quoted\\" title"/);
});

test('falls back to Untitled when title is empty', () => {
  const md = renderChatConversationMarkdown({ ...baseConvo([]), title: '' });
  assert.match(md, /title: "Untitled"/);
  assert.match(md, /^# Untitled$/m);
});

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------

test('one user→assistant pair becomes a single `## Turn` section', () => {
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text: 'Hi.', created_at: '2026-04-28T14:32:00Z' },
      { role: 'assistant', text: 'Hello.', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  const hs = headings(md);
  // Title + one turn heading; nothing else.
  assert.deepEqual(hs, ['# Test', '## Turn · 2026-04-28 14:32']);
});

test('each new user message starts a new turn', () => {
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text: 'Q1', created_at: '2026-04-28T14:32:00Z' },
      { role: 'assistant', text: 'A1', created_at: '2026-04-28T14:32:10Z' },
      { role: 'user', text: 'Q2', created_at: '2026-04-28T14:35:00Z' },
      { role: 'assistant', text: 'A2', created_at: '2026-04-28T14:35:10Z' },
    ])
  );
  const hs = headings(md);
  assert.deepEqual(hs, [
    '# Test',
    '## Turn · 2026-04-28 14:32',
    '## Turn · 2026-04-28 14:35',
  ]);
});

test('consecutive assistant messages stay in the same turn', () => {
  // Some sites split a single assistant response into multiple messages
  // (tool call → result → final text). They must NOT split the turn.
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text: 'Q', created_at: '2026-04-28T14:32:00Z' },
      { role: 'assistant', text: 'thinking…', created_at: '2026-04-28T14:32:05Z' },
      { role: 'tool', text: 'result', created_at: '2026-04-28T14:32:08Z' },
      { role: 'assistant', text: 'final answer', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  const hs = headings(md);
  assert.equal(hs.length, 2, 'title + exactly one turn');
  assert.equal(hs[1], '## Turn · 2026-04-28 14:32');
  // All four message bodies are present in the same turn section.
  assert.ok(md.includes('thinking…'));
  assert.ok(md.includes('result'));
  assert.ok(md.includes('final answer'));
});

test('leading assistant/system messages form their own initial turn', () => {
  // E.g. a system preamble before the first user prompt. Don't drop it.
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'system', text: 'You are a helpful assistant.', created_at: '2026-04-28T14:30:00Z' },
      { role: 'user', text: 'Hi.', created_at: '2026-04-28T14:32:00Z' },
      { role: 'assistant', text: 'Hello.', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  const hs = headings(md);
  assert.deepEqual(hs, [
    '# Test',
    '## Turn · 2026-04-28 14:30',
    '## Turn · 2026-04-28 14:32',
  ]);
  assert.ok(md.includes('You are a helpful assistant.'));
});

test('omits timestamp when message has no created_at', () => {
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text: 'Q', created_at: null },
      { role: 'assistant', text: 'A', created_at: null },
    ])
  );
  const hs = headings(md);
  assert.deepEqual(hs, ['# Test', '## Turn']);
  assert.ok(md.includes('**User**'));
  assert.ok(md.includes('**Assistant**'));
});

test('renders empty message text as a placeholder, not as a blank section', () => {
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text: '', created_at: '2026-04-28T14:32:00Z' },
      { role: 'assistant', text: '   \n  ', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  // Two _(empty)_ placeholders — one per message.
  assert.equal((md.match(/_\(empty\)_/g) ?? []).length, 2);
});

// ---------------------------------------------------------------------------
// Role labels inside a turn are bold lines, NOT headings
// ---------------------------------------------------------------------------

test('role markers inside a turn use bold, not `##`', () => {
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text: 'Q', created_at: '2026-04-28T14:32:00Z' },
      { role: 'assistant', text: 'A', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  assert.ok(md.includes('**User · 2026-04-28 14:32**'));
  assert.ok(md.includes('**Assistant · 2026-04-28 14:32**'));
  // No `## User …` or `## Assistant …` lines — those would split the turn.
  assert.ok(!/^##\s+User\b/m.test(md));
  assert.ok(!/^##\s+Assistant\b/m.test(md));
});

// ---------------------------------------------------------------------------
// Heading-like content inside message bodies is neutralized
// ---------------------------------------------------------------------------

test('a `# Foo` line inside a user message does NOT create a new section', () => {
  const md = renderChatConversationMarkdown(
    baseConvo([
      {
        role: 'user',
        text: 'Can you explain this?\n\n# My Section Header\n\nThanks.',
        created_at: '2026-04-28T14:32:00Z',
      },
      { role: 'assistant', text: 'Sure.', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  const hs = headings(md);
  assert.deepEqual(hs, ['# Test', '## Turn · 2026-04-28 14:32']);
  // The original `# My Section Header` text is preserved (just preceded
  // by a zero-width space so the chunker regex won't match it).
  assert.ok(md.includes('# My Section Header'));
});

test('shell `# comment` lines inside fenced code blocks do NOT create sections', () => {
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text: 'show me bash', created_at: '2026-04-28T14:32:00Z' },
      {
        role: 'assistant',
        text: '```bash\n# install\nbrew install foo\n# run\nfoo --help\n```',
        created_at: '2026-04-28T14:32:10Z',
      },
    ])
  );
  const hs = headings(md);
  assert.deepEqual(hs, ['# Test', '## Turn · 2026-04-28 14:32']);
  // Comments still display as `# install` / `# run` (the ZWSP is invisible
  // to readers; the line content otherwise matches the original).
  assert.ok(md.includes('# install'));
  assert.ok(md.includes('# run'));
});

test('neutralizes every heading level h1–h6 inside message bodies', () => {
  const text = ['# h1', '## h2', '### h3', '#### h4', '##### h5', '###### h6'].join('\n');
  const md = renderChatConversationMarkdown(
    baseConvo([
      { role: 'user', text, created_at: '2026-04-28T14:32:00Z' },
      { role: 'assistant', text: 'ok', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  const hs = headings(md);
  // No body line should be picked up — only title + the turn header.
  assert.deepEqual(hs, ['# Test', '## Turn · 2026-04-28 14:32']);
});

test('does not neutralize `#` runs that are not heading-shaped (no space after, or 7+ hashes)', () => {
  // `#tag` (no space) is not a CommonMark heading and the chunker won't
  // match it either. `####### foo` (7 hashes) likewise. Leave both
  // untouched so user content isn't mangled.
  const md = renderChatConversationMarkdown(
    baseConvo([
      {
        role: 'user',
        text: '#tag and ####### deep are not headings',
        created_at: '2026-04-28T14:32:00Z',
      },
      { role: 'assistant', text: 'ok', created_at: '2026-04-28T14:32:10Z' },
    ])
  );
  // Neither line is preceded by the zero-width space marker.
  const ZWSP = '​';
  assert.ok(!md.includes(`${ZWSP}#tag`));
  assert.ok(!md.includes(`${ZWSP}####### deep`));
  // And the chunker still sees only the legitimate headings.
  assert.deepEqual(headings(md), ['# Test', '## Turn · 2026-04-28 14:32']);
});

// ---------------------------------------------------------------------------
// End-to-end: nothing in our output produces a section break inside a turn
// ---------------------------------------------------------------------------

test('arbitrary conversation: chunker sees exactly (title + N turns) headings', () => {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 5; i++) {
    messages.push({
      role: 'user',
      text: `# question ${i}\n\nbody with ## subheading`,
      created_at: `2026-04-28T14:3${i}:00Z`,
    });
    messages.push({
      role: 'assistant',
      text: '```py\n# comment in code\nprint(1)\n```',
      created_at: `2026-04-28T14:3${i}:30Z`,
    });
  }
  const md = renderChatConversationMarkdown(baseConvo(messages));
  const hs = headings(md);
  // 1 title + 5 turns = 6 headings exactly.
  assert.equal(hs.length, 6);
  assert.equal(hs[0], '# Test');
  for (let i = 1; i <= 5; i++) {
    assert.match(hs[i]!, /^## Turn · 2026-04-28 14:3\d$/);
  }
});
