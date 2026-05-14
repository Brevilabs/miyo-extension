# Miyo App-Folder API

Contract between the Miyo Capture browser extension (the **client**)
and the Miyo desktop app (the **server**).

The extension treats Miyo as a content-addressed store, very similar
to how it uses IndexedDB locally. Miyo owns the per-item index keyed
by `(app_id, item_id)`; the extension does not maintain a parallel
metadata blob on Miyo's side.

---

## 1. Conceptual model

An **app folder** is a logical destination addressed by a stable
`app_id` (e.g. `"chatgpt"`, `"claude_ai"`). Miyo backs each app
folder with a real on-disk folder, but the extension addresses it
only by `app_id`. The on-disk `folder_path` is returned to the
extension so it can be shown to the user (and the user may relocate
it later via Miyo itself).

| | App folder |
|---|---|
| On-disk location | Miyo picks initially; user may relocate via Miyo |
| Addressed externally by | `app_id` (stable) |
| Contents | Captured by the extension; one .md per item |
| Per-item index | Owned by Miyo, keyed by `(app_id, item_id)` |

---

## 2. Transport

`http://127.0.0.1:8742`. The extension's `manifest.json` includes
`http://127.0.0.1:8742/*` in `host_permissions` so the popup and
service worker can call it with `fetch()`.

All requests/responses are JSON unless stated otherwise. All endpoints
listed below are versioned under `/v0/`.

---

## 3. Endpoints

### `GET /v0/health`

Cheap liveness probe. The extension hits this on every popup open with
a 1500 ms timeout — anything else (refused, slow, non-JSON, wrong
shape) is treated as "Miyo not running" and the popup falls back to
local zip mode silently.

**Response 200**

```json
{ "service": "running", "status": "running" }
```

The extension requires `service === "running"`. `status` may be
`"degraded"` while non-capture subsystems are warming up (search
index, embeddings) — capture writes still work.

---

### `POST /v0/app-folder`

Create-or-get the app folder for a source. Idempotent.

**Request body**

```json
{ "app_id": "chatgpt", "label": "ChatGPT" }
```

- `app_id` (string, required): stable identifier for the source.
  The extension never changes this for an existing source.
- `label` (string, required): human-readable display name. Miyo
  may use this as the initial folder name; the extension always
  re-sends the latest label so renames in the extension propagate.

**Response 200**

```json
{
  "app_id": "chatgpt",
  "label": "ChatGPT",
  "folder_name": "ChatGPT",
  "folder_path": "/Users/alice/Miyo/ChatGPT",
  "count": 248
}
```

- `folder_name`: the bare folder identifier inside the user's Miyo
  library — used as the `folder` field in `POST /v0/file`.
- `folder_path`: absolute path on disk. The extension shows this in
  the popup so users know where files land.
- `count`: how many items are currently stored for this `app_id`.
  Drives the "N in Miyo" badge in the popup snapshot.

---

### `POST /v0/app-folder/:app_id/items/missing`

Bulk-check which item ids are *not yet* stored. Replaces the
metadata-diff dance — the extension sends a batch of source-side ids
per page and gets back the subset Miyo hasn't seen.

**Request body**

```json
{ "item_ids": ["67abc...", "67def...", "67ghi..."] }
```

**Response 200**

```json
{ "missing": ["67ghi..."] }
```

Order of `missing` is not significant; the extension treats it as a
set. If `item_ids` is empty, return `{ "missing": [] }` without an
error.

Unknown `app_id` → `404 { "error": "unknown_app", "detail": "..." }`.

---

### `POST /v0/file`

Write one captured item as a markdown file in the app folder, and
record `(app_id, item_id) → filename` in Miyo's index so subsequent
`items/missing` checks can find it.

**Request body**

```json
{
  "folder": "ChatGPT",
  "filename": "2026-04-14_my-conversation.md",
  "content": "---\ntitle: My conversation\n---\n\n…",
  "item_id": "67abc...",
  "force": true
}
```

- `folder` (string, required): `folder_name` from `POST /v0/app-folder`.
- `filename` (string, required): basename inside the app folder.
  Filenames are deterministic per `(item_id, content state)` — the
  extension never produces colliding names for distinct items.
- `content` (string, required): UTF-8 markdown.
- `item_id` (string, required): the source-side item id. Miyo
  indexes `(app_id, item_id) → filename` so `items/missing` can
  answer in O(1).
- `force` (boolean, optional, default false): if true, overwrite
  any existing file at this filename without prompting.

**Response 200**

```json
{ "filename": "2026-04-14_my-conversation.md" }
```

**Response 507** when out of disk space. The extension treats this
as fatal and aborts the run.

Other `4xx/5xx` are per-item failures; the extension logs and
continues to the next item.

---

## 4. State ownership

The extension keeps **all** capture-task state in
`chrome.storage.local` (the `pending_run` record). Miyo only owns:

1. The on-disk markdown files.
2. The `(app_id, item_id) → filename` index that backs
   `items/missing` and `count`.

There is no opaque metadata blob, no `last_sync_at`, no per-item
`updated_at` tracking on Miyo's side. The extension's resume model
relies entirely on `items/missing`: items already written survive
across browser restarts and SW deaths, and the next run skips them
via the bulk check.

---

## 5. Notes on file-content versioning

The current design does *not* re-fetch items that have changed
upstream after capture. `items/missing` answers existence only,
not freshness. Chat conversations grow append-only in practice, so
the missed-update case is rare. If you ever need "refresh truly
modified items", extend `items/missing` to take
`{ item_id, updated_at }` pairs and return ids whose stored
`updated_at` is older.
