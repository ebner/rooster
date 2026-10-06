import { detectLocale, isLocale, type Locale } from '@rooster/i18n/core';
import { ensureLocale, initLazyI18n } from '@rooster/i18n/lazy';
import i18next from 'i18next';
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

export const i18n = i18next.createInstance();

function syncDocumentLanguage(locale: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/**
 * Loads the active locale's catalog only (10 §4: the other language is a separate chunk);
 * `main.tsx` awaits this before the first render.
 */
export const i18nReady = initLazyI18n(i18n, initialLocale(), { plugins: [initReactI18next] }).then(
  (instance) => {
    syncDocumentLanguage(instance.language);
    instance.on('languageChanged', syncDocumentLanguage);
    return instance;
  },
);

/** Switches the UI language and remembers it on this device. */
export async function setLocale(locale: Locale): Promise<void> {
  try {
    globalThis.localStorage?.setItem(storageKey, locale);
  } catch {
    // Not persisting is acceptable: the language still changes for this session.
  }
  await ensureLocale(i18n, locale);
  await i18n.changeLanguage(locale);
}
