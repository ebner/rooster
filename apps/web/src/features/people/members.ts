import { useMemo } from 'react';
import { useOrgMembers } from '../../data/orgs';
import type { OrgMember } from '../../data/types';

/** What the people UI needs of a member (an `OrgMember`, or a fixture). */
export type Person = Pick<OrgMember, 'userId' | 'name' | 'email' | 'image'>;

/** Names compare like the rest of the UI: case- and accent-insensitive, numbers natural. */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Me first, then everyone else alphabetically by name (02 §11: the order of Everyone's
 * sections, and of the assignee picker).
 */
export function sortMembers<T extends Person>(members: readonly T[], meId: string): T[] {
  return [...members].sort((a, b) => {
    if (a.userId === meId) return -1;
    if (b.userId === meId) return 1;
    return collator.compare(a.name, b.name) || collator.compare(a.email, b.email);
  });
}

export interface MemberOption<T extends Person = Person> {
  /** `null` is "Unassigned". */
  userId: string | null;
  member: T | null;
}

/**
 * The picker's choices for `query` (02 §6 A / Tab+A): Unassigned, then me, then the others
 * alphabetically. A query keeps the members whose name, any word of it, or e-mail starts with
 * it (case-insensitive), then those containing it; Unassigned stays while its label matches.
 */
export function memberOptions<T extends Person>(
  members: readonly T[],
  meId: string,
  query: string,
  unassignedLabel: string,
): MemberOption<T>[] {
  const sorted = sortMembers(members, meId);
  const q = query.trim().toLocaleLowerCase();
  const unassigned: MemberOption<T> = { userId: null, member: null };
  if (q === '') {
    return [unassigned, ...sorted.map((member) => ({ userId: member.userId, member }))];
  }
  const starts: T[] = [];
  const contains: T[] = [];
  for (const member of sorted) {
    const name = member.name.toLocaleLowerCase();
    const email = member.email.toLocaleLowerCase();
    if (
      name.startsWith(q) ||
      email.startsWith(q) ||
      name.split(/\s+/).some((w) => w.startsWith(q))
    ) {
      starts.push(member);
    } else if (name.includes(q) || email.includes(q)) contains.push(member);
  }
  const options = [...starts, ...contains].map((member) => ({ userId: member.userId, member }));
  return unassignedLabel.toLocaleLowerCase().includes(q) ? [...options, unassigned] : options;
}

/** The org's members by user ID (empty while loading). */
export function useMemberMap(orgId: string | undefined): ReadonlyMap<string, OrgMember> {
  const members = useOrgMembers(orgId).data;
  return useMemo(() => new Map((members ?? []).map((m) => [m.userId, m])), [members]);
}

/** The org's members, me first then alphabetical (empty while loading). */
export function useSortedMembers(orgId: string | undefined, meId: string): OrgMember[] {
  const members = useOrgMembers(orgId).data;
  return useMemo(() => sortMembers(members ?? [], meId), [members, meId]);
}
