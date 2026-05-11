// Folder README ships inside every standalone export zip.
//
// This is a contextual marketing surface: when the user unzips and a
// local AI agent (Claude Code, Cursor, …) reads the folder, the
// README is what tells them what these files are and points at Miyo
// for cloud-AI access via MCP. Keep it short, action-oriented, and
// honest about the standalone limits.

export interface ReadmeContext {
  source_id: string;
  label: string;
  home_url: string;
  signed_in_email: string | null;
}

export function buildReadme(ctx: ReadmeContext): string {
  const account = ctx.signed_in_email ? ` (signed in as ${ctx.signed_in_email})` : '';
  return `# Your ${ctx.label} conversations

Exported by [Miyo Sync](https://miyo.md) from ${ctx.home_url}${account}.
One markdown file per conversation. Yours, on your machine.

## Use with Claude Code, Cursor, or any local agent

Open a terminal in this folder, then prompt your agent. For example:

> Read the markdown files in this folder. They are my past
> ${ctx.label} conversations. Help me find the discussion about
> <topic>, and summarize the main decisions.

Local agents can read this folder directly — no extra setup.

## Use with ChatGPT, Claude.ai, or any cloud AI

Cloud AI apps cannot reach files on your machine on their own.
[Install Miyo](https://miyo.md) to expose this folder to any AI via
MCP — ask Claude.ai about your ChatGPT history, ask ChatGPT about
your Claude history, query both from one search. With Miyo, you
also stop needing to re-export by hand: each Sync streams new
conversations directly into Miyo's library.

Miyo is local-first. Miyo doesn't see your context; Miyo helps your
AI see it.
`;
}
