import { describe, expect, test } from 'vitest';
import { formatDay, formatTimeAgo } from './format';

const now = Date.UTC(2026, 9, 5, 10, 0); // Mon 2026-10-05 12:00 in Stockholm
const day = 24 * 60 * 60 * 1000;
const en = {
  locale: 'en',
  timezone: 'Europe/Stockholm',
  dateFormat: 'MMM d',
  timeFormat: '24h',
} as const;

describe('formatDay', () => {
  test('uses the due-date labels in the viewer timezone', () => {
    expect(formatDay(now, en, now)).toBe('Today');
    expect(formatDay(now + day, en, now)).toBe('Tomorrow');
    expect(formatDay(now + 7 * day, en, now)).toBe('Oct 12');
    expect(formatDay(now + 7 * day, { ...en, dateFormat: 'd MMM' }, now)).toBe('12 Oct');
    expect(formatDay(now + 7 * day, { ...en, locale: 'sv' }, now)).toBe('12 okt');
  });
});

describe('formatTimeAgo', () => {
  test('relative phrases in the UI language', () => {
    expect(formatTimeAgo(now - 10_000, now, 'en', 'Just now')).toBe('Just now');
    expect(formatTimeAgo(now - 5 * 60_000, now, 'en', 'Just now')).toBe('5 minutes ago');
    expect(formatTimeAgo(now - day, now, 'en', 'Just now')).toBe('yesterday');
    expect(formatTimeAgo(now - 3 * 60 * 60_000, now, 'sv', 'Nyss')).toBe('för 3 timmar sedan');
  });
});
