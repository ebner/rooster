import { describe, expect, test } from 'vitest';
import { claimInstallToast, countVisit, installToastFromVisit, isIosSafari } from './install';
import { pushTargetPath } from './push-target';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('install prompts (02 §13.5)', () => {
  test('counts one visit per tab session and offers the toast once from the 3rd', () => {
    const local = memoryStorage();
    let visits = 0;
    for (let i = 0; i < installToastFromVisit; i += 1) {
      const session = memoryStorage();
      visits = countVisit(local, session);
      expect(countVisit(local, session)).toBe(visits);
      if (i < installToastFromVisit - 1) expect(claimInstallToast(visits, local)).toBe(false);
    }
    expect(visits).toBe(3);
    expect(claimInstallToast(visits, local)).toBe(true);
    expect(claimInstallToast(visits + 1, local)).toBe(false);
  });

  test('recognises iOS Safari only', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const chromeIos = iphone.replace('Version/18.0', 'CriOS/129.0');
    const ipad =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const android =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
    expect(isIosSafari(iphone, 5)).toBe(true);
    expect(isIosSafari(chromeIos, 5)).toBe(false);
    expect(isIosSafari(ipad, 5)).toBe(true);
    expect(isIosSafari(ipad, 0)).toBe(false);
    expect(isIosSafari(android, 5)).toBe(false);
  });
});

describe('notification click target (04 §6.3)', () => {
  const origin = 'https://rooster.example';
  test('opens the task, a same-origin url, or the root; never another origin', () => {
    expect(pushTargetPath({ org: 'acme', taskId: 't-1' }, origin)).toBe('/o/acme/t/t-1');
    expect(pushTargetPath({ url: '/o/acme/t/x?y=1' }, origin)).toBe('/o/acme/t/x?y=1');
    expect(pushTargetPath({ url: 'https://evil.example/o/a' }, origin)).toBe('/');
    expect(pushTargetPath({ url: '//evil.example/x', org: 'a', taskId: 'b' }, origin)).toBe(
      '/o/a/t/b',
    );
    expect(pushTargetPath({ org: '../x', taskId: 'y' }, origin)).toBe('/');
    expect(pushTargetPath(null, origin)).toBe('/');
  });
});
