// Export tab entry point.
//
// Opened by the popup as chrome.runtime.getURL('export.html?source=<id>').
// The popup is a poor host for this work because it closes when the
// user clicks the OS save dialog, which would revoke the blob URL
// before chrome.downloads finishes reading it. A full tab survives
// the dialog and lets us listen for the download to complete so we
// can mark the source as exported.
//
// Flow:
//   1. Read the source row + buffered items from IndexedDB.
//   2. Build a zip in memory containing one README + one markdown
//      file per buffered conversation.
//   3. Trigger chrome.downloads.download with saveAs:true so the
//      user picks any folder (escapes the Downloads-only chrome.
//      downloads jail).
//   4. Listen on chrome.downloads.onChanged. On 'complete', mark the
//      source as exported and close the tab. On 'interrupted'
//      (including USER_CANCELED), surface the reason and stay open
//      so the user can retry.

import { forEachItem, getSource, markExported } from '../framework/buffer.js';
import { buildReadme } from '../framework/readme.js';
import { buildZip, type ZipFile } from './zip.js';

const root = document.getElementById('root')!;

function setStatus(html: string): void {
  root.innerHTML = html;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '"'
            ? '&quot;'
            : '&#39;'
  );
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface BuiltExport {
  zipName: string;
  blob: Blob;
  itemCount: number;
}

async function build(sourceId: string): Promise<BuiltExport> {
  const source = await getSource(sourceId);
  if (!source) {
    throw new Error(`No buffered data for ${sourceId}. Run Sync first.`);
  }
  const subdir = sourceId;
  const files: ZipFile[] = [
    {
      name: `${subdir}/README.md`,
      data: buildReadme({
        source_id: sourceId,
        label: source.label,
        home_url: source.home_url,
        signed_in_email: source.signed_in_email,
      }),
    },
  ];
  let count = 0;
  await forEachItem(sourceId, (item) => {
    files.push({
      name: `${subdir}/${item.filename}`,
      data: item.body,
      mtime: item.updated_at ? new Date(item.updated_at) : undefined,
    });
    count += 1;
  });

  return {
    zipName: `miyo-${sourceId}-${todayStamp()}.zip`,
    blob: buildZip(files),
    itemCount: count,
  };
}

function waitForDownload(
  downloadId: number
): Promise<{ kind: 'complete' } | { kind: 'interrupted'; reason: string }> {
  return new Promise((resolve) => {
    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve({ kind: 'complete' });
      } else if (state === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve({ kind: 'interrupted', reason: delta.error?.current ?? 'unknown' });
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const sourceId = params.get('source');
  if (!sourceId) {
    setStatus(
      `<h1>Export</h1><p class="error">Missing <code>source</code> parameter.</p>`
    );
    return;
  }

  setStatus(`<h1>Preparing export…</h1><p class="muted">Reading local buffer.</p>`);

  let built: BuiltExport;
  try {
    built = await build(sourceId);
  } catch (err) {
    setStatus(
      `<h1>Export failed</h1><p class="error">${escape(err instanceof Error ? err.message : String(err))}</p>`
    );
    return;
  }

  if (built.itemCount === 0) {
    setStatus(
      `<h1>Nothing to export</h1><p class="muted">The local buffer for ${escape(sourceId)} is empty. Run Sync first.</p>`
    );
    return;
  }

  setStatus(
    `<h1>Choose where to save</h1><p class="muted">Packaging ${built.itemCount} conversation${built.itemCount === 1 ? '' : 's'} as ${escape(built.zipName)}.</p>`
  );

  const url = URL.createObjectURL(built.blob);
  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename: built.zipName,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    setStatus(
      `<h1>Export failed</h1><p class="error">${escape(err instanceof Error ? err.message : String(err))}</p>`
    );
    return;
  }

  const outcome = await waitForDownload(downloadId);
  URL.revokeObjectURL(url);

  if (outcome.kind === 'complete') {
    await markExported(sourceId, Date.now());
    setStatus(
      `<h1>Export complete</h1><p class="muted">Saved ${built.itemCount} conversation${built.itemCount === 1 ? '' : 's'}. You can close this tab.</p>`
    );
    // Auto-close after a beat. Keeps tab clutter down without
    // yanking the success message out from under the user.
    setTimeout(() => window.close(), 1200);
  } else if (outcome.reason === 'USER_CANCELED') {
    setStatus(
      `<h1>Export canceled</h1><p class="muted">No file was saved. You can close this tab or try again from the popup.</p>`
    );
  } else {
    setStatus(
      `<h1>Export interrupted</h1><p class="error">${escape(outcome.reason)}</p>`
    );
  }
}

void run();
