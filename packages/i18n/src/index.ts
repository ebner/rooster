import i18next, { type InitOptions, type i18n, type Module, type Newable } from 'i18next';
import ICU from 'i18next-icu';
import enAdmin from '../locales/en/admin.json' with { type: 'json' };
import enAuth from '../locales/en/auth.json' with { type: 'json' };
import enCommon from '../locales/en/common.json' with { type: 'json' };
import enDev from '../locales/en/dev.json' with { type: 'json' };
import enSettings from '../locales/en/settings.json' with { type: 'json' };
import enShell from '../locales/en/shell.json' with { type: 'json' };
import svAdmin from '../locales/sv/admin.json' with { type: 'json' };
import svAuth from '../locales/sv/auth.json' with { type: 'json' };
import svCommon from '../locales/sv/common.json' with { type: 'json' };
import svDev from '../locales/sv/dev.json' with { type: 'json' };
import svSettings from '../locales/sv/settings.json' with { type: 'json' };
import svShell from '../locales/sv/shell.json' with { type: 'json' };

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
export const namespaces = ['common', 'dev', 'shell', 'auth', 'settings', 'admin'] as const;
export type Namespace = (typeof namespaces)[number];
export const defaultNamespace: Namespace = 'common';

export const resources = {
  en: {
    common: enCommon,
    dev: enDev,
    shell: enShell,
    auth: enAuth,
    settings: enSettings,
    admin: enAdmin,
  },
  sv: {
    common: svCommon,
    dev: svDev,
    shell: svShell,
    auth: svAuth,
    settings: svSettings,
    admin: svAdmin,
  },
} as const;

/** The English catalog shape; used for typed keys (`CustomTypeOptions['resources']`). */
export type Resources = (typeof resources)['en'];

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

function initOptions(locale: Locale): InitOptions {
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

/**
 * Initialises an existing i18next instance with the rooster catalogs and ICU
 * message format. Resources are bundled, so this completes synchronously; the
 * returned promise is for callers that prefer to await.
 */
export async function initI18n(
  instance: i18n,
  locale: Locale = defaultLocale,
  options: I18nOptions = {},
): Promise<i18n> {
  instance.use(ICU);
  for (const plugin of options.plugins ?? []) instance.use(plugin);
  await instance.init(initOptions(locale));
  return instance;
}

/** Creates a new, fully initialised, isolated i18next instance (synchronously usable). */
export function createI18n(locale: Locale = defaultLocale, options: I18nOptions = {}): i18n {
  const instance = i18next.createInstance();
  void initI18n(instance, locale, options);
  return instance;
}
