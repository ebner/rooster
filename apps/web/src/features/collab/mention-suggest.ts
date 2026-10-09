import { formatMention } from '@rooster/core/mentions';

/** An org member the composer can mention. */
export interface MentionCandidate {
  userId: string;
  name: string;
  email?: string | undefined;
  image?: string | null | undefined;
}

/** The `@query` being typed at the caret: where it starts and what follows the `@`. */
export interface MentionQuery {
  /** Offset of the `@`. */
  start: number;
  /** The caret (end of the query). */
  end: number;
  query: string;
}

/** At most this many characters after `@` still count as a name being typed. */
const maxQueryLength = 40;

/**
 * The mention being typed: an `@` at the start or after whitespace or an opening bracket, then
 * up to one space-separated word pair ("@anna l"), with the caret right after it. Stored
 * mentions (`@[Name](user:…)`) never match, because `[` cannot follow the `@`.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const prev = at === 0 ? '' : before[at - 1];
  if (prev !== '' && !/[\s(]/.test(prev ?? '')) return null;
  const query = before.slice(at + 1);
  if (query.length > maxQueryLength || /[\n[\]()@]/.test(query)) return null;
  // One inner space is allowed (first and last name); two words then a space ends it.
  if (/\s\S*\s/.test(query) || /^\s/.test(query)) return null;
  return { start: at, end: caret, query };
}

/** Lower-cased and accent-free, so "ake" finds "Åke" and "ostlund" finds "Östlund". */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Members matching `query`: a name word or the email starting with it, then names containing
 * it; alphabetical within each rank (by `Intl.Collator`, never `localeCompare` defaults).
 */
export function filterCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = 6,
): MentionCandidate[] {
  const q = fold(query.trim());
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
  const ranked: { candidate: MentionCandidate; rank: number }[] = [];
  for (const candidate of candidates) {
    const name = fold(candidate.name);
    const email = fold(candidate.email ?? '');
    let rank = -1;
    if (q === '' || name.startsWith(q)) rank = 0;
    else if (name.split(/\s+/).some((word) => word.startsWith(q)) || email.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    if (rank >= 0) ranked.push({ candidate, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || collator.compare(a.candidate.name, b.candidate.name));
  return ranked.slice(0, limit).map((r) => r.candidate);
}

/** The text after picking `candidate` for `mention`, and the caret behind the inserted token. */
export function insertMention(
  text: string,
  mention: MentionQuery,
  candidate: Pick<MentionCandidate, 'name' | 'userId'>,
): { text: string; caret: number } {
  const token = formatMention(candidate.name, candidate.userId);
  const after = text.slice(mention.end);
  const spacer = after.startsWith(' ') || after.startsWith('\n') ? '' : ' ';
  const next = `${text.slice(0, mention.start)}${token}${spacer}${after}`;
  const caret = mention.start + token.length + (after.startsWith('\n') ? 0 : 1);
  return { text: next, caret };
}
