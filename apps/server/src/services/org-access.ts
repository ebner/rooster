import { isUuidv7 } from '@rooster/core/ids';
import { type Org, type OrgRole, PERSONAL_ORG_ALIAS, type TagColor } from '@rooster/core/schemas';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { member, organization, orgMemberPref } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import type { Tx } from './context.ts';

export type OrgRow = typeof organization.$inferSelect;

export interface Membership {
  org: OrgRow;
  role: OrgRole;
  position: string;
  collapsed: boolean;
}

export const notFound = (what = 'Organisation') =>
  new AppError('not_found', 404, `${what} not found.`);

/** Columns of `org` plus the member's role and sidebar prefs. */
const membershipColumns = {
  org: organization,
  role: member.role,
  position: orgMemberPref.position,
  collapsed: orgMemberPref.collapsed,
};

function refCondition(ref: string): SQL {
  if (ref === PERSONAL_ORG_ALIAS) return eq(organization.isPersonal, true);
  return isUuidv7(ref) ? eq(organization.id, ref) : eq(organization.slug, ref);
}

function toMembership(row: {
  org: OrgRow;
  role: OrgRole;
  position: string | null;
  collapsed: boolean | null;
}): Membership {
  return {
    org: row.org,
    role: row.role,
    position: row.position ?? '',
    collapsed: row.collapsed ?? false,
  };
}

/**
 * The actor's membership of the live org named by `ref` (an ID, a slug or `personal`).
 * Non-members get the same 404 as a missing org, so existence never leaks (04 §4.3).
 */
export function requireMembership(tx: Tx, userId: string, ref: string): Membership {
  const row = tx
    .select(membershipColumns)
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .leftJoin(
      orgMemberPref,
      and(eq(orgMemberPref.orgId, member.organizationId), eq(orgMemberPref.userId, userId)),
    )
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt), refCondition(ref)))
    .get();
  if (row === undefined) throw notFound();
  return toMembership(row);
}

/** Like `requireMembership`, plus the owner role (403 for plain members). */
export function requireOwner(tx: Tx, userId: string, ref: string): Membership {
  const membership = requireMembership(tx, userId, ref);
  if (membership.role !== 'owner') {
    throw new AppError('forbidden', 403, 'Only owners of this organisation can do that.');
  }
  return membership;
}

/** Every live org of the user, in sidebar order (`ORDER BY position, id`). */
export function listMemberships(tx: Tx, userId: string): Membership[] {
  return tx
    .select(membershipColumns)
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .leftJoin(
      orgMemberPref,
      and(eq(orgMemberPref.orgId, member.organizationId), eq(orgMemberPref.userId, userId)),
    )
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt)))
    .orderBy(orgMemberPref.position, organization.id)
    .all()
    .map(toMembership);
}

export function toOrgDto(m: Membership): Org {
  return {
    id: m.org.id,
    slug: m.org.slug,
    name: m.org.name,
    isPersonal: m.org.isPersonal,
    avatarEmoji: m.org.avatarEmoji,
    color: m.org.color as TagColor | null,
    role: m.role,
    position: m.position,
    collapsed: m.collapsed,
  };
}
