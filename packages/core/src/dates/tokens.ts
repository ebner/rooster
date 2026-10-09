import { isDatePhrase } from './parse.ts';
import { escapeSpans, overlapsAny } from './tokens-spans.ts';

/** `>Group` token for smart views and the CLI (02 §3.4). */
export interface GroupTokenMatch {
  name: string;
  start: number;
  end: number;
}

const GROUP_TOKEN_RE = /(?<=^|\s)>(?:"([^"\n]+)"|(\S+))/gu;

/** Removes the backticks of escape spans (02 §3.4): "Read `next week` notes" → "Read next week notes". */
export function stripBackticks(title: string): string {
  return title.replace(/`([^`]*)`/g, '$1');
}

/**
 * Removes a matched date phrase (prepositions such as "on"/"på"/"den" are part of the match),
 * strips escape backticks, collapses whitespace and trims.
 */
export function stripTitleMatch(title: string, match: { start: number; end: number }): string {
  const removed = `${title.slice(0, match.start)} ${title.slice(match.end)}`;
  return stripBackticks(removed).replace(/\s+/g, ' ').trim();
}

/**
 * `>Group` (`>` + non-space run) or `>"Quoted name"`. It must be the last token: only whitespace or
 * a date phrase may follow it.
 */
export function findGroupToken(title: string): GroupTokenMatch | null {
  const escaped = escapeSpans(title);
  let found: GroupTokenMatch | null = null;
  for (const m of title.matchAll(GROUP_TOKEN_RE)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (overlapsAny(span, escaped)) continue;
    const rest = title.slice(span.end).trim();
    if (rest === '' || isDatePhrase(rest)) {
      found = { name: (m[1] ?? m[2]) as string, ...span };
    }
  }
  return found;
}

/** `#tag` token (02 §3.4): the name after `#`. */
export interface TagTokenMatch {
  name: string;
  start: number;
  end: number;
}

/** `#` + letters, digits, `_` or `-`, at the start or after whitespace; at most 40 characters. */
const TAG_TOKEN_RE = /(?<=^|\s)#([\p{L}\p{N}_-]{1,40})(?=$|[\s.,;:!?)])/gu;

/** Every `#tag` token outside backtick escapes, in title order (any position, unlike `>Group`). */
export function findTagTokens(title: string): TagTokenMatch[] {
  const escaped = escapeSpans(title);
  const out: TagTokenMatch[] = [];
  for (const m of title.matchAll(TAG_TOKEN_RE)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!overlapsAny(span, escaped)) out.push({ name: m[1] as string, ...span });
  }
  return out;
}

/** `title` without `spans` (each replaced by one space), whitespace not yet collapsed. */
export function removeSpans(
  title: string,
  spans: readonly { start: number; end: number }[],
): string {
  let out = '';
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < at) continue;
    out += `${title.slice(at, span.start)} `;
    at = span.end;
  }
  return out + title.slice(at);
}

/** `@name` token for assignment on inline create (02 §3.4, P6). */
export interface AssigneeTokenMatch {
  start: number;
  end: number;
  /** The text after `@` (without the quotes of `@"Full name"`). */
  query: string;
  /** The member it names, or null when none or several match (the token then stays text). */
  userId: string | null;
}

export interface AssigneeCandidate {
  userId: string;
  name: string;
  email?: string;
}

const ASSIGNEE_TOKEN_RE = /(?<=^|\s)@(?:"([^"\n]+)"|(\p{L}\S*))/gu;

/**
 * `@name` (`@` + a letter, then non-space) or `@"Full name"`, with the position rule of the
 * `>Group` token: it must be the last token, so only whitespace or a date phrase may follow it.
 * `userId` is resolved with `matchMembers` (`@me` is the viewer): a single whole-name match, or
 * else a single match at all.
 */
export function findAssigneeToken(
  title: string,
  members: readonly AssigneeCandidate[],
  viewerId?: string,
): AssigneeTokenMatch | null {
  const escaped = escapeSpans(title);
  let found: AssigneeTokenMatch | null = null;
  for (const m of title.matchAll(ASSIGNEE_TOKEN_RE)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (overlapsAny(span, escaped)) continue;
    const rest = title.slice(span.end).trim();
    if (rest !== '' && !isDatePhrase(rest)) continue;
    const query = (m[1] ?? m[2]) as string;
    const matches = matchMembers(query, members, viewerId);
    const exact = matches.filter((c) => c.exact);
    const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
    found = { ...span, query, userId: pick?.userId ?? null };
  }
  return found;
}

export interface MemberMatch {
  userId: string;
  /** The query is the whole name (or email), ignoring case and accents. */
  exact: boolean;
}

/**
 * Members a typed `@query` can mean, best first: a whole-name match, then the name starting with
 * it, then a later word of the name starting with it, then the email's local part. Case and
 * accents are ignored. `me` (and `mig` in Swedish) is the viewer. An empty query lists everyone.
 */
export function matchMembers(
  query: string,
  members: readonly AssigneeCandidate[],
  viewerId?: string,
): MemberMatch[] {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();
  const q = fold(query);
  const ranked: { userId: string; rank: number; exact: boolean }[] = [];
  for (const member of members) {
    const name = fold(member.name);
    const local = fold(member.email?.split('@')[0] ?? '');
    const self =
      viewerId !== undefined && member.userId === viewerId && (q === 'me' || q === 'mig');
    let rank = -1;
    if (self || name === q || (local !== '' && local === q)) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.split(/\s+/).some((word) => word.startsWith(q))) rank = 2;
    else if (local !== '' && local.startsWith(q)) rank = 3;
    if (rank >= 0) ranked.push({ userId: member.userId, rank, exact: rank === 0 });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map(({ userId, exact }) => ({ userId, exact }));
}

/**
 * The `@partial` token the caret is in or right after, for the autocomplete popover. `@"Full
 * na` (an open quote) runs to the closing quote, if any.
 */
export function assigneeTokenAt(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const quoted = /(?:^|\s)@"([^"\n]*)$/u.exec(before);
  if (quoted) {
    const start = caret - (quoted[1] as string).length - 2;
    const close = /^[^"\n]*"/.exec(text.slice(caret));
    const end = close ? caret + close[0].length : caret;
    return { start, end, query: text.slice(start + 2, close ? end - 1 : end) };
  }
  const m = /(?:^|\s)@(\p{L}\S*|)$/u.exec(before);
  if (!m) return null;
  const start = caret - (m[1] as string).length - 1;
  let end = caret;
  while (end < text.length && /\S/u.test(text[end] as string)) end += 1;
  return { start, end, query: text.slice(start + 1, end) };
}
