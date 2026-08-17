---
name: analyze-miyo-diagnostics
description: Analyze a Miyo diagnostics log file. Parses the multi-section log (metadata, app logs, node service, qdrant, llama-server), surfaces errors and warnings per component, and produces a triage summary. Pass a file path or let the skill find the most recent export.
---

# Analyze Miyo Diagnostics

Analyze a Miyo diagnostics log file and produce a triage summary.

## Input

The user may pass a path to a diagnostics file, e.g. `/path/to/miyo-diagnostics-2026-05-29T12-00-00.txt`.
If no path is given, find the most recent export automatically (step 1).

## Log file structure

The file is produced by `exportDiagnostics()` in `desktop/electron/src/main/diagnostics.ts`.
Sections are separated by `================================================================` (64 `=` signs).
Order is always:

1. **Metadata block** — exported timestamp, app version, platform, service health, settings, time range
2. **APP LOG — `miyo-YYYY-MM-DDTHH-MM-SS.log`** — one section per app session in range
3. **NODE SERVICE LOG — `service.log`** — sidecar Node service
4. **QDRANT LOG — `qdrant.log`** — vector DB sidecar
5. **LLAMA-SERVER LOG — `llama-server.log`** — LLM inference sidecar

Log lines in app/service logs start with an ISO 8601 timestamp: `[2026-05-29T12:00:00.000Z]` or `2026-05-29T12:00:00Z`.

## Steps

### 1. Locate the file

If the user passed a path, use it directly. Otherwise:

```sh
ls -t ~/Desktop/miyo-diagnostics-*.txt 2>/dev/null | head -3
ls -t ~/Downloads/miyo-diagnostics-*.txt 2>/dev/null | head -3
ls -t ~/Library/Application\ Support/Miyo/*.txt 2>/dev/null | head -3
```

Use the most recently modified file whose name matches `miyo-diagnostics-*.txt`.
If none found, ask the user to provide the path.

### 2. Read the file

Use the Read tool to load the file. For large files (> ~4000 lines), read in chunks using offset/limit — start with the metadata section (first ~100 lines), then read each section in turn.

### 3. Split into sections

Split on the `================================================================` (64 `=`) divider lines.
Each section's title is the line immediately after the opening divider, e.g.:
- `Miyo Diagnostics` (metadata — bounded by dividers on both sides, no preceding title)
- `APP LOG — miyo-2026-05-29T11-00-00.log`
- `NODE SERVICE LOG — service.log (last 24h|full history)`
- `QDRANT LOG — qdrant.log (...)`
- `LLAMA-SERVER LOG — llama-server.log (...)`

### 4. Extract metadata

From the metadata section, extract:
- **Exported**: timestamp of export
- **App version**
- **Platform**
- **Service health**: overall status + per-component (`service=`, `qdrant=`, `llama=`)
- **Indexed files** count (if present)
- **Embedding model** (if present)
- **Health error** (if present)
- **Relay** status
- **Time range**: last 24h or full history
- **Settings**: note any non-default or noteworthy values (skip redacted ones)

Flag any health component status that is not `ok` or `healthy`.

### 5. Scan each log section for signals

For each section (app logs + sidecars), grep for:

**Errors** — lines containing (case-insensitive): `error`, `err:`, `exception`, `crash`, `fatal`, `uncaught`, `unhandled`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOENT`, `segfault`, `panic`

**Warnings** — lines containing (case-insensitive): `warn`, `warning`, `deprecated`, `retry`, `timeout`, `failed`, `disconnect`, `reconnect`

**Service lifecycle** — lines containing: `starting`, `started`, `stopping`, `stopped`, `restart`, `exit`, `killed`, `spawn`

For each signal:
- Record the timestamp (if present), the section name, and the full line (trimmed, truncated at 120 chars)
- Assign severity: `error` | `warning` | `info`
- Deduplicate: if the same message repeats > 3 times in a section, collapse to `Nx <message>` with first/last timestamps

### 6. Identify patterns

Look for:
- **Crash loops**: restart/exit events followed closely by errors
- **Connectivity failures**: repeated ECONNREFUSED / timeout to the same endpoint
- **Index/embedding failures**: errors in the service log mentioning `embed`, `index`, `qdrant`, `chunk`
- **Model load failures**: llama-server errors at startup (before first successful inference line)
- **Relay/tunnel issues**: disconnect/reconnect churn in the service log
- **Memory pressure**: OOM, `ENOMEM`, large allocation failures

### 7. Output the triage report

Write a concise structured report:

---

## Miyo Diagnostics — `<filename>`

**Exported:** `<timestamp>` | **App:** `<version>` | **Platform:** `<platform>` | **Range:** `<time range>`

### Service health
| Component | Status |
|-----------|--------|
| Overall   | `<status>` |
| service   | `<status>` |
| qdrant    | `<status>` |
| llama     | `<status or n/a>` |
| Relay     | `<status>` |
| Indexed files | `<count or n/a>` |
| Embedding model | `<model or n/a>` |

### Findings

Group by section, then by severity (errors first). For each finding:

> **[SECTION NAME]** `severity` — `timestamp` — `log line (≤120 chars)`

If a section is `[empty]` or `[no entries in last 24 hours]`, note it in one line and move on.

### Patterns *(omit if none)*
- Bullet-point summary of recurring patterns or correlated events.

### Summary
2–4 sentences. Overall system health, most likely root cause of any issue, and what to investigate first.

---

## Notes

- Surface only actionable lines — do not reproduce large blocks of log content.
- If the time range is "last 24h" and the issue may predate it, suggest re-exporting with "Include full log history" checked.
- Timestamps are critical for correlating events across sections; always include them in findings.
