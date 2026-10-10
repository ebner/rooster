import { detectLocale, type Locale } from '@rooster/i18n';
import enServer from '@rooster/i18n/locales/en/server.json' with { type: 'json' };
import svServer from '@rooster/i18n/locales/sv/server.json' with { type: 'json' };

/** Keys of the `server` namespace (packages/i18n/locales/<locale>/server.json). */
export type ServerTextKey =
  | 'group.inbox'
  | 'group.today'
  | 'group.prio'
  | 'group.upcoming'
  | 'org.personal'
  | 'signIn.notInvited'
  | 'signIn.disabled'
  | 'signIn.unverifiedEmail'
  | 'signIn.accountLinkBlocked'
  | 'signIn.identityUnlinked';

type Catalog = typeof enServer;
const catalogs: Record<Locale, Catalog> = { en: enServer, sv: svServer };

/** Server-side copy (default group names, sign-in rejections) in the given locale. */
export function serverText(locale: Locale, key: ServerTextKey): string {
  const [section, name] = key.split('.') as [keyof Catalog, string];
  const group = catalogs[locale][section] as Record<string, string>;
  const value = group[name];
  if (value === undefined) throw new Error(`missing server text ${locale}:${key}`);
  return value;
}

/**
 * Language tags of an `Accept-Language` header, most preferred first
 * (`sv-SE,sv;q=0.9,en;q=0.5` → `['sv-SE', 'sv', 'en']`). Tags with q=0 are dropped.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((l) => l.tag !== '' && l.tag !== '*' && l.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((l) => l.tag);
}

/** The UI locale for a request: the first supported `Accept-Language` entry, else English. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  return detectLocale(parseAcceptLanguage(header));
}
