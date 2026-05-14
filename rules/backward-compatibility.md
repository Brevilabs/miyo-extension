# Backward Compatibility

When changing a persisted shape, decide whether existing installs need a migration.

## Check release status first

```bash
gh release list --repo Brevilabs/miyo-extension --limit 10
```

If the change is on a feature branch that has not been released, you can freely break the shape — there are no users on it.

If the change is on something already shipped (any tag), you need migration or a clean reset.

## What's persisted

| Surface | Where | Owner |
|---|---|---|
| `pending_run` | `chrome.storage.local` | Extension |
| `last_snapshot` | `chrome.storage.local` | Extension (cache, safe to drop) |
| `miyo_enabled` | `chrome.storage.local` | Extension (user preference) |
| Pacer state | `chrome.storage.session` | Extension (ephemeral) |
| Time-range preferences | `chrome.storage.local` | Extension |
| Captured items (zip mode) | IndexedDB | Extension |
| App-folder metadata | Miyo server | Miyo (via `/v0/app-folder/.../metadata`) |
| Conversation files | Miyo server | Miyo |

## Rules

- **Adding optional fields** to a persisted record (`pending_run`, etc.) is safe: TypeScript treats them as optional on read, the spread in `updatePendingRun` round-trips old objects untouched.
- **Removing fields** is safe at the type level (TypeScript ignores extras at runtime) but leaves stale data in storage. If the field is small, this is fine. If it's large (e.g., a map of timestamps), add a one-shot cleanup step.
- **Renaming a field** requires a migration: read the old key, write the new key, then delete the old key. Never leave both names live.
- **Miyo wire protocol**: never rename or retype an existing released `/v0/...` field. Add new fields instead. The contract lives in [`docs/MIYO_INTERFACE.md`](../docs/MIYO_INTERFACE.md) — keep it in lockstep with the actual `MiyoClient` calls.
- **Chrome storage keys** are global per extension ID. A key collision with a prior extension version inherits the prior value. Use namespacing (`pacer:<site>`, etc.) and version your keys (`pending_run_v2`) if a clean break is needed.
