import {
  type DateParseContext,
  findDateInTitle,
  stripBackticks,
  stripTitleMatch,
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
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

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
  const match = enabled ? findTitleDate(raw, ctx, ignored) : null;
  if (match) {
    const title = stripTitleMatch(raw, match);
    if (title !== '') {
      return {
        title,
        due: {
          dueDate: match.date,
          dueTime: match.time,
          dueTz: match.time ? ctx.timezone : null,
        },
      };
    }
  }
  return { title: collapse(stripBackticks(raw)) };
}
