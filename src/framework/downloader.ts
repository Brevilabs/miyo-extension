// Direct-to-Downloads writer.
//
// Each captured item lands as its own .md file in
//   ~/Downloads/miyo-capture/<siteId>/<filename>
//
// We use chrome.downloads.download with conflictAction:'overwrite' so
// re-running the same range cleanly replaces the prior files — the
// filesystem is the source of truth, the extension keeps no state.
//
// Why a data: URL: MV3 service workers don't expose URL.createObjectURL,
// so we encode the markdown as base64 inside a data URL. Markdown
// payloads are KB-sized in practice; the encoding overhead is fine.
// Base64 (vs encodeURIComponent) is more compact and avoids any
// percent-encoding edge cases inside chrome.downloads.

import type { CapturedItem, SiteId } from './types.js';

const ROOT_FOLDER = 'miyo-capture';

export async function downloadMarkdown(
  siteId: SiteId,
  item: CapturedItem
): Promise<void> {
  const url = makeDataUrl(item.markdown);
  const filename = `${ROOT_FOLDER}/${siteId}/${item.filename}`;
  await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'overwrite',
    saveAs: false,
  });
}

function makeDataUrl(markdown: string): string {
  const bytes = new TextEncoder().encode(markdown);
  return `data:text/markdown;charset=utf-8;base64,${uint8ToBase64(bytes)}`;
}

// Chunked base64 so we don't blow the call-stack on large markdown
// (spreading a big Uint8Array into String.fromCharCode arguments would).
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
