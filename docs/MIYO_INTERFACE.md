# Miyo App-Folder API

The contract between the Miyo Capture browser extension (the **client**)
and the Miyo desktop app (the **server**).

The design goal that drove this spec: **adding a new source to capture
from — ChatGPT, Claude, Notion, Gmail, an RSS reader — should require
zero changes to Miyo**. The extension picks a logical name for the
source, Miyo gives it a managed folder + an opaque metadata blob, and
everything else is the extension's business.

---

## 1. Conceptual model

An **app folder** is an *abstraction* — a logical destination
addressed by `app_id` (e.g., `"chatgpt"`, `"claude_ai"`). Miyo backs
each app folder with a real on-disk folder, but the extension never
refers to the on-disk path directly.

Three properties distinguish it from a regular Miyo folder:

| | App folder | Regular folder |
|---|---|---|
| On-disk location | Miyo picks initially; user may relocate later | User picks |
| Addressed externally by | `app_id` (stable) | absolute path |
| Contents | Captured by the extension | Written by the user |
| Metadata blob | Owned by the extension | n/a |

Everything else — markdown indexing, full-text search, the folder
showing up in Miyo's UI — works the same as any other folder.

### 1.1 The mapping

**`app_id` is the stable identity. The on-disk path is mutable.**
Miyo MUST persist a mapping `app_id → folder_id` (or `app_id →
folder_path`) and resolve the current location on every request that
references an app folder. Concretely:

- The extension only ever sends `app_id`.
- Miyo translates `app_id` to the current folder when handling
  requests (and writes files to the current location).
- If the user relocates the folder (via Miyo's UI, OS-level move
  followed by a Miyo "relocate" action, etc.), the mapping updates
  in place. The extension's next request continues to work
  unchanged — it'll get a new `folder_path` in the response, but
  the `folder_name` and `app_id` remain valid identifiers.

A reasonable storage shape on Miyo's side:

```sql
-- one row per app folder
CREATE TABLE app_folders (
  app_id              TEXT PRIMARY KEY,
  folder_path         TEXT NOT NULL,           -- current on-disk location
  label               TEXT NOT NULL,           -- display name
  metadata            TEXT,                    -- opaque JSON blob
  metadata_updated_at INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
```

Or piggyback on Miyo's existing folder table with an added nullable
`app_id` column. Implementation detail — the wire contract is the
same.

### 1.2 Other concepts

A **metadata blob** is an opaque JSON document attached to an app
folder. Miyo stores and serves it verbatim. The extension owns the
schema. This is the seam that lets the extension extend without
Miyo's involvement: bookkeeping (last sync time, what items are
present, what their `updated_at` was) lives in the blob.

The **app_id** identifies the source application this folder holds
data for. For Miyo Capture today: `"chatgpt"`, `"claude_ai"`. The
extension MAY introduce new app IDs at will. Miyo SHOULD accept any
`^[a-z0-9_-]{1,64}$`.

The extension is the orchestrator that talks to Miyo on behalf of
multiple apps. It is not an "app" in this protocol — the API
namespace is one level deep, by source.

---

## 2. Transport

Plain HTTP over loopback. Miyo desktop binds an HTTP server to
`127.0.0.1:8742`; the extension calls it with `fetch()`. Manifest
host permission: `http://127.0.0.1:8742/*`.

The port is fixed by Miyo's existing service contract (the desktop app
and CLI also use `:8742` and discover each other via `service.json`).
A browser extension can't read arbitrary files, so port discovery is
out — the extension hardcodes `:8742`, and a port collision at Miyo
startup is surfaced as a startup error there, not in the extension.

### 2.1 Detection

The extension calls `GET /v0/health` on every popup open. Miyo is
"available" when:

- Status 200,
- Response body parses as JSON, and
- The response contains `service: "running"`.

A 1500 ms timeout applies. Any failure (refused, slow, non-JSON,
`service !== "running"`) means the extension silently shows the
zip-export UI instead.

The `status` field MAY be `"degraded"` (e.g., embedding service not
ready). The extension treats `degraded` the same as `ok` — capture
writes don't depend on search/embedding being healthy.

### 2.2 CORS / origin restriction

Browser extensions send `Origin: chrome-extension://<extension-id>`.
With MV3 host permissions, the extension's `fetch` to localhost
bypasses CORS for response reads, so Miyo is **not strictly required**
to set `Access-Control-Allow-Origin` for the extension to work.

However, any local webpage can also `fetch()` localhost without CORS
on writes. Miyo therefore SHOULD reject requests whose `Origin`
header is not in an allow-list of trusted `chrome-extension://*`
origins for the write endpoints (POST `/v0/app-folder`, PUT
`/v0/app-folder/.../metadata`, POST `/v0/file`). Read endpoints MAY
be open.

In production, Miyo SHOULD restrict the allow-list to the official
Miyo Capture extension ID. During development, a `chrome-extension://*`
wildcard behind a developer-mode toggle is acceptable.

### 2.3 Content type

Request and response bodies are `application/json` with UTF-8. The
extension always sets `Content-Type: application/json` on POSTs and
PUTs.

---

## 3. Endpoints to be added

Three new endpoints. The first is app-folder create-or-get; the
other two read/write the metadata blob.

### 3.1 `POST /v0/app-folder` — create or get

Idempotent. Creates the app folder if it doesn't exist; returns it
either way.

**Request:**

```json
{
  "app_id": "chatgpt",
  "label": "ChatGPT"
}
```

| Field    | Type   | Required | Notes                                                    |
| -------- | ------ | -------- | -------------------------------------------------------- |
| `app_id` | string | yes      | `^[a-z0-9_-]{1,64}$`. Source identifier.                 |
| `label`  | string | yes      | Display name. Used as the folder's display name in Miyo. |

When creating, Miyo:

1. Picks an on-disk location, e.g.
   `<miyo-library>/apps/{app_id}/`. The exact layout is Miyo's
   choice; the extension never refers to it.
2. Registers it as a folder with:
   - `allow_writes: true`
   - `include_extensions: ["md"]`
   - `exclude_folders: []`
3. Stores `app_id` and `label` against the folder (extension to the
   existing FolderEntry, or a side table — Miyo's choice).

**Response 200:**

```json
{
  "folder_name": "ChatGPT",
  "folder_path": "/Users/.../Miyo/apps/chatgpt",
  "app_id": "chatgpt",
  "label": "ChatGPT",
  "metadata": { ... } | null,
  "metadata_updated_at": 1715600000000
}
```

`folder_name` is the value the extension passes as `folder` in
subsequent `POST /v0/file` calls.

`metadata` is the last-stored metadata blob (§3.3), or `null` if it
has never been set.

`metadata_updated_at` is the epoch-ms of the last metadata write, or
0 / null if never set.

Returning the metadata inline saves the extension a second round-trip
on the common popup-open path.

**Response 400** — validation failed.

### 3.2 `GET /v0/app-folder/:app_id/metadata`

Read the metadata blob standalone.

**Response 200:**

```json
{
  "metadata": { ... } | null,
  "metadata_updated_at": 1715600000000
}
```

**Response 404** — folder doesn't exist. The extension treats this as
"call POST /v0/app-folder first".

The extension primarily uses §3.1's inline metadata; this endpoint
is provided for clarity and for diagnostic / debug consumers.

### 3.3 `PUT /v0/app-folder/:app_id/metadata`

Replace the metadata blob.

**Request body:** any valid JSON value. Miyo treats this as an opaque
blob and stores it verbatim. No schema validation on Miyo's side.

The schema *the extension uses* is documented in §4 for the Miyo
team's reference, but the contract is "store whatever JSON I send and
return it next time."

**Response 200:**

```json
{ "ok": true, "metadata_updated_at": 1715600000000 }
```

**Response 404** — folder doesn't exist (call §3.1 first).

**Response 413** — body exceeds size cap. Miyo SHOULD enforce a
generous ceiling (e.g., 5 MB). The extension never sends close to
that in practice (typical: 10–100 KB).

---

## 4. Existing endpoints reused

No changes needed to these; they already do what we need.

### 4.1 `GET /v0/health` (existing)

Used for Miyo-availability detection (§2.1).

### 4.2 `POST /v0/file` (existing)

Used to write each captured item as a markdown file in the app
folder. The extension sets:

```json
{
  "folder": "<folder_name from §3.1>",
  "filename": "2026-04-28 Counting unique license keys (abc12345).md",
  "content": "---\nplatform: chatgpt\n...",
  "force": true
}
```

`force: true` is the right default for re-syncs: the same item id
re-captured at a newer `updated_at` produces the same deterministic
filename, and we want it to overwrite the old version.

---

## 5. Extension-owned metadata schema

This section documents what the extension PUTs as the metadata blob,
**for Miyo's reference only**. Miyo does NOT validate or interpret
this schema — it's "json bag, stored as-is, returned as-is."

```json
{
  "version": 1,
  "app_id": "chatgpt",
  "label": "ChatGPT",
  "last_sync_at": "2026-05-13T10:00:00Z",
  "items": {
    "abc-123": {
      "updated_at": "2026-05-12T14:30:00Z",
      "filename": "2026-04-28 Counting unique license keys (abc12345).md",
      "title": "Counting unique license keys",
      "url": "https://chatgpt.com/c/abc-123",
      "created_at": "2026-04-28T11:00:00Z"
    },
    "def-456": { ... }
  }
}
```

This is the extension's index: which items have been captured, what
their `updated_at` was at capture time, and what filename they
landed under. Reading this is the cheapest way for the extension to
answer:

- How many items are stored? → `Object.keys(items).length`
- What's the newest captured item? → `max(items[*].updated_at)`
- Has item X been captured? → `items[X] !== undefined`
- Has item X changed since capture? → `items[X].updated_at < new`

**Why the extension does not enumerate files**: For a user with
1,000 captured ChatGPT conversations, `GET /v0/folder/files` would
need to paginate hundreds of file rows on every popup open — a few
hundred ms of round-trips for what is fundamentally a "how many do
I have" question. One small JSON blob, GET-once at startup, replaces
that.

Versioning: the extension owns the schema. If a future extension
release bumps `version`, older extension installs may see a blob
they don't understand and SHOULD fall back to ignoring it (treating
the folder as empty until they re-sync). Miyo plays no role in
this.

---

## 6. Sequencing example

Typical popup-open + Send-to-Miyo run for ChatGPT, where the app
folder already exists with 1,200 captured items and the source has
5 new ones:

```
EXT  → MIYO  GET /v0/health
MIYO → EXT   200 { status:"ok", service:"running", ... }

EXT  → MIYO  POST /v0/app-folder { app_id:"chatgpt", label:"ChatGPT" }
MIYO → EXT   200 { folder_name:"ChatGPT", metadata: {items: {1200 entries}, ...}, ... }
             (extension reads metadata.items; pages site newest-first;
              finds 5 new ids; user clicks Send to Miyo)

EXT  → MIYO  POST /v0/file { folder:"ChatGPT", filename:"...A.md", content:"...", force:true }
MIYO → EXT   200 { path: "ChatGPT/...A.md" }
EXT  → MIYO  POST /v0/file { folder:"ChatGPT", filename:"...B.md", content:"...", force:true }
MIYO → EXT   200 { path: "ChatGPT/...B.md" }
EXT  → MIYO  POST /v0/file { folder:"ChatGPT", filename:"...C.md", content:"...", force:true }
MIYO → EXT   200 { path: "ChatGPT/...C.md" }
EXT  → MIYO  POST /v0/file { folder:"ChatGPT", filename:"...D.md", content:"...", force:true }
MIYO → EXT   200 { path: "ChatGPT/...D.md" }
EXT  → MIYO  POST /v0/file { folder:"ChatGPT", filename:"...E.md", content:"...", force:true }
MIYO → EXT   200 { path: "ChatGPT/...E.md" }

EXT  → MIYO  PUT /v0/app-folder/chatgpt/metadata
              body: { items: {1205 entries}, last_sync_at: "...", ... }
MIYO → EXT   200 { ok:true, metadata_updated_at: ... }
             (popup shows "5 sent to Miyo")
```

Total round trips: 2 reads (health, app-folder) + 5 writes (one per
new item) + 1 metadata write = 8. Localhost HTTP overhead is ~1ms
per request; rate-limiting on the source side dominates.

---

## 7. Folder lifecycle & user relocation

App folders are long-lived. The extension assumes the binding from
`app_id` to its backing folder is durable across:

- Browser restarts and SW death (extension state is ephemeral).
- Extension reinstall (the `app_id` is the same constant slug).
- User-initiated folder relocation in Miyo's UI.
- OS-level moves of the folder (subject to Miyo detecting them; see
  below).

### 7.1 Cases Miyo MUST handle

| Event | Expected Miyo behavior |
|---|---|
| User relocates folder via Miyo's UI | Update `folder_path` for the matching `app_id`. Subsequent reads return the new path. Files are physically moved by Miyo. |
| User renames folder in Miyo's UI | Update `folder_path` and `label`. The `app_id` stays the same; the extension's mental model is unaffected. |
| User deletes folder via Miyo's UI | Delete the `app_id → folder_path` mapping. The next `POST /v0/app-folder` for that `app_id` creates a fresh folder + empty metadata. The extension will then re-capture from scratch. |
| User moves folder via the OS (Finder, mv, etc.) without telling Miyo | Miyo's file watcher SHOULD detect the disappearance and either (a) mark the folder missing and return a clear error on subsequent calls, or (b) auto-recover if the new path can be inferred. Behavior is Miyo's choice; the extension surfaces whatever error Miyo returns. |
| User deletes the folder contents but keeps the folder | Files are gone but the mapping survives. Next capture writes new files; the metadata blob may reference filenames that no longer exist on disk — Miyo SHOULD prune them lazily, or the extension can re-capture via `force: true`. |

### 7.2 What the extension does

The extension calls `POST /v0/app-folder` on every popup open and at
the start of every capture run. This guarantees that:

- The folder is created if missing.
- The current `folder_name` is used in subsequent `POST /v0/file`
  calls.
- The current metadata blob is the one being diffed against.

The extension does NOT cache `folder_name` across capture runs. A
relocation between runs is fully transparent.

### 7.3 Metadata persistence strategy

Two reasonable choices for where Miyo stores the metadata blob:

**Option A: Sidecar file in the folder** (e.g.,
`<folder>/.miyo-app-metadata.json`). Moves automatically with the
folder. Survives Miyo database corruption. Visible to the user if
they browse the folder, which may be undesirable.

**Option B: Row in a Miyo table keyed by `app_id`** (recommended).
Survives folder corruption / accidental deletion. Doesn't leak
implementation details to users. Trivial to back up alongside Miyo's
other state. The downside — metadata is lost if Miyo's database is
wiped — is fine because the extension can rebuild by re-capturing.

Either works. **Key by `app_id`, not by `folder_id`**, so a folder
relocate doesn't accidentally orphan the metadata.

### 7.4 Folder name conflicts

`POST /v0/app-folder` requests a folder with a `label`. Miyo derives
an on-disk folder name from the label. If that name collides with an
existing non-app folder, Miyo SHOULD pick a safe variant (`ChatGPT`,
`ChatGPT (2)`, …) — the extension addresses by `app_id`, not by
folder name, so disambiguation is transparent.

---

## 8. Ownership map

| Concern                                | Owner     |
| -------------------------------------- | --------- |
| Source-side auth (cookies, tokens)     | Extension |
| Listing & fetching from the source     | Extension |
| Rate limiting per source               | Extension |
| Markdown rendering                     | Extension |
| What "has been captured" means         | Extension (via metadata) |
| Schema of the metadata blob            | Extension |
| When to re-capture vs skip             | Extension |
| Picking on-disk locations              | Miyo |
| Persisting markdown files              | Miyo |
| Persisting the metadata blob           | Miyo |
| Indexing markdown for search           | Miyo |
| Surfacing folders in Miyo's UI         | Miyo |
| HTTP server lifecycle, port binding    | Miyo |
| CORS / origin allow-listing            | Miyo |

When the extension is uninstalled or its cache is cleared, the
metadata blob in Miyo is the only thing keeping continuity. Reinstall
the extension on the same machine and the next `POST /v0/app-folder`
returns the existing folder + metadata; capture picks up where it
left off.

---

## 9. Why this design

An earlier draft of this protocol had a chat-specific message type
that carried a `conversation` payload. That worked for ChatGPT and
Claude but would have required protocol changes for every new source
type (notes, bookmarks, etc.).

The current design has zero source-aware surface on Miyo:

- The folder is a folder. Miyo's existing folder/file machinery works.
- The metadata is opaque JSON. Miyo's existing storage works.
- New sources get new `app_id`s — no API change.

The extension takes on three responsibilities in exchange:

1. Defining what a captured item looks like (filename, markdown body).
2. Defining what the metadata blob looks like.
3. Doing the diff (what's new) by comparing source-side listings
   against the metadata blob.

(1) and (2) are extension-internal. (3) is what the extension does
anyway.

---

## 10. Versioning

- `/v0/` matches Miyo's existing endpoint prefix. The app-folder
  endpoints land under `/v0/` for consistency.
- The extension MAY ship newer metadata schemas (`version` field
  inside the blob). Miyo does not interpret `version` — it's purely
  for the extension to coordinate with itself across releases.
- Additive HTTP changes (new optional fields on existing endpoints)
  do not need version bumps. Both sides ignore unknown fields.

---

## 11. Reference: minimal Miyo-side stub

The Miyo team's implementation surface is roughly:

```
POST /v0/app-folder
  - lookup or create folder under <miyo-library>/apps/{app_id}/
  - reuse existing folder-registration machinery with allow_writes=true,
    include_extensions=["md"]
  - read app_metadata table (or sidecar file) for this folder
  - return { folder_name, folder_path, app_id, label,
             metadata, metadata_updated_at }

GET /v0/app-folder/:app_id/metadata
  - lookup folder by app_id
  - return { metadata, metadata_updated_at } or 404

PUT /v0/app-folder/:app_id/metadata
  - lookup folder by app_id, 404 if missing
  - store request body verbatim against the folder
  - return { ok: true, metadata_updated_at }
```

Storage choice for the metadata blob is up to Miyo: a column on
the folder table, a `.app-metadata.json` sidecar in the folder, or
a separate key-value store all work. The extension's contract is
"I PUT it, I get the same thing back from the next GET."
