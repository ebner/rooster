import type { InviteInvalidReason, InviteKind, OrgRole } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { invitation, inviteLink, organization, user } from '../db/schema/index.ts';
import type { Tx } from './context.ts';
import { parseInviteToken } from './invite-tokens.ts';
import type { OrgRow } from './org-access.ts';

type InvitationRow = typeof invitation.$inferSelect;
type InviteLinkRow = typeof inviteLink.$inferSelect;

/** An invite of either kind, found by its URL token, with its org and inviter. */
export type ResolvedInvite = {
  org: OrgRow;
  inviterName: string | null;
} & (
  | { kind: Extract<InviteKind, 'email'>; row: InvitationRow }
  | { kind: Extract<InviteKind, 'link'>; row: InviteLinkRow }
);

export function resolveInvite(tx: Tx, secret: string, token: string): ResolvedInvite | null {
  const parsed = parseInviteToken(secret, token);
  if (parsed === null) return null;
  if (parsed.kind === 'email') {
    const found = tx
      .select({ row: invitation, org: organization, inviterName: user.name })
      .from(invitation)
      .innerJoin(organization, eq(organization.id, invitation.organizationId))
      .leftJoin(user, eq(user.id, invitation.inviterId))
      .where(eq(invitation.id, parsed.id))
      .get();
    return found === undefined ? null : { kind: 'email', ...found };
  }
  const found = tx
    .select({ row: inviteLink, org: organization, inviterName: user.name })
    .from(inviteLink)
    .innerJoin(organization, eq(organization.id, inviteLink.orgId))
    .leftJoin(user, eq(user.id, inviteLink.createdBy))
    .where(eq(inviteLink.tokenHash, parsed.tokenHash))
    .get();
  return found === undefined ? null : { kind: 'link', ...found };
}

/** Why the invite can no longer be used, or `null` while it is valid. */
export function invalidReason(invite: ResolvedInvite, now: number): InviteInvalidReason | null {
  if (invite.org.deletedAt !== null) return 'org_deleted';
  if (invite.kind === 'email') {
    const { status } = invite.row;
    if (status === 'canceled' || status === 'rejected') return 'revoked';
    if (status === 'accepted') return 'used';
  } else {
    if (invite.row.revokedAt !== null) return 'revoked';
    if (!invite.row.multiUse && invite.row.uses > 0) return 'used';
  }
  if (invite.row.expiresAt <= now) return 'expired';
  return null;
}

export function inviteRole(invite: ResolvedInvite): OrgRole {
  return invite.row.role;
}

/** Records one use: an email invite becomes `accepted`; a link invite counts the use. */
export function consumeInvite(tx: Tx, invite: ResolvedInvite): void {
  if (invite.kind === 'email') {
    tx.update(invitation).set({ status: 'accepted' }).where(eq(invitation.id, invite.row.id)).run();
  } else {
    tx.update(inviteLink)
      .set({ uses: invite.row.uses + 1 })
      .where(eq(inviteLink.id, invite.row.id))
      .run();
  }
}
