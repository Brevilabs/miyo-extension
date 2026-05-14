# CLAUDE.md

## Build & Development

```bash
# Setup
npm install

# Build to ./dist (load this as an unpacked extension in chrome://extensions)
npm run build
npm run build:watch        # rebuild on change

# Static checks
npm run typecheck
npm run lint

# Package for distribution (produces miyo-capture-<version>-chrome.zip)
npm run package

# Bump version (keeps manifest.json + package.json in sync)
npm run version
```

Then open `chrome://extensions`, enable Developer mode, and "Load unpacked" → select `dist/`.

## Architecture

```
Popup (src/popup/) ───────────────────────┐
   ▲                                       │ chrome.runtime.connect("capture")
   │ chrome.runtime.sendMessage("snapshot") │
   ▼                                       ▼
Service Worker (src/background/)
   ├── Adapters (src/adapters/)        ── per-site list + fetch (ChatGPT, Claude)
   ├── Capture loop (src/framework/capture.ts)
   │     └── shouldStop hook for Pause/Cancel
   └── Store (src/framework/capture-store.ts)
         ├── IdbStore     → IndexedDB buffer, zipped + downloaded by popup
         └── MiyoStore    → HTTP POST to Miyo desktop (127.0.0.1:8742)
```

Capture is mode-agnostic: one loop walks list pages newest-first, diffs against the store via `filterMissing`, and writes the missing items. The destination (local zip vs Miyo) is the only thing that varies.

Detailed docs:

- [Adapter API](docs/ADAPTER-API.md) — how to add a new source (ChatGPT/Claude-style)
- [Miyo interface](docs/MIYO_INTERFACE.md) — wire protocol for the Miyo desktop sidecar (`127.0.0.1:8742`)
- [Contributing](docs/CONTRIBUTING.md)

## Planning

Before making big changes, write a plan in `docs/plans/` using today's date as a filename prefix, e.g. `docs/plans/2026-05-15-pause-button.md`. Present the plan to the user and wait for explicit approval before implementing.

## Workflow

Always make changes in a git worktree — never work directly in the main checkout. Use an existing worktree if one is already set up for the task, otherwise create a new one:

```bash
# New worktree from main
git worktree add .claude/worktrees/<name> -b <branch-name> main

# Re-enter an existing one
cd .claude/worktrees/<name>
```

Always open a PR — never commit directly to `main` — unless the user explicitly instructs otherwise.

After every git commit, run `/simplify` to review the code.

After every git push to a PR, run `/code-review:code-review` to review the PR.

## Rules Index

- [Design principles](rules/principles.md) — sync-only-when-clicked, local-only, source-of-truth ownership
- [Release process](rules/release.md) — tagging, version sync, GitHub Actions workflow
- [Backward compatibility](rules/backward-compatibility.md) — `chrome.storage.local` schema, Miyo wire-protocol versioning
- [Packaging](rules/packaging.md) — manifest, esbuild bundling, host permissions
- [Coding conventions](rules/coding-conventions.md) — commits, typed errors, cross-browser, comments
- [Testing](rules/testing.md) — manual test plan, regression checks
