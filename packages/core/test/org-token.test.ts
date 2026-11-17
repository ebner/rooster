import { describe, expect, it } from 'vitest';
import {
  findDateInTitle,
  findOrgToken,
  findReminderTokens,
  matchOrgs,
  orgTokenAt,
} from '../src/dates/index.ts';

const PERSONAL = '0190a000-0000-7000-8000-000000000001';
const KESTREL = '0190a000-0000-7000-8000-000000000002';
const KAYAK = '0190a000-0000-7000-8000-000000000003';
const orgs = [
  { id: PERSONAL, name: 'Personal', slug: 'personal' },
  { id: KESTREL, name: 'Kestrel Lane', slug: 'kestrel-lane' },
  { id: KAYAK, name: 'Kayak Club', slug: 'kayak' },
];

describe('^org token (ADR 0073 A4)', () => {
  it('resolves a unique name prefix, a later word, a slug and a quoted name', () => {
    expect(findOrgToken('Book the venue ^Kes', orgs)).toMatchObject({
      query: 'Kes',
      orgId: KESTREL,
      start: 15,
      end: 19,
    });
    expect(findOrgToken('x ^lane', orgs)?.orgId).toBe(KESTREL);
    expect(findOrgToken('x ^kestrel-lane', orgs)?.orgId).toBe(KESTREL);
    expect(findOrgToken('x ^"Kayak Club" tomorrow', orgs)).toMatchObject({
      query: 'Kayak Club',
      orgId: KAYAK,
    });
    expect(findOrgToken('x ^personal', orgs)?.orgId).toBe(PERSONAL);
  });

  it('stays unresolved when ambiguous or unknown', () => {
    expect(findOrgToken('x ^K', orgs)).toMatchObject({ query: 'K', orgId: null });
    expect(findOrgToken('x ^nope', orgs)?.orgId).toBeNull();
    expect(findOrgToken('no token', orgs)).toBeNull();
  });

  it('prefers an exact match over prefixes', () => {
    const more = [...orgs, { id: 'x', name: 'Kayak Juniors', slug: 'juniors' }];
    expect(findOrgToken('x ^kayak', more)?.orgId).toBe(KAYAK);
    expect(matchOrgs('kayak', more)).toEqual([
      { orgId: KAYAK, exact: true, slug: true },
      { orgId: 'x', exact: false, slug: false },
    ]);
    // Among exact matches the slug wins: a name may repeat, a slug can't.
    const twin = [...orgs, { id: 'y', name: 'Kayak', slug: 'kayak-2' }];
    expect(findOrgToken('x ^kayak', twin)?.orgId).toBe(KAYAK);
    expect(findOrgToken('x ^kayak-2', twin)?.orgId).toBe('y');
    const work = [
      { id: 'w1', name: 'Work', slug: 'work' },
      { id: 'w2', name: 'Work', slug: 'work-2' },
    ];
    expect(findOrgToken('x ^"Work"', work)?.orgId).toBe('w1');
    expect(findOrgToken('x ^work-2', work)?.orgId).toBe('w2');
    // Two exact name matches without a slug match stay ambiguous.
    const names = [
      { id: 'a', name: 'Team', slug: 'team-a' },
      { id: 'b', name: 'Team', slug: 'team-b' },
    ];
    expect(findOrgToken('x ^team', names)?.orgId).toBeNull();
  });

  it('works anywhere, needs whitespace before, skips escapes; a resolved one wins', () => {
    expect(findOrgToken('^Kes call the venue', orgs)?.orgId).toBe(KESTREL);
    expect(findOrgToken('2^3 maths', orgs)).toBeNull();
    expect(findOrgToken('Read `^Kes` notes', orgs)).toBeNull();
    expect(findOrgToken('x ^Kes ^nope', orgs)?.orgId).toBe(KESTREL);
    expect(findOrgToken('x ^nope ^Kay', orgs)?.orgId).toBe(KAYAK);
  });

  it('ignores case and accents', () => {
    expect(matchOrgs('PERSÖNAL', orgs)).toEqual([{ orgId: PERSONAL, exact: true, slug: true }]);
    expect(matchOrgs('', orgs).map((m) => m.orgId)).toEqual([PERSONAL, KESTREL, KAYAK]);
    expect(matchOrgs('club', orgs)).toEqual([{ orgId: KAYAK, exact: false, slug: false }]);
    expect(matchOrgs('kestrel-l', orgs)).toEqual([{ orgId: KESTREL, exact: false, slug: false }]);
  });

  it('may sit before a date phrase and reminder tokens, or after them', () => {
    const ctx = {
      today: '2026-11-17',
      weekStart: 1 as const,
      locale: 'en' as const,
      dateFormat: 'MMM d' as const,
    };
    expect(findDateInTitle('Call the venue fri ^Kes', ctx)?.text).toBe('fri');
    expect(findReminderTokens('Call fri 10:00 !1h ^Kes')).toHaveLength(1);
  });

  it('finds the token at the caret for autocomplete', () => {
    expect(orgTokenAt('Book ^Kes', 9)).toEqual({ start: 5, end: 9, query: 'Kes' });
    expect(orgTokenAt('Book ^Kes now', 7)).toEqual({ start: 5, end: 9, query: 'Kes' });
    expect(orgTokenAt('Book ^', 6)).toEqual({ start: 5, end: 6, query: '' });
    expect(orgTokenAt('Book ^"Kestrel La', 17)).toEqual({ start: 5, end: 17, query: 'Kestrel La' });
    expect(orgTokenAt('Book ^"Kestrel La" x', 10)).toEqual({
      start: 5,
      end: 18,
      query: 'Kestrel La',
    });
    expect(orgTokenAt('a^b', 3)).toBeNull();
  });
});
