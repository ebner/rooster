import type { i18n } from 'i18next';
import { type I18nOptions, initI18nWith, type Locale, namespaces } from './core.ts';

/*
 * Client-side catalog loading (10 §4): each locale is its own chunk, fetched on demand, so the
 * initial bundle carries one language instead of all of them.
 */

const loaders: Record<Locale, () => Promise<Record<string, unknown>>> = {
  en: () => import('./catalog-en.ts').then((m) => m.en),
  sv: () => import('./catalog-sv.ts').then((m) => m.sv),
};

/** Initialises `instance` with ICU and the catalog of `locale` only. */
export async function initLazyI18n(
  instance: i18n,
  locale: Locale,
  options: I18nOptions = {},
): Promise<i18n> {
  const catalog = await loaders[locale]();
  return initI18nWith(instance, locale, { [locale]: catalog as never }, options);
}

/** Makes sure every namespace of `locale` is loaded into `instance` (before `changeLanguage`). */
export async function ensureLocale(instance: i18n, locale: Locale): Promise<void> {
  if (namespaces.every((ns) => instance.hasResourceBundle(locale, ns))) return;
  const catalog = await loaders[locale]();
  for (const ns of namespaces) {
    instance.addResourceBundle(locale, ns, catalog[ns] as object, true, true);
  }
}
