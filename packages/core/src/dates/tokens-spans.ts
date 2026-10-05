/** A half-open UTF-16 range `[start, end)` in a title. */
export interface Span {
  start: number;
  end: number;
}

const ESCAPE_RE = /`[^`]*`/g;
// `#tag`, `@name`, `>Group` and `>"Quoted group"`, each starting a whitespace-separated word.
// `@` must be followed by a letter so `@ 9am` / `@9am` stay time phrases.
const INLINE_TOKEN_RE = /(?<=^|\s)(?:#\S+|@\p{L}\S*|>"[^"\n]*"|>\S+)/gu;
const TITLE_TAIL_RE = /^(?:\s+(?:#\S+|@\p{L}\S*|>"[^"\n]*"|>\S+))*\s*$/u;

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

/** True when `rest` is only whitespace and inline tokens (what may follow an end-only phrase). */
export function isTitleTail(rest: string): boolean {
  return TITLE_TAIL_RE.test(rest);
}

export function overlapsAny(span: Span, spans: ReadonlyArray<Span>): boolean {
  return spans.some((s) => span.start < s.end && s.start < span.end);
}
