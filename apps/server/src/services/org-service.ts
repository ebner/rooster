import { uuidv7 } from '@rooster/core/ids';
import { keyBetween } from '@rooster/core/ordering';
import {
  INVITE_DEFAULT_EXPIRY_DAYS,
  type Invite,
  type InviteCreate,
  type InviteCreated,
  type InvitePreview,
  isReservedSlug,
  type Member,
  type Org,
  type OrgCreate,
  type OrgPatch,
  type OrgRole,
  slugCandidate,
  slugify,
  type TagColor,
} from '@rooster/core/schemas';
import { isLocale, type Locale } from '@rooster/i18n';
import { and, asc, desc, eq, gt, isNull, max, ne, or, sql } from 'drizzle-orm';
import {
  invitation,
  inviteLink,
  member,
  organization,
  orgMemberPref,
  user,
} from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { serverText } from '../lib/i18n.ts';
import { hashToken, randomToken } from '../lib/tokens.ts';
import { type Actor, immediate, type ServiceDeps, type Tx } from './context.ts';
import { createDefaultGroups, deleteMemberGroups } from './group-bootstrap.ts';
import {
  consumeInvite,
  invalidReason,
  inviteRole,
  type ResolvedInvite,
  resolveInvite,
} from './invite-store.ts';
import { emailInviteToken } from './invite-tokens.ts';
import {
  listMemberships,
  type Membership,
  notFound,
  type OrgRow,
  requireMembership,
  requireOwner,
  toOrgDto,
} from './org-access.ts';

const DAY_MS = 86_400_000;
const MAX_SLUG_ATTEMPTS = 1000;

/**
 * Runs inside the member-removal transaction (05 §4.2) before the member's groups, prefs
 * and membership are deleted. Phase 2 registers the task unassignment and placement
 * reconciliation here.
 */
export type MemberRemovalStep = (tx: Tx, input: { orgId: string; userId: string }) => void;

export interface OrgServiceOptions {
  memberRemovalSteps?: readonly MemberRemovalStep[];
}

const personalOrgConflict = () =>
  new AppError('personal_org', 409, 'The personal organisation cannot be shared or changed.');

const inviteNotFound = () => new AppError('not_found', 404, 'Invite not found.');

function userLocale(tx: Tx, userId: string): Locale {
  const row = tx.select({ locale: user.locale }).from(user).where(eq(user.id, userId)).get();
  return row !== undefined && isLocale(row.locale) ? row.locale : 'en';
}

/** True when a live org already uses `slug` (optionally ignoring one org). */
function slugTaken(tx: Tx, slug: string, exceptOrgId?: string): boolean {
  const row = tx
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        eq(organization.slug, slug),
        isNull(organization.deletedAt),
        exceptOrgId === undefined ? undefined : ne(organization.id, exceptOrgId),
      ),
    )
    .get();
  return row !== undefined;
}

function uniqueSlug(tx: Tx, base: string): string {
  for (let n = 1; n <= MAX_SLUG_ATTEMPTS; n++) {
    const candidate = slugCandidate(base, n);
    if (!isReservedSlug(candidate) && !slugTaken(tx, candidate)) return candidate;
  }
  throw new AppError('slug_taken', 409, 'Could not find a free slug; choose one explicitly.');
}

/** Sidebar key for a newly joined org: after the user's last org. */
function nextPrefPosition(tx: Tx, userId: string): string {
  const row = tx
    .select({ last: max(orgMemberPref.position) })
    .from(orgMemberPref)
    .where(eq(orgMemberPref.userId, userId))
    .get();
  return keyBetween(row?.last ?? null, null);
}

function ownerCount(tx: Tx, orgId: string): number {
  const row = tx
    .select({ n: sql<number>`count(*)` })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, 'owner')))
    .get();
  return row?.n ?? 0;
}

function findMember(tx: Tx, orgId: string, userId: string) {
  return tx
    .select({
      userId: member.userId,
      role: member.role,
      joinedAt: member.createdAt,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .get();
}

function toInvitePreview(invite: ResolvedInvite, now: number): InvitePreview {
  const reason = invalidReason(invite, now);
  return {
    kind: invite.kind,
    orgName: invite.org.name,
    orgAvatarEmoji: invite.org.avatarEmoji,
    orgColor: invite.org.color as TagColor | null,
    inviterName: invite.inviterName,
    role: inviteRole(invite),
    email: invite.kind === 'email' ? invite.row.email : null,
    expiresAt: invite.row.expiresAt,
    valid: reason === null,
    reason,
  };
}

/** Organisations, members and invites (04 §4.2). All authorisation happens here. */
export class OrgService {
  private readonly removalSteps: readonly MemberRemovalStep[];

  constructor(
    private readonly deps: ServiceDeps,
    options: OrgServiceOptions = {},
  ) {
    this.removalSteps = options.memberRemovalSteps ?? [];
  }

  private now(): number {
    return this.deps.clock();
  }

  private inviteUrl(token: string): string {
    return `${this.deps.config.baseUrl}/invite/${token}`;
  }

  /**
   * Adds the user to the org with its own Inbox, default groups and sidebar entry. The
   * caller has checked that they are not a member yet.
   */
  private join(tx: Tx, org: OrgRow, userId: string, role: OrgRole): Membership {
    const now = this.now();
    tx.insert(member)
      .values({ id: uuidv7(), organizationId: org.id, userId, role, createdAt: now })
      .run();
    createDefaultGroups(tx, { orgId: org.id, userId, locale: userLocale(tx, userId), now });
    const position = nextPrefPosition(tx, userId);
    tx.insert(orgMemberPref).values({ userId, orgId: org.id, position, collapsed: false }).run();
    return { org, role, position, collapsed: false };
  }

  // --- personal org ---------------------------------------------------------------------

  /**
   * Creates the user's personal org with its owner membership, Inbox, default groups and
   * sidebar entry (FR-AUTH-3, WP 1.2). Idempotent; `locale` defaults to the user's.
   */
  bootstrapPersonalOrg(userId: string, locale?: Locale): Org {
    return immediate(this.deps.db, (tx) => {
      const existing = listMemberships(tx, userId).find((m) => m.org.isPersonal);
      if (existing !== undefined) return toOrgDto(existing);
      const name = serverText(locale ?? userLocale(tx, userId), 'org.personal');
      // 05 §2 asks for the first 8 hex characters of the user ID, but those are the UUIDv7
      // timestamp and collide for users created within ~65 s; the random tail does not.
      const base = `personal-${userId.replace(/-/g, '').slice(-8)}`;
      const org: OrgRow = {
        id: uuidv7(),
        name,
        slug: uniqueSlug(tx, base),
        logo: null,
        metadata: null,
        createdAt: this.now(),
        isPersonal: true,
        avatarEmoji: null,
        color: null,
        taskSeq: 0,
        deletedAt: null,
      };
      tx.insert(organization).values(org).run();
      return toOrgDto(this.join(tx, org, userId, 'owner'));
    });
  }

  // --- orgs -----------------------------------------------------------------------------

  list(actor: Actor): Org[] {
    return immediate(this.deps.db, (tx) => listMemberships(tx, actor.userId).map(toOrgDto));
  }

  get(actor: Actor, ref: string): Org {
    return immediate(this.deps.db, (tx) => toOrgDto(requireMembership(tx, actor.userId, ref)));
  }

  create(actor: Actor, input: OrgCreate): Org {
    return immediate(this.deps.db, (tx) => {
      let slug: string;
      if (input.slug !== undefined) {
        if (slugTaken(tx, input.slug)) throw new AppError('slug_taken', 409, 'Slug in use.');
        slug = input.slug;
      } else {
        slug = uniqueSlug(tx, slugify(input.name) ?? 'org');
      }
      const org: OrgRow = {
        id: uuidv7(),
        name: input.name,
        slug,
        logo: null,
        metadata: null,
        createdAt: this.now(),
        isPersonal: false,
        avatarEmoji: input.avatarEmoji ?? null,
        color: input.color ?? null,
        taskSeq: 0,
        deletedAt: null,
      };
      tx.insert(organization).values(org).run();
      return toOrgDto(this.join(tx, org, actor.userId, 'owner'));
    });
  }

  update(actor: Actor, ref: string, patch: OrgPatch): Org {
    return immediate(this.deps.db, (tx) => {
      const membership = requireOwner(tx, actor.userId, ref);
      const { org } = membership;
      if (org.isPersonal && (patch.name !== undefined || patch.slug !== undefined)) {
        throw personalOrgConflict();
      }
      if (
        patch.slug !== undefined &&
        patch.slug !== org.slug &&
        slugTaken(tx, patch.slug, org.id)
      ) {
        throw new AppError('slug_taken', 409, 'Slug in use.');
      }
      const changes: Partial<OrgRow> = {};
      if (patch.name !== undefined) changes.name = patch.name;
      if (patch.slug !== undefined) changes.slug = patch.slug;
      if (patch.avatarEmoji !== undefined) changes.avatarEmoji = patch.avatarEmoji;
      if (patch.color !== undefined) changes.color = patch.color;
      if (Object.keys(changes).length > 0) {
        tx.update(organization).set(changes).where(eq(organization.id, org.id)).run();
      }
      return toOrgDto({ ...membership, org: { ...org, ...changes } });
    });
  }

  /** Soft delete (FR-ORG-4): the org disappears for every member; its slug becomes free. */
  remove(actor: Actor, ref: string, confirmName: string): void {
    immediate(this.deps.db, (tx) => {
      const { org } = requireOwner(tx, actor.userId, ref);
      if (org.isPersonal) throw personalOrgConflict();
      if (confirmName !== org.name) {
        throw new AppError(
          'confirm_name_mismatch',
          422,
          'Type the organisation name exactly to delete it.',
        );
      }
      tx.update(organization)
        .set({ deletedAt: this.now() })
        .where(eq(organization.id, org.id))
        .run();
    });
  }

  // --- members --------------------------------------------------------------------------

  listMembers(actor: Actor, ref: string): Member[] {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, ref);
      return tx
        .select({
          userId: member.userId,
          role: member.role,
          joinedAt: member.createdAt,
          name: user.name,
          email: user.email,
          image: user.image,
        })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, org.id))
        .orderBy(asc(member.createdAt), asc(member.id))
        .all();
    });
  }

  /** Owner only. The last owner cannot be demoted (FR-ORG-5). */
  setRole(actor: Actor, ref: string, userId: string, role: OrgRole): Member {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireOwner(tx, actor.userId, ref);
      if (org.isPersonal) throw personalOrgConflict();
      const target = findMember(tx, org.id, userId);
      if (target === undefined) throw notFound('Member');
      if (target.role === 'owner' && role !== 'owner' && ownerCount(tx, org.id) <= 1) {
        throw new AppError('last_owner', 409, 'An organisation needs at least one owner.');
      }
      tx.update(member)
        .set({ role })
        .where(and(eq(member.organizationId, org.id), eq(member.userId, userId)))
        .run();
      return { ...target, role };
    });
  }

  /**
   * An owner removes a member, or a member leaves (`userId` is the actor). Runs the
   * member-removal invariant (05 §4.2). The last owner cannot leave (FR-ORG-5).
   */
  removeMember(actor: Actor, ref: string, userId: string): void {
    immediate(this.deps.db, (tx) => {
      const membership = requireMembership(tx, actor.userId, ref);
      const { org } = membership;
      if (org.isPersonal) throw personalOrgConflict();
      if (userId !== actor.userId && membership.role !== 'owner') {
        throw new AppError('forbidden', 403, 'Only owners can remove other members.');
      }
      const target = findMember(tx, org.id, userId);
      if (target === undefined) throw notFound('Member');
      if (target.role === 'owner' && ownerCount(tx, org.id) <= 1) {
        throw new AppError('last_owner', 409, 'An organisation needs at least one owner.');
      }
      const scope = { orgId: org.id, userId };
      for (const step of this.removalSteps) step(tx, scope);
      deleteMemberGroups(tx, scope);
      tx.delete(orgMemberPref)
        .where(and(eq(orgMemberPref.orgId, org.id), eq(orgMemberPref.userId, userId)))
        .run();
      tx.delete(member)
        .where(and(eq(member.organizationId, org.id), eq(member.userId, userId)))
        .run();
    });
  }

  // --- invites --------------------------------------------------------------------------

  /** Open invites of both kinds, newest first. Owner only. */
  listInvites(actor: Actor, ref: string): Invite[] {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireOwner(tx, actor.userId, ref);
      const now = this.now();
      const emails: Invite[] = tx
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, org.id),
            eq(invitation.status, 'pending'),
            gt(invitation.expiresAt, now),
          ),
        )
        .all()
        .map((row) => ({
          id: row.id,
          kind: 'email',
          email: row.email,
          role: row.role,
          multiUse: false,
          uses: 0,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          url: this.inviteUrl(emailInviteToken(this.deps.config.authSecret, row.id)),
        }));
      const links: Invite[] = tx
        .select()
        .from(inviteLink)
        .where(
          and(
            eq(inviteLink.orgId, org.id),
            isNull(inviteLink.revokedAt),
            gt(inviteLink.expiresAt, now),
            or(eq(inviteLink.multiUse, true), eq(inviteLink.uses, 0)),
          ),
        )
        .orderBy(desc(inviteLink.createdAt))
        .all()
        .map((row) => ({
          id: row.id,
          kind: 'link',
          email: null,
          role: row.role,
          multiUse: row.multiUse,
          uses: row.uses,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          url: null,
        }));
      return [...emails, ...links].sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  /** An email invite (with `email`) or a link invite. Owner only; never for a personal org. */
  createInvite(actor: Actor, ref: string, input: InviteCreate): InviteCreated {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireOwner(tx, actor.userId, ref);
      if (org.isPersonal) throw personalOrgConflict();
      const now = this.now();
      const expiresAt = now + (input.expiresInDays ?? INVITE_DEFAULT_EXPIRY_DAYS) * DAY_MS;
      const id = uuidv7();
      if (input.email !== undefined) {
        if (input.multiUse === true) {
          throw new AppError('validation_failed', 422, 'Email invites are single-use.', [
            { path: 'multiUse', message: 'Not allowed together with email' },
          ]);
        }
        const email = input.email.toLowerCase();
        const existing = tx
          .select({ id: member.id })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(and(eq(member.organizationId, org.id), eq(user.email, email)))
          .get();
        if (existing !== undefined) {
          throw new AppError('already_member', 409, 'That person is already a member.');
        }
        // A new invite replaces any open one for the same address.
        tx.update(invitation)
          .set({ status: 'canceled' })
          .where(
            and(
              eq(invitation.organizationId, org.id),
              eq(invitation.email, email),
              eq(invitation.status, 'pending'),
            ),
          )
          .run();
        tx.insert(invitation)
          .values({
            id,
            organizationId: org.id,
            email,
            role: input.role,
            status: 'pending',
            expiresAt,
            inviterId: actor.userId,
            createdAt: now,
          })
          .run();
        const token = emailInviteToken(this.deps.config.authSecret, id);
        return { id, kind: 'email', url: this.inviteUrl(token), expiresAt };
      }
      const token = randomToken();
      tx.insert(inviteLink)
        .values({
          id,
          orgId: org.id,
          tokenHash: hashToken(token),
          role: input.role,
          multiUse: input.multiUse ?? false,
          uses: 0,
          createdBy: actor.userId,
          expiresAt,
          revokedAt: null,
          createdAt: now,
        })
        .run();
      return { id, kind: 'link', url: this.inviteUrl(token), expiresAt };
    });
  }

  /** Revokes an invite of either kind. Owner only. */
  revokeInvite(actor: Actor, ref: string, inviteId: string): void {
    immediate(this.deps.db, (tx) => {
      const { org } = requireOwner(tx, actor.userId, ref);
      const email = tx
        .update(invitation)
        .set({ status: 'canceled' })
        .where(
          and(
            eq(invitation.id, inviteId),
            eq(invitation.organizationId, org.id),
            eq(invitation.status, 'pending'),
          ),
        )
        .run();
      if (email.changes > 0) return;
      const link = tx
        .update(inviteLink)
        .set({ revokedAt: this.now() })
        .where(
          and(
            eq(inviteLink.id, inviteId),
            eq(inviteLink.orgId, org.id),
            isNull(inviteLink.revokedAt),
          ),
        )
        .run();
      if (link.changes === 0) throw inviteNotFound();
    });
  }

  /** Public preview for the `/invite/:token` page. Unknown or forged tokens get a 404. */
  previewInvite(token: string): InvitePreview {
    return immediate(this.deps.db, (tx) => {
      const invite = resolveInvite(tx, this.deps.config.authSecret, token);
      if (invite === null) throw inviteNotFound();
      return toInvitePreview(invite, this.now());
    });
  }

  /**
   * Validates a token before the invite cookie is set for sign-in (04 §4.4). Throws
   * `410 invite_invalid` for an invite that can no longer be used.
   */
  claimInvite(token: string): InvitePreview {
    const preview = this.previewInvite(token);
    if (!preview.valid) {
      throw new AppError(
        'invite_invalid',
        410,
        `This invite can no longer be used (${preview.reason}).`,
      );
    }
    return preview;
  }

  /** A signed-in user accepts an invite. Accepting an org one already belongs to is a no-op. */
  acceptInvite(actor: Actor, token: string): Org {
    return immediate(this.deps.db, (tx) => this.accept(tx, actor.userId, actor.email, token));
  }

  /**
   * Sign-in through a claimed invite accepts it automatically. Never throws: a stale cookie
   * must not break sign-in. Returns the joined org, or `null` when nothing happened.
   */
  acceptInviteOnSignIn(userId: string, token: string): Org | null {
    try {
      return immediate(this.deps.db, (tx) => {
        const row = tx.select({ email: user.email }).from(user).where(eq(user.id, userId)).get();
        if (row === undefined) return null;
        return this.accept(tx, userId, row.email, token);
      });
    } catch (err) {
      this.deps.logger.info({ err, userId }, 'invite not accepted at sign-in');
      return null;
    }
  }

  private accept(tx: Tx, userId: string, email: string, token: string): Org {
    const invite = resolveInvite(tx, this.deps.config.authSecret, token);
    if (invite === null) throw inviteNotFound();
    const reason = invalidReason(invite, this.now());
    if (reason !== null) {
      throw new AppError('invite_invalid', 410, `This invite can no longer be used (${reason}).`);
    }
    if (invite.kind === 'email' && invite.row.email !== email.toLowerCase()) {
      throw new AppError(
        'invite_email_mismatch',
        403,
        'This invite was sent to a different email address.',
      );
    }
    const existing = listMemberships(tx, userId).find((m) => m.org.id === invite.org.id);
    if (existing !== undefined) {
      if (invite.kind === 'email') consumeInvite(tx, invite);
      return toOrgDto(existing);
    }
    const joined = this.join(tx, invite.org, userId, inviteRole(invite));
    consumeInvite(tx, invite);
    return toOrgDto(joined);
  }

  /**
   * Sign-in rule 5 (04 §4.4): the carried invite token is a valid link invite, or a valid
   * email invite for this very address.
   */
  inviteAdmits(token: string, email: string): boolean {
    return immediate(this.deps.db, (tx) => {
      const invite = resolveInvite(tx, this.deps.config.authSecret, token);
      if (invite === null || invalidReason(invite, this.now()) !== null) return false;
      return invite.kind === 'link' || invite.row.email === email.toLowerCase();
    });
  }
}
