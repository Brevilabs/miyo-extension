// Low-level markdown utilities shared across adapters.
//
// Adapters compose these into their own renderers. The framework does
// NOT prescribe a markdown shape — different sites have different
// data (chat conversations, documents, bookmarks, emails) and any
// single rendering strategy would misrepresent some of them.
//
// For chat-shaped data specifically, see framework/chat.ts.

export function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

// `2026-04-28 14:32` — UTC, minute precision. Used for per-message
// headers in chat renderings; adapters that need different granularity
// should format directly.
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
