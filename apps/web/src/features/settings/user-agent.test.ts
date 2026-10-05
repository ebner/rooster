import { describe, expect, test } from 'vitest';
import { describeUserAgent } from './user-agent';

describe('describeUserAgent', () => {
  test.each([
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'Linux', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS', kind: 'mobile' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
      { browser: 'Firefox', os: 'Windows', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      { browser: 'Edge', os: 'macOS', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android', kind: 'mobile' },
    ],
  ])('%s', (ua, expected) => {
    expect(describeUserAgent(ua)).toEqual(expected);
  });

  test('unknown agents still describe a device', () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null, kind: 'desktop' });
  });
});
