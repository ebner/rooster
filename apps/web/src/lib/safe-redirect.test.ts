import { describe, expect, test } from 'vitest';
import { safeRedirectPath } from './safe-redirect';

describe('safeRedirectPath', () => {
  test('keeps same-origin paths with search and hash', () => {
    expect(safeRedirectPath('/o/x/my')).toBe('/o/x/my');
    expect(safeRedirectPath('/o/x/settings?tab=1#invites')).toBe('/o/x/settings?tab=1#invites');
    expect(safeRedirectPath(`${window.location.origin}/admin`)).toBe('/admin');
  });

  test.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '',
    undefined,
    42,
  ])('rejects %j', (value) => {
    expect(safeRedirectPath(value)).toBeUndefined();
  });
});
