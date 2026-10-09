import { createI18n, type Locale } from '@rooster/i18n';

/** A translator for the `mail` namespace in one locale (ICU messages). */
export type MailT = (key: string, values?: Record<string, string | number>) => string;

const translators = new Map<Locale, MailT>();

/** Emails, push texts and the unsubscribe page use the recipient's locale (04 §8). */
export function mailT(locale: Locale): MailT {
  let t = translators.get(locale);
  if (t === undefined) {
    const instance = createI18n(locale);
    const fixed = instance.getFixedT(locale, 'mail');
    t = (key, values) => fixed(key as never, values as never) as unknown as string;
    translators.set(locale, t);
  }
  return t;
}

/** A floating date (`YYYY-MM-DD`) spelled out, e.g. "Friday, October 9" / "fredag 9 oktober". */
export function longDate(locale: Locale, date: string): string {
  return new Intl.DateTimeFormat(locale === 'sv' ? 'sv-SE' : 'en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** An instant as a date in `tz`, e.g. "October 16, 2026" / "16 oktober 2026". */
export function instantDate(locale: Locale, at: number, tz: string): string {
  return new Intl.DateTimeFormat(locale === 'sv' ? 'sv-SE' : 'en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: tz,
  }).format(new Date(at));
}
