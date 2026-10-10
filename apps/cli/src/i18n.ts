import { AsyncLocalStorage } from 'node:async_hooks';
import { createI18n, detectLocale, isLocale, type Locale } from '@rooster/i18n';

export type { Locale };
export { isLocale };
export type Translate = (key: string, values?: Record<string, unknown>) => string;

const instances = new Map<Locale, Translate>();

/** A translator for the `cli` namespace (07 §4.3). */
export function translator(locale: Locale): Translate {
  let t = instances.get(locale);
  if (t === undefined) {
    const i18n = createI18n(locale);
    const fixed = i18n.getFixedT(locale, 'cli');
    t = (key, values) => fixed(key, values ?? {}) as string;
    instances.set(locale, t);
  }
  return t;
}

const shared = new Map<string, Translate>();

/**
 * A translator for another app's namespace whose sentences the CLI shows as they are, so a
 * rule or a reminder reads the same in the terminal as on the web (`dates:repeat.rule.*`).
 */
export function namespaceTranslator(locale: Locale, ns: 'dates'): Translate {
  const id = `${locale}:${ns}`;
  let t = shared.get(id);
  if (t === undefined) {
    const fixed = createI18n(locale).getFixedT(locale, ns);
    t = (key, values) => fixed(key, values ?? {}) as string;
    shared.set(id, t);
  }
  return t;
}

/** `$LC_ALL`, `$LC_MESSAGES`, then `$LANG` (`sv_SE.UTF-8` → `sv`); null when none is set. */
export function localeFromEnv(env: Readonly<Record<string, string | undefined>>): Locale | null {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const value = env[name];
    if (value === undefined || value === '' || value === 'C' || value === 'POSIX') continue;
    const primary = value.split(/[-_.@]/)[0]?.toLowerCase();
    return isLocale(primary) ? primary : detectLocale([value]);
  }
  return null;
}

/** 07 §4.3: the profile's locale, then the server user setting, then the environment. */
export function resolveLocale(
  profileLocale: string | undefined,
  serverLocale: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Locale {
  if (isLocale(profileLocale)) return profileLocale;
  if (isLocale(serverLocale)) return serverLocale;
  return localeFromEnv(env) ?? 'en';
}

const localeStore = new AsyncLocalStorage<{ locale: Locale }>();

/** Runs `fn` with `locale` as the language of `t()`. */
export function withLocale<T>(locale: Locale, fn: () => T): T {
  return localeStore.run({ locale }, fn);
}

/** Switches the language of the current run (after the server setting is known). */
export function setLocale(locale: Locale): void {
  const store = localeStore.getStore();
  if (store !== undefined) store.locale = locale;
}

export function currentLocale(): Locale {
  return localeStore.getStore()?.locale ?? 'en';
}

/** Translates a `cli` key in the language of the current run. */
export const t: Translate = (key, values) => translator(currentLocale())(key, values);
