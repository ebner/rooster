import i18next, { type i18n } from 'i18next';
import { en } from './catalog-en.ts';
import { sv } from './catalog-sv.ts';
import { defaultLocale, type I18nOptions, initI18nWith, type Locale } from './core.ts';

export * from './core.ts';

/** Every catalog, bundled. The web app loads one locale at a time instead (`lazy.ts`). */
export const resources = { en, sv } as const;

/** The English catalog shape; used for typed keys (`CustomTypeOptions['resources']`). */
export type Resources = (typeof resources)['en'];

/**
 * Initialises an existing i18next instance with the rooster catalogs and ICU
 * message format. Resources are bundled, so this completes synchronously; the
 * returned promise is for callers that prefer to await.
 */
export function initI18n(
  instance: i18n,
  locale: Locale = defaultLocale,
  options: I18nOptions = {},
): Promise<i18n> {
  return initI18nWith(instance, locale, resources, options);
}

/** Creates a new, fully initialised, isolated i18next instance (synchronously usable). */
export function createI18n(locale: Locale = defaultLocale, options: I18nOptions = {}): i18n {
  const instance = i18next.createInstance();
  void initI18n(instance, locale, options);
  return instance;
}
