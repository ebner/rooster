import type { VocabEntry } from './parse-vocab.ts';

export type ParseLocale = 'en' | 'sv';

/**
 * - `title`: 02 §8.1 vocabulary gating (UI language + English full words); no slash dates.
 * - `picker`: both languages fully, slash dates per `dateFormat`.
 * - `tail`: both languages fully, no slash dates; used to recognise a date after `>Group`.
 */
export type Mode = 'title' | 'picker' | 'tail';

// Word boundary after a phrase. A trailing apostrophe + letter ("tomorrow's") also blocks, so a
// possessive is never read as a date.
export const BOUNDARY = String.raw`(?![\p{L}\p{N}_])(?!['’]\p{L})`;

export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isActive(entry: VocabEntry<unknown>, mode: Mode, locale: ParseLocale): boolean {
  if (mode !== 'title') return true;
  return entry.lang === locale || (entry.lang === 'en' && !entry.abbr);
}

/** The entries of one vocabulary table active in a mode, as a regex alternation. */
export class Vocab<T> {
  readonly pattern: string;
  private readonly byText = new Map<string, VocabEntry<T>>();

  constructor(all: readonly VocabEntry<T>[], mode: Mode, locale: ParseLocale) {
    for (const e of all) if (isActive(e, mode, locale)) this.byText.set(e.text, e);
    this.pattern = [...this.byText.keys()]
      .sort((a, b) => b.length - a.length)
      .map((t) => escapeRe(t).replace(/ /g, String.raw`\s+`))
      .join('|');
  }

  /** The entry for text the pattern matched (so it always exists). */
  get(text: string): VocabEntry<T> {
    return this.byText.get(normalise(text)) as VocabEntry<T>;
  }
}

/** A case-insensitive sticky regex that must end on a word boundary. */
export function sticky(source: string): RegExp {
  return new RegExp(source + BOUNDARY, 'iuy');
}

export function execAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}
