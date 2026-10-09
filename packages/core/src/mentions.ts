import { UUIDV7_REGEX } from './ids.ts';

/**
 * Comment mentions (FR-COL-3, 06 §2.6): stored inside the Markdown-light body as
 * `@[Name](user:<id>)`. The name is a display snapshot; the ID is authoritative. Zod-free, so
 * the web can use it outside the lazy chunks.
 */

/** Matches one stored mention; group 1 is the name, group 2 the user ID. */
export const MENTION_PATTERN = /@\[([^\]\n]{1,100})\]\(user:([0-9a-f-]{36})\)/g;

export interface MentionMatch {
  name: string;
  userId: string;
  /** Offsets of the whole `@[Name](user:id)` token in the body. */
  start: number;
  end: number;
}

/** Every well-formed mention in `body`, in order (malformed IDs are skipped). */
export function findMentions(body: string): MentionMatch[] {
  const out: MentionMatch[] = [];
  for (const m of body.matchAll(MENTION_PATTERN)) {
    const [whole, name, userId] = m;
    if (name === undefined || userId === undefined || !UUIDV7_REGEX.test(userId)) continue;
    out.push({ name, userId, start: m.index, end: m.index + whole.length });
  }
  return out;
}

/** The distinct mentioned user IDs, in first-mention order. */
export function mentionedUserIds(body: string): string[] {
  return [...new Set(findMentions(body).map((m) => m.userId))];
}

/** The stored form of a mention. Brackets and newlines in the name are dropped. */
export function formatMention(name: string, userId: string): string {
  const safe = name.replace(/[[\]\n\r]/g, '').trim() || '?';
  return `@[${safe.slice(0, 100)}](user:${userId})`;
}

/** Plain text for previews and notifications: each mention becomes `@Name`. */
export function mentionsToPlain(body: string): string {
  let out = '';
  let last = 0;
  for (const m of findMentions(body)) {
    out += `${body.slice(last, m.start)}@${m.name}`;
    last = m.end;
  }
  return out + body.slice(last);
}
