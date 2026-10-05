import { type DateParseContext, type DateParseResult, parseDatePhrase } from '@rooster/core/dates';

export type ParseContext = DateParseContext;
export type ParsedDate = DateParseResult;

/**
 * The date picker's parser (02 §7, §8.1): both languages fully, plus numeric slash
 * dates. Swedish labels are always day-first (`formatRelative` ignores `MMM d` for
 * Swedish), so `12/10` is read day-first too. Returns null when the text is not a date.
 */
export function parsePickerInput(input: string, ctx: ParseContext): ParsedDate | null {
  return parseDatePhrase(input, ctx.locale === 'sv' ? { ...ctx, dateFormat: 'd MMM' } : ctx);
}
