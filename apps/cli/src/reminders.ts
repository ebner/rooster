import { dueInstant, isValidTime, reminderTokenSpans } from '@rooster/core/dates';
import { parseReminderOffset, type ReminderSpec } from '@rooster/core/reminders';
import type { Me } from './api.ts';
import { parseDateFlag } from './dates.ts';
import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';

export type { ReminderSpec };

type ReminderMe = Pick<Me, 'timezone' | 'locale' | 'weekStart' | 'dateFormat' | 'prefs'>;

/** The time an all-day date means for a reminder: the user's default (FR-REM-2), else 09:00. */
function reminderTime(me: ReminderMe): string {
  const time = me.prefs.allDayReminderTime;
  return typeof time === 'string' && isValidTime(time) ? time : '09:00';
}

/**
 * `--remind <value>` (07 §4, P10): `15m`, `1h`, `1d` or `due` (with or without the title
 * token's `!`) are minutes before the due moment; anything else is a date and time phrase
 * ("fri 14:00", "tomorrow 9:00", "2026-11-02 08:30") read in the user's timezone, an absolute
 * reminder. A date without a time means the user's all-day reminder time. Recurrence phrases
 * are not reminders.
 */
export function parseRemindFlag(input: string, me: ReminderMe, nowMs: number): ReminderSpec {
  const text = input.trim().replace(/^!/, '');
  const offset = parseReminderOffset(text);
  if (offset !== null) return { offsetMinutes: offset };
  let parsed: ReturnType<typeof parseDateFlag> | null = null;
  if (text !== '') {
    try {
      parsed = parseDateFlag(text, me, nowMs, '--remind');
    } catch {
      parsed = null;
    }
  }
  if (parsed === null || parsed.recurrence !== undefined) {
    throw new CliError(EXIT.conflict, t('remind.invalid', { value: input }));
  }
  return { at: dueInstant(parsed.date, parsed.time ?? reminderTime(me), me.timezone) };
}

/** Every `--remind` value, parsed; duplicates collapse (the server would return the same one). */
export function parseRemindFlags(
  inputs: readonly string[],
  me: ReminderMe,
  nowMs: number,
): ReminderSpec[] {
  const out: ReminderSpec[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const spec = parseRemindFlag(input, me, nowMs);
    const key = 'at' in spec ? `at:${spec.at}` : `off:${spec.offsetMinutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out;
}

/**
 * A date phrase with reminder tokens in it (the TUI's date picker: "fri 14:00 !1h", "!15m"):
 * the phrase without the tokens, and the tokens' offsets in order, without duplicates.
 */
export function splitReminderTokens(text: string): { phrase: string; offsets: number[] } {
  const spans = reminderTokenSpans(text);
  let phrase = '';
  let at = 0;
  const offsets: number[] = [];
  for (const span of spans) {
    phrase += text.slice(at, span.start);
    at = span.end;
    if (!offsets.includes(span.offsetMinutes)) offsets.push(span.offsetMinutes);
  }
  phrase += text.slice(at);
  return { phrase: phrase.replace(/\s+/g, ' ').trim(), offsets };
}
