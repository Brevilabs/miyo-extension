// Filename utilities shared across adapters.
//
// Adapters call these to produce stable, filesystem-safe filenames.
// Stability is the contract: the same item must always produce the
// same filename so re-fetches overwrite the existing file (idempotent
// writes) and title-change detection (rename old → new) works.

const FILENAME_UNSAFE = /[/\\:*?"<>|\x00-\x1f]/g;
const TITLE_MAX = 80;

export function sanitizeTitleForFilename(title: string): string {
  const cleaned = (title ?? '')
    .replace(FILENAME_UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (!cleaned) return 'Untitled';
  return cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX).trim() : cleaned;
}

export function shortenId(id: string, length = 8): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, length) || 'id';
}

// `2026-04-28 Counting unique license keys (abc12345).md`
//
// Three-part filename adopted from the Miyo desktop app's pre-rebuild
// convention so existing libraries stay coherent. Adapters whose data
// has a natural date are encouraged to use this helper for
// consistency, but they are not required to — non-chat adapters with
// different natural shapes can produce their own filenames.
export function makeDatePrefixedFilename(args: {
  id: string;
  title: string;
  createdAt: string | null;
}): string {
  const datePart = args.createdAt ? args.createdAt.slice(0, 10) : 'undated';
  const titlePart = sanitizeTitleForFilename(args.title);
  const shortId = shortenId(args.id);
  return `${datePart} ${titlePart} (${shortId}).md`;
}
