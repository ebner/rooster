import {
  type DateParseContext,
  findDateInTitle,
  findGroupToken,
  findReminderTokens,
  type ReminderTokenMatch,
  stripBackticks,
  type TitleDateMatch,
} from '@rooster/core/dates';
import type { ViewerDateContext } from '../dates';

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
  /**
   * Present when a date phrase was found and applied; a recurrence phrase ("every mon", P10)
   * adds the series' rule and basis.
   */
  due?: {
    dueDate: string;
    dueTime: string | null;
    dueTz: string | null;
    recurrence?: string;
    recurrenceBasis?: 'due' | 'completion';
  };
  /** `#tag` names found (02 §3.4), in title order, without duplicates (case-insensitive). */
  tags?: string[];
  /** P10 (02 §8.1): `!15m`/`!1h`/`!1d`/`!due` as minutes before the due moment, in order. */
  reminders?: number[];
}

/**
 * The `!15m` reminder tokens a title applies (02 §8.1, P10): only with a due date, from the
 * title's own date phrase or the task's (`hasDue`); otherwise they stay plain text.
 */
export function titleReminderTokens(
  text: string,
  ignored: readonly Span[],
  hasDue: boolean,
): ReminderTokenMatch[] {
  if (!hasDue) return [];
  return findReminderTokens(text).filter((t) => !ignored.some((span) => overlaps(span, t)));
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

export interface TagToken extends Span {
  /** The name after `#`. */
  name: string;
}

/** `#` + letters, digits, `_` or `-`, at the start or after whitespace; at most 40 characters. */
const TAG_TOKEN_RE = /(?<=^|\s)#([\p{L}\p{N}_-]{1,40})(?=$|[\s.,;:!?)])/gu;

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

export interface GroupTokenHit extends Span {
  groupId: string;
  /** The matched group's name. */
  name: string;
}

/**
 * `>Group` (02 §3.4, smart views only): the trailing token, matched against `groups` by exact
 * name, then case-insensitively, then as a case-insensitive prefix. Unmatched tokens stay text.
 */
export function resolveGroupToken(
  text: string,
  groups: readonly { id: string; name: string }[],
  ignored: readonly Span[] = [],
): GroupTokenHit | null {
  const token = findGroupToken(text);
  if (!token || ignored.some((span) => overlaps(span, token))) return null;
  const wanted = token.name.toLocaleLowerCase();
  const group =
    groups.find((g) => g.name === token.name) ??
    groups.find((g) => g.name.toLocaleLowerCase() === wanted) ??
    groups.find((g) => g.name.toLocaleLowerCase().startsWith(wanted));
  return group ? { start: token.start, end: token.end, groupId: group.id, name: group.name } : null;
}

/** `text` with `span` blanked out; the other spans keep their offsets. */
export function blankSpan(text: string, span: Span): string {
  return `${text.slice(0, span.start)}${' '.repeat(span.end - span.start)}${text.slice(span.end)}`;
}

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
  /** P10: the task already has a due date, so `!1h` applies without a date phrase. */
  hasDue = false,
): ParsedTitle {
  const match = enabled ? findTitleDate(raw, ctx, ignored) : null;
  const reminderTokens = enabled ? titleReminderTokens(raw, ignored, hasDue || match !== null) : [];
  if (reminderTokens.length > 0) {
    // Parsed without the tokens, which are removed like the date phrase.
    const rest = reminderTokens.reduce((text, token) => blankSpan(text, token), raw);
    const parsed = parseTitle(rest, ctx, ignored, enabled, hasDue);
    if (parsed.title === '') return { title: collapse(stripBackticks(raw)) };
    const offsets = [...new Set(reminderTokens.map((t) => t.offsetMinutes))];
    return { ...parsed, reminders: offsets };
  }
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
  if (match) {
    const title = collapse(stripBackticks(removeSpans(raw, [match, ...tagTokens])));
    if (title !== '') {
      return withTags({
        title,
        due: {
          dueDate: match.date,
          dueTime: match.time,
          dueTz: match.time ? ctx.timezone : null,
          ...(match.recurrence
            ? { recurrence: match.recurrence.rule, recurrenceBasis: match.recurrence.basis }
            : {}),
        },
      });
    }
  }
  const title = collapse(stripBackticks(untagged));
  if (title === '') return { title: collapse(stripBackticks(raw)) };
  return withTags({ title });
}
