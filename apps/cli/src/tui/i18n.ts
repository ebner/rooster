import { createI18n, type Locale } from '@rooster/i18n';

export type TuiTranslate = (key: string, values?: Record<string, unknown>) => string;

const cache = new Map<string, TuiTranslate>();

function translator(locale: Locale, ns: 'tui' | 'collab'): TuiTranslate {
  const id = `${locale}:${ns}`;
  let t = cache.get(id);
  if (t === undefined) {
    const fixed = createI18n(locale).getFixedT(locale, ns);
    t = (key, values) => fixed(key, values ?? {}) as string;
    cache.set(id, t);
  }
  return t;
}

/** A translator for the `tui` namespace (ADR 0042 §9), like `cli` in `../i18n.ts`. */
export function tuiTranslator(locale: Locale): TuiTranslate {
  return translator(locale, 'tui');
}

/** The web's activity sentences (`collab:activity.*`), so the feed reads the same everywhere. */
export function collabTranslator(locale: Locale): TuiTranslate {
  return translator(locale, 'collab');
}
