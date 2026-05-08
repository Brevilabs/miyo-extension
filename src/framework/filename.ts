// `2026-04-28 Counting unique license keys (abc12345).md`
//
// Three-part filename, kept identical to the Miyo desktop app's
// pre-rebuild convention so existing libraries stay coherent:
//   1. Date prefix from `created_at`. Stable — does not shift on every
//      reply the way `updated_at` would, so a renamed file does not
//      get its date shifted around.
//   2. Sanitized title, capped at 80 characters.
//   3. 8-char alphanumeric suffix from the conversation_id, so two
//      same-day same-title conversations don't collide.

// eslint-disable-next-line no-control-regex
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

export function makeConversationFilename(args: {
  id: string;
  title: string;
  createdAt: string | null;
}): string {
  const datePart = args.createdAt ? args.createdAt.slice(0, 10) : 'undated';
  const titlePart = sanitizeTitleForFilename(args.title);
  const shortId = args.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'id';
  return `${datePart} ${titlePart} (${shortId}).md`;
}
