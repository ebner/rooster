import {
  findOrgToken,
  matchOrgs,
  type OrgCandidate,
  type OrgTokenMatch,
} from '@rooster/core/dates';

/**
 * The org a title's `^org` token names (core `findOrgToken`: among several exact matches, such
 * as two orgs called "Work", the one whose slug it is). Slugs are unique, so every org has a
 * token that names it alone (`orgHandle`).
 */
export function resolveOrgToken(text: string, orgs: readonly OrgCandidate[]): OrgTokenMatch | null {
  return findOrgToken(text, orgs);
}

/**
 * The `^org` token that names `org` (ADR 0073 A4), the first that resolves back to it alone
 * (`resolveOrgToken`): `^Kestrel` (the first word of its name), else `^"Kestrel Lane"`, else its
 * slug, which is unique (two orgs can share a name).
 */
export function orgHandle(org: OrgCandidate, orgs: readonly OrgCandidate[]): string {
  const name = org.name.replace(/["\n]/g, '').trim();
  const first = name.split(/\s+/)[0] ?? '';
  const candidates = [
    ...(/^[^\s"^]\S*$/u.test(first) ? [`^${first}`] : []),
    `^"${name}"`,
    `^${org.slug}`,
  ];
  return (
    candidates.find((handle) => resolveOrgToken(handle, orgs)?.orgId === org.id) ?? `^${org.slug}`
  );
}

/** The `^query` autocomplete (ADR 0073 A4): the orgs it can mean, best first. */
export function suggestOrgs<T extends OrgCandidate>(query: string, orgs: readonly T[]): T[] {
  const byId = new Map(orgs.map((org) => [org.id, org]));
  return matchOrgs(query, orgs).flatMap((m) => {
    const org = byId.get(m.orgId);
    return org ? [org] : [];
  });
}
