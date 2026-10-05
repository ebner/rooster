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
