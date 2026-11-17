import { matchOrgs, type OrgCandidate } from '@rooster/core/dates';

/**
 * The `^org` token that names `org` (ADR 0073 A4): `^Kestrel` when the first word of its name
 * names only that org, else `^"Kestrel Lane"`.
 */
export function orgHandle(org: OrgCandidate, orgs: readonly OrgCandidate[]): string {
  const first = org.name.trim().split(/\s+/)[0] ?? '';
  const matches = matchOrgs(first, orgs);
  if (/^[^\s"^]\S*$/u.test(first) && matches.length === 1 && matches[0]?.orgId === org.id) {
    return `^${first}`;
  }
  return `^"${org.name.replace(/["\n]/g, '').trim()}"`;
}

/** The `^query` autocomplete (ADR 0073 A4): the orgs it can mean, best first. */
export function suggestOrgs<T extends OrgCandidate>(query: string, orgs: readonly T[]): T[] {
  const byId = new Map(orgs.map((org) => [org.id, org]));
  return matchOrgs(query, orgs).flatMap((m) => {
    const org = byId.get(m.orgId);
    return org ? [org] : [];
  });
}
