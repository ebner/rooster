import { createI18n, detectLocale, isLocale, type Locale } from '@rooster/i18n';
import { initReactI18next } from 'react-i18next';

const storageKey = 'rooster.locale';

function readStoredLocale(): Locale | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    return isLocale(stored) ? stored : undefined;
  } catch {
    // Storage can be unavailable (privacy modes, sandboxed iframes); fall back to the browser.
    return undefined;
  }
}

function browserLanguages(): readonly string[] {
  const nav = globalThis.navigator;
  if (!nav) return [];
  return nav.languages?.length ? nav.languages : [nav.language];
}

/** The stored choice wins; otherwise the browser preference (04 §8). */
export function initialLocale(): Locale {
  return readStoredLocale() ?? detectLocale(browserLanguages());
}

export const i18n = createI18n(initialLocale(), { plugins: [initReactI18next] });

function syncDocumentLanguage(locale: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

/** Switches the UI language and remembers it on this device. */
export async function setLocale(locale: Locale): Promise<void> {
  try {
    globalThis.localStorage?.setItem(storageKey, locale);
  } catch {
    // Not persisting is acceptable: the language still changes for this session.
  }
  await i18n.changeLanguage(locale);
}
