# Design Principles

## 1. Capture only when the user clicks

No background polling, no `chrome.alarms`, no cookie listeners that fan out to fetches. The popup is the single trigger. A service-worker idle-kill mid-run is acceptable — `filterMissing` makes resume idempotent.

## 2. The store is the source of truth

The extension is intentionally stateless across runs:
- **Miyo mode**: Miyo owns the `(app_id, item_id) → filename` index. The extension diffs against it on every sync via `filterMissing`. No local watermark, no local index.
- **Local mode**: IndexedDB buffer holds rendered items until the popup zips + downloads them, then clears.

Never reintroduce a local-side dedup index that has to stay in sync with the store. Past attempts (`miyo_watermarks`, `newest_seen`) failed because partial syncs left them ahead of reality.

## 3. Don't leave the system in an inconsistent state

Every user action must resolve to a consistent state. If a capture is interrupted, the next sync must converge — never leave bookkeeping (`pending_run`, watermarks) ahead of what's actually in the store.

- **Pause** flushes `pending_run` and preserves the cursor for Resume.
- **Cancel** drops `pending_run` AND the buffer (local mode only).
- **Miyo mode shows Pause only**: items already POST'd to Miyo are durable, so a hard Stop that clears `pending_run` desyncs bookkeeping from reality. Use Discard from the paused state instead.

## 4. Correctness > perf shortcut

The page-level early-stop ("page is fully known → bail") was removed because it broke `All available` syncs that followed a bounded sync. If a perf optimization can be wrong in any reachable state, don't ship it.

## 5. Folder/output is plain markdown

Conversation data never leaves the user's machine. Output is one markdown file per conversation with YAML frontmatter. The format must remain readable by tools that aren't this extension (Obsidian, Logseq, `grep`).
