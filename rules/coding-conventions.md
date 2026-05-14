# Coding Conventions

- **Commits**: short, imperative, sentence case — e.g. `Drop the page-level early-stop on unbounded captures`. The body explains the *why*, not the *what*.
- **Typed errors**: use named `Error` subclasses for any error callers need to distinguish — `FatalError`, `RetryableError`, `MiyoUnavailableError`. Check with `instanceof`, never by matching message strings. Shared error classes live in `src/framework/rate-limit.ts` and `src/framework/miyo.ts`.
- **Cross-browser**: target Chromium-based browsers (Chrome, Edge, Brave, Arc) on MV3. Use the `chrome.*` namespace (Firefox aliases it). Avoid APIs that only Chromium-stable supports without checking — `chrome.storage.session` is required for the pacer's persistence across SW restarts.
- **Service worker constraints**: no top-level long-running work; no DOM access. Anything that needs to survive an idle-kill must be persisted (chrome.storage.local / IndexedDB) — the SW will be rehydrated on the next event.
- **Pacing**: every adapter network call must route through `paced(adapter.id, fn)`. The 1.5s floor is structural — never call `fetch` from an adapter without it.
- **Comments**: default to no comments. Add one only when the *why* is non-obvious (a workaround for a specific browser bug, a non-obvious invariant). Don't narrate what the code does — well-named identifiers do that. Don't reference past commits, the current task, or callers ("used by X", "added for Y flow"); those belong in PR descriptions and rot.
- **DOM rendering**: the popup uses vanilla DOM with `innerHTML` templates. Always `escape()` user-controlled strings before interpolation (`src/popup/index.ts` has a helper). Never `innerHTML` with untrusted content.
- **Markdown rendering**: filenames go through `makeDatePrefixedFilename` (`src/framework/filename.ts`) for deterministic dedup. The same item must always produce the same filename across syncs.
