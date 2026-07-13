<!-- brevilabs-review-guidelines:start (synced from Brevilabs/brevilabs-skills — edit there, not here) -->

## Review guidelines

Apply these in addition to the built-in review. Report only problems
introduced or exposed by this pull request, and describe the concrete failure
scenario for each finding rather than giving general advice.

Priorities, in order:

1. **Correctness** — logic errors, data loss, unhandled failure paths,
   concurrency hazards.
2. **Security** — authorization bypass, injection, secrets or private data
   leaving the codebase.
3. **Breaking changes and migrations** — changed function signatures, renamed
   or removed exports, altered return shapes, changed defaults, tightened
   validation; persisted schemas, settings files, and serialized formats that
   already-written data must still load. A change that needs a migration and
   ships without one is a defect. When a migration exists, check that it
   handles already-in-the-wild states, not just the happy path.
4. **Tests** — changed behavior, failure paths, and boundary cases are
   covered, and tests assert behavior rather than implementation detail.

Classification (this reviewer surfaces only P0/P1 findings):

- Treat as P1: an unhandled breaking change to a public API, plugin interface,
  CLI flag, or wire format; a change requiring a migration that ships without
  one; a data-corrupting or destructive operation; an authorization bypass; a
  reproducible crash.
- Never classify naming, formatting, or optional cleanup as P1. Formatting and
  style are enforced by automated checks; do not comment on them.

Scope discipline:

- Prefer fixes that remove code. Flag a new helper duplicating one that
  already exists, dead code the change itself creates, or a speculative
  abstraction with a single caller — but only when it conceals or causes a
  real defect.
- Do not suggest broad refactors unless required to fix a reported defect.
<!-- brevilabs-review-guidelines:end -->
