// Downloads-folder transport.
//
// Used when the Miyo desktop app is not running. Each rendered item
// is dropped into ~/Downloads/Miyo/<source>/<filename> via the
// chrome.downloads API. The user can later install Miyo and switch
// modes by simply running the app — the next sync will detect Miyo
// and route through HTTP instead.
//
// Trade-offs:
//   - File location is fixed under Downloads (the API does not allow
//     arbitrary paths). Acceptable for the standalone "sampler" use
//     case; the user's chosen library folder takes over once Miyo is
//     installed.
//   - No filename-rename support. If a conversation's title changes
//     between syncs the new file lands beside the old one. The
//     sampler mode tolerates this; Miyo mode handles renames
//     properly via the receiver's stable_id dedupe.
//   - sync_finish is a no-op here. sync_start regenerates a folder
//     README that documents how to use the synced files (with local
//     agents today; with Miyo for cross-AI MCP exposure). The README
//     is the contextual surface that points users at Miyo when they
//     are about to consume the synced files.

import type { ItemPayload, SyncFinishPayload, SyncStartPayload, Transport } from './types.js';

export class DownloadsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadsUnavailableError';
  }
}

function buildDataUrl(body: string, mediaType = 'text/markdown'): string {
  // chrome.downloads.download cannot consume blob: URLs created in
  // the service worker context (URL.createObjectURL is unavailable
  // there). A data: URL works in every MV3 environment we target.
  // Markdown bodies are bounded by per-conversation size and the
  // base64 conversion stays cheap.
  const utf8 = new TextEncoder().encode(body);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function buildReadme(payload: SyncStartPayload, sourceId: string): string {
  const { label, home_url, signed_in_email } = payload;
  const account = signed_in_email ? ` (signed in as ${signed_in_email})` : '';
  return `# Your ${label} conversations

Synced by [Miyo Capture](https://miyo.md) from ${home_url}${account}.
One markdown file per conversation. Yours, on your machine.

This folder is regenerated on every sync. Edits to this README will
be overwritten — work with the conversation files directly.

## Use with Claude Code, Cursor, or any local agent

Open a terminal here:

\`\`\`
cd ~/Downloads/Miyo/${sourceId}
\`\`\`

Then prompt your agent. For example:

> Read the markdown files in this folder. They are my past
> ${label} conversations. Help me find the discussion about
> <topic>, and summarize the main decisions.

Local agents can read this folder directly — no extra setup.

## Use with ChatGPT, Claude.ai, or any cloud AI

Cloud AI apps cannot reach files on your machine on their own.
[Install Miyo](https://miyo.md) to expose this folder to any AI via
MCP — ask Claude.ai about your ChatGPT history, ask ChatGPT about
your Claude history, query both from one search.

Miyo is local-first. Miyo doesn't see your context; Miyo helps your
AI see it.
`;
}

export const downloadsTransport: Transport = {
  mode: 'downloads',

  async health() {
    if (typeof chrome === 'undefined' || !chrome.downloads?.download) {
      return { available: false, label: null };
    }
    return { available: true, label: '~/Downloads/Miyo' };
  },

  async postSyncStart(sourceId: string, payload: SyncStartPayload): Promise<void> {
    // Refresh the folder README. This is a contextual marketing
    // surface: the user (and their local AI agent) encounters it
    // exactly when they're trying to use the synced files. Failures
    // are non-fatal — sync should proceed even if the README write
    // hits an unexpected chrome.downloads error.
    try {
      const url = buildDataUrl(buildReadme(payload, sourceId));
      await chrome.downloads.download({
        url,
        filename: `Miyo/${sourceId}/README.md`,
        conflictAction: 'overwrite',
        saveAs: false,
      });
    } catch {
      // Swallow: the README is best-effort.
    }
  },

  async postItem(sourceId: string, payload: ItemPayload): Promise<void> {
    const url = buildDataUrl(payload.body);
    try {
      await chrome.downloads.download({
        url,
        filename: `Miyo/${sourceId}/${payload.filename}`,
        conflictAction: 'overwrite',
        saveAs: false,
      });
    } catch (err) {
      throw new DownloadsUnavailableError(
        `chrome.downloads failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  async postSyncFinish(_sourceId: string, _payload: SyncFinishPayload): Promise<void> {
    // No-op.
  },
};
