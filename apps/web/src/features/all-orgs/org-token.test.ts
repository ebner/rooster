import { describe, expect, test } from 'vitest';
import { orgHandle, resolveOrgToken } from './org-token';

/** ADR 0073 A4: the `^org` the autocomplete inserts names the picked org, and only it. */

const org = (id: string, name: string, slug: string) => ({ id, name, slug });

describe('orgHandle', () => {
  test('the first word when it names only that org, else the quoted name', () => {
    const orgs = [org('1', 'Kestrel Lane', 'kestrel-lane'), org('2', 'Book club', 'book-club')];
    expect(orgHandle(orgs[0] as never, orgs)).toBe('^Kestrel');
    const clash = [org('1', 'Work', 'work'), org('2', 'Work club', 'work-club')];
    expect(orgHandle(clash[1] as never, clash)).toBe('^"Work club"');
  });

  test('two orgs with the same name: each gets its slug, which resolves back to it', () => {
    const orgs = [org('1', 'Work', 'work'), org('2', 'Work', 'work-2'), org('3', 'Home', 'home')];
    for (const picked of orgs.slice(0, 2)) {
      const handle = orgHandle(picked, orgs);
      expect(resolveOrgToken(`Plan it ${handle}`, orgs)?.orgId).toBe(picked.id);
    }
    expect(orgHandle(orgs[1] as never, orgs)).toBe('^work-2');
  });
});
