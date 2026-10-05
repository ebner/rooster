import {
  type DateParseContext,
  findDateInTitle,
  stripBackticks,
  type TitleDateMatch,
} from '@rooster/core/dates';
import type { ViewerDateContext } from '../dates';

export { findGroupToken } from '@rooster/core/dates';

export interface Span {
  start: number;
  end: number;
}

export function parseContext(ctx: ViewerDateContext): DateParseContext {
  return {
    today: ctx.today,
    locale: ctx.locale,
    weekStart: ctx.weekStart,
    dateFormat: ctx.dateFormat,
  };
}

/** The date phrase to highlight while typing (02 §8.1: the last match). */
export function findTitleDate(
  title: string,
  ctx: ViewerDateContext,
  ignored: readonly Span[] = [],
): TitleDateMatch | null {
  return findDateInTitle(title, parseContext(ctx), ignored);
}

export interface ParsedTitle {
  title: string;
  /** Present when a date phrase was found and applied. */
  due?: { dueDate: string; dueTime: string | null; dueTz: string | null };
  /** `#tag` names found (02 §3.4), in title order, without duplicates (case-insensitive). */
  tags?: string[];
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

export interface TagToken extends Span {
  /** The name after `#`. */
  name: string;
}

/** `#` + letters, digits, `_` or `-`, at the start or after whitespace; at most 40 characters. */
const TAG_TOKEN_RE = /(?<=^|\s)#([\p{L}\p{N}_-]{1,40})(?=$|[\s.,;:!?)])/gu;

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** `#tag` tokens outside backtick escapes and ignored spans (02 §3.4). */
export function findTagTokens(text: string, ignored: readonly Span[] = []): TagToken[] {
  const escaped = [...text.matchAll(/`[^`]*`/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  const out: TagToken[] = [];
  for (const m of text.matchAll(TAG_TOKEN_RE)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (escaped.some((e) => overlaps(e, span)) || ignored.some((i) => overlaps(i, span))) continue;
    out.push({ ...span, name: m[1] as string });
  }
  return out;
}

/** The `#partial` token the caret is in or right after, for the autocomplete popover. */
export function tagTokenAt(text: string, caret: number): TagToken | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)#([\p{L}\p{N}_-]{0,40})$/u.exec(before);
  if (!m) return null;
  const start = caret - (m[1] ?? '').length - 1;
  let end = caret;
  while (end < text.length && /[\p{L}\p{N}_-]/u.test(text[end] as string)) end += 1;
  return { start, end, name: text.slice(start + 1, end) };
}

function removeSpans(text: string, spans: readonly Span[]): string {
  let out = '';
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < at) continue;
    out += `${text.slice(at, span.start)} `;
    at = span.end;
  }
  return out + text.slice(at);
}

/**
 * Applies the inline tokens on commit (02 §3.4): the date phrase is removed and becomes the
 * due date; escape backticks are stripped. A title that would be empty without the phrase
 * keeps it as text (a task called "tomorrow" stays "tomorrow").
 */
export function parseTitle(
  raw: string,
  ctx: ViewerDateContext,
  ignored: readonly Span[] = [],
  enabled = true,
): ParsedTitle {
  const tagTokens = findTagTokens(raw, ignored);
  const seen = new Set<string>();
  const tags = tagTokens
    .map((t) => t.name)
    .filter((name) => {
      const key = name.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // A title made only of tokens keeps its text (a task called "#idea" stays "#idea").
  const untagged = tagTokens.length > 0 ? removeSpans(raw, tagTokens) : raw;
  const withTags = (parsed: ParsedTitle): ParsedTitle =>
    tags.length > 0 && parsed.title !== '' ? { ...parsed, tags } : parsed;
  const match = enabled ? findTitleDate(raw, ctx, ignored) : null;
  if (match) {
    const title = collapse(stripBackticks(removeSpans(raw, [match, ...tagTokens])));
    if (title !== '') {
      return withTags({
        title,
        due: {
          dueDate: match.date,
          dueTime: match.time,
          dueTz: match.time ? ctx.timezone : null,
        },
      });
    }
  }
  const title = collapse(stripBackticks(untagged));
  if (title === '') return { title: collapse(stripBackticks(raw)) };
  return withTags({ title });
}
