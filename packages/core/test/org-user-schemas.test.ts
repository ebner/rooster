import { describe, expect, it } from 'vitest';
import {
  allowlistCreateSchema,
  DEFAULT_PREFS,
  inviteCreateSchema,
  isReservedSlug,
  isValidDomain,
  isValidSlug,
  isValidTimeZone,
  mePatchSchema,
  nameSchema,
  orgCreateSchema,
  resolvePrefs,
  slugCandidate,
  slugify,
  stripControlChars,
} from '../src/schemas.ts';

describe('slugs', () => {
  it.each([
    ['Northwind', 'northwind'],
    ['Café Åkerö', 'cafe-akero'],
    ['  Hello,   World!  ', 'hello-world'],
    ['Straße & Søn', 'strasse-son'],
    ['Ærø', 'aero'],
    ['---x---', null],
    ['🚀', null],
    ['a'.repeat(50), 'a'.repeat(39)],
    [`${'ab-'.repeat(13)}cd`, 'ab-'.repeat(13).slice(0, 38)],
  ])('slugify(%j) → %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it.each([
    ['ab', true],
    ['a', false],
    ['a-b-c', true],
    ['-ab', false],
    ['Ab', false],
    ['a'.repeat(39), true],
    ['a'.repeat(40), false],
    ['0192f3a0-0000-7000-8000-000000000001', false],
  ])('isValidSlug(%j) → %j', (slug, ok) => {
    expect(isValidSlug(slug)).toBe(ok);
  });

  it('reserves `personal`', () => {
    expect(isReservedSlug('personal')).toBe(true);
    expect(isReservedSlug('personal-1a2b3c4d')).toBe(false);
    expect(orgCreateSchema.safeParse({ name: 'X', slug: 'personal' }).success).toBe(false);
    expect(orgCreateSchema.safeParse({ name: 'X', slug: 'Bad' }).success).toBe(false);
  });

  it('numbers candidates within 39 characters', () => {
    expect(slugCandidate('team', 1)).toBe('team');
    expect(slugCandidate('team', 2)).toBe('team-2');
    const long = slugCandidate('a'.repeat(39), 12);
    expect(long).toBe(`${'a'.repeat(36)}-12`);
    expect(isValidSlug(long)).toBe(true);
    expect(slugCandidate(`${'a'.repeat(37)}-b`, 3)).toBe(`${'a'.repeat(37)}-3`);
  });
});

describe('names', () => {
  it('strips control characters and trims', () => {
    expect(stripControlChars('a\u0000b\nc\u007f')).toBe('abc');
    expect(nameSchema(5).parse('  a\tb  ')).toBe('ab');
    expect(nameSchema(5).safeParse(' \u0007 ').success).toBe(false);
    expect(nameSchema(5).safeParse('abcdef').success).toBe(false);
  });
});

describe('invites', () => {
  it('defaults the role and accepts both kinds', () => {
    expect(inviteCreateSchema.parse({})).toEqual({ role: 'member' });
    expect(inviteCreateSchema.parse({ email: 'a@b.test', role: 'owner' })).toEqual({
      email: 'a@b.test',
      role: 'owner',
    });
    expect(inviteCreateSchema.safeParse({ email: 'nope' }).success).toBe(false);
    expect(inviteCreateSchema.safeParse({ expiresInDays: 91 }).success).toBe(false);
  });
});

describe('timezones', () => {
  it.each([
    ['UTC', true],
    ['Europe/Stockholm', true],
    ['America/Argentina/Buenos_Aires', true],
    ['Etc/GMT+1', true],
    ['Mars/Olympus', false],
    ['+01:00', false],
    ['Stockholm', false],
    ['', false],
  ])('isValidTimeZone(%j) → %j', (tz, ok) => {
    expect(isValidTimeZone(tz)).toBe(ok);
  });

  it('validates PATCH /me', () => {
    expect(mePatchSchema.safeParse({ timezone: 'Europe/Stockholm', weekStart: 0 }).success).toBe(
      true,
    );
    expect(mePatchSchema.safeParse({ timezone: 'Nowhere/Land' }).success).toBe(false);
  });
});

describe('prefs', () => {
  it('fills defaults and keeps valid stored keys only', () => {
    expect(resolvePrefs({})).toEqual(DEFAULT_PREFS);
    expect(resolvePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(resolvePrefs([1])).toEqual(DEFAULT_PREFS);
    expect(
      resolvePrefs({ completeHideMs: 500, swipeLeft: 'bogus', unknown: 1, reminderTime: '09:30' }),
    ).toEqual({ ...DEFAULT_PREFS, completeHideMs: 500, reminderTime: '09:30' });
  });
});

describe('allowlist', () => {
  it('normalises domains and validates them', () => {
    expect(allowlistCreateSchema.parse({ kind: 'domain', value: ' Example.COM ' })).toEqual({
      kind: 'domain',
      value: 'example.com',
    });
    for (const bad of ['localhost', 'http://x.test', 'x..se', '-x.test', 'x.s']) {
      expect(isValidDomain(bad)).toBe(false);
    }
    expect(isValidDomain('sub.northwind.example')).toBe(true);
    expect(allowlistCreateSchema.safeParse({ kind: 'email', value: 'x' }).success).toBe(false);
  });
});
