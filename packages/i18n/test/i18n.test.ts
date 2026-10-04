import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, test } from 'vitest';
import {
  createI18n,
  detectLocale,
  isLocale,
  namespaces,
  resources,
  supportedLocales,
} from '../src/index.ts';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

describe('detectLocale', () => {
  test.each([
    [['sv-SE', 'en-US'], 'sv'],
    [['en-GB'], 'en'],
    [['de-DE', 'sv'], 'sv'],
    [['SV_fi'], 'sv'],
    [['fr-FR', 'de'], 'en'],
    [[], 'en'],
  ])('%j → %s', (languages, expected) => {
    expect(detectLocale(languages)).toBe(expected);
  });

  test('isLocale narrows to supported locales only', () => {
    expect(isLocale('sv')).toBe(true);
    expect(isLocale('sv-SE')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('createI18n', () => {
  test('is usable synchronously and translates in the requested locale', () => {
    expect(createI18n('en').t('language.label')).toBe('Language');
    expect(createI18n('sv').t('language.label')).toBe('Språk');
  });

  test('formats ICU plurals', () => {
    const sv = createI18n('sv');
    expect(sv.t('sync.pending', { count: 3 })).toBe('Offline · 3 väntande');
    const en = createI18n('en');
    expect(en.t('dev:sample.taskCount', { count: 1 })).toBe('1 task');
    expect(en.t('dev:sample.taskCount', { count: 4 })).toBe('4 tasks');
    expect(sv.t('dev:sample.taskCount', { count: 4 })).toBe('4 uppgifter');
  });

  test('interpolates ICU arguments without HTML escaping', () => {
    expect(createI18n('en').t('task.complete', { title: 'Tom & Jerry' })).toBe(
      'Mark “Tom & Jerry” complete',
    );
  });

  test('instances are isolated', () => {
    const a = createI18n('en');
    const b = createI18n('en');
    void b.changeLanguage('sv');
    expect(a.language).toBe('en');
    expect(b.t('action.undo')).toBe('Ångra');
  });
});

describe('catalogs', () => {
  test.each(namespaces)('namespace %s has identical keys in every locale', (ns) => {
    const reference = [...flatten(resources.en[ns] as Tree).keys()].sort();
    for (const locale of supportedLocales) {
      expect([...flatten(resources[locale][ns] as Tree).keys()].sort()).toEqual(reference);
    }
  });

  test('every message is valid ICU and non-empty', () => {
    for (const locale of supportedLocales) {
      for (const ns of namespaces) {
        for (const [key, message] of flatten(resources[locale][ns] as Tree)) {
          expect(message.trim(), `${locale}/${ns}:${key}`).not.toBe('');
          expect(
            () => new IntlMessageFormat(message, locale),
            `${locale}/${ns}:${key}`,
          ).not.toThrow();
        }
      }
    }
  });
});
