import type { InitOptions, i18n, Module, Newable, Resource } from 'i18next';
import ICU from 'i18next-icu';

/*
 * The catalog-free half of @rooster/i18n: locales, namespaces and i18next setup. The web app
 * builds on this plus `lazy.ts`, so only the active locale's catalog is in its initial bundle
 * (10 §4); `index.ts` adds the statically bundled catalogs for the server, CLI and tests.
 */

/** UI languages (D-23). English is the fallback. */
export const supportedLocales = ['en', 'sv'] as const;
export type Locale = (typeof supportedLocales)[number];
export const defaultLocale: Locale = 'en';

/**
 * Catalog namespaces. `common` is the default; `dev` holds kitchen-sink copy; `shell`,
 * `auth`, `settings` and `admin` are the web app's screens.
 * Add a namespace by adding `locales/<locale>/<ns>.json` for every locale and
 * registering it here.
 */
export const namespaces = [
  'common',
  'dev',
  'shell',
  'auth',
  'settings',
  'admin',
  'dates',
  'list',
  'pane',
  'tags',
  'editor',
  'pwa',
  'mobile',
  'views',
  'palette',
  'people',
  'collab',
  'inbox',
  'mail',
  'cli',
  'tui',
  'attachments',
  'calendar',
] as const;
export type Namespace = (typeof namespaces)[number];
export const defaultNamespace: Namespace = 'common';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (supportedLocales as readonly string[]).includes(value);
}

/**
 * Picks the first supported locale from a preference list such as
 * `navigator.languages` (`['sv-SE', 'en']` → `'sv'`). Falls back to English.
 */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return defaultLocale;
}

type I18nPlugin = Module | Newable<Module>;

export interface I18nOptions {
  /** Extra i18next plugins, e.g. `initReactI18next`. ICU is always installed. */
  plugins?: readonly I18nPlugin[];
}

function initOptions(locale: Locale, resources: Resource): InitOptions {
  return {
    lng: locale,
    fallbackLng: defaultLocale,
    supportedLngs: [...supportedLocales],
    load: 'languageOnly',
    ns: [...namespaces],
    defaultNS: defaultNamespace,
    resources,
    initAsync: false,
    returnNull: false,
    // React (and the CLI's terminal output) escape on their own; emails escape in templates.
    interpolation: { escapeValue: false },
  };
}

/** Initialises `instance` with ICU message format and the given catalogs (synchronously). */
export async function initI18nWith(
  instance: i18n,
  locale: Locale,
  resources: Resource,
  options: I18nOptions = {},
): Promise<i18n> {
  instance.use(ICU);
  for (const plugin of options.plugins ?? []) instance.use(plugin);
  await instance.init(initOptions(locale, resources));
  return instance;
}
