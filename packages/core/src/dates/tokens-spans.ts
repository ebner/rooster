import { parseReminderOffset } from '../reminders.ts';

/** A half-open UTF-16 range `[start, end)` in a title. */
export interface Span {
  start: number;
  end: number;
}

const ESCAPE_RE = /`[^`]*`/g;
// `#tag`, `@name`, `@"Quoted name"`, `>Group` and `>"Quoted group"`, each starting a
// whitespace-separated word. `@` must be followed by a letter (or a quote) so `@ 9am` / `@9am`
// stay time phrases.
const INLINE_TOKEN_RE = /(?<=^|\s)(?:#\S+|@\p{L}\S*|@"[^"\n]*"|>"[^"\n]*"|>\S+)/gu;
const TITLE_TAIL_RE = /^(?:\s+(?:#\S+|@\p{L}\S*|@"[^"\n]*"|>"[^"\n]*"|>\S+))*\s*$/u;

function spansOf(re: RegExp, text: string): Span[] {
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** Backtick-quoted escape spans (02 §3.4), including the backticks. */
export function escapeSpans(title: string): Span[] {
  return spansOf(ESCAPE_RE, title);
}

/** Inline `#tag`, `@name` and `>Group` tokens; a date phrase never matches inside one. */
export function inlineTokenSpans(title: string): Span[] {
  return spansOf(INLINE_TOKEN_RE, title);
}

// P10 (02 §8.1): `!15m`, `!2h`, `!1d`, `!due` as a whole whitespace-separated word.
const REMINDER_TOKEN_RE = /(?<=^|\s)!(\d{1,5}[mhd]|due)(?=\s|$)/giu;

export interface ReminderSpan extends Span {
  /** Minutes before the due moment (0 = `!due`). */
  offsetMinutes: number;
}

/**
 * Every well-formed reminder token in `text`, wherever it is, outside backtick escapes. Offsets
 * above `REMINDER_OFFSET_MAX` are not tokens (they stay text). Position rules are the caller's.
 */
export function reminderTokenSpans(text: string): ReminderSpan[] {
  const escaped = escapeSpans(text);
  const out: ReminderSpan[] = [];
  for (const m of text.matchAll(REMINDER_TOKEN_RE)) {
    const span = { start: m.index, end: m.index + m[0].length };
    const offsetMinutes = parseReminderOffset(m[1] as string);
    if (offsetMinutes !== null && !overlapsAny(span, escaped)) out.push({ ...span, offsetMinutes });
  }
  return out;
}

/**
 * True when `rest` is only whitespace, inline tokens and reminder tokens (what may follow an
 * end-only phrase). Every token must be preceded by whitespace.
 */
export function isTitleTail(rest: string): boolean {
  if (TITLE_TAIL_RE.test(rest)) return true;
  let stripped = '';
  let at = 0;
  for (const span of reminderTokenSpans(rest)) {
    if (span.start === 0) return false;
    stripped += rest.slice(at, span.start);
    at = span.end;
  }
  return at > 0 && TITLE_TAIL_RE.test(stripped + rest.slice(at));
}

export function overlapsAny(span: Span, spans: ReadonlyArray<Span>): boolean {
  return spans.some((s) => span.start < s.end && s.start < span.end);
}
