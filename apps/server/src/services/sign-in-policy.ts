import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { allowlistEntry, invitation, member, organization, user } from '../db/schema/index.ts';
import { isAdminEmail, type ServiceDeps } from './context.ts';
import type { OrgService } from './org-service.ts';

export type SignInRejection =
  | 'not_invited'
  | 'account_disabled'
  | 'unverified_email'
  /** A provider that is not an email authority tried to join an existing account. */
  | 'account_link_blocked';

export type SignInDecision = { ok: true } | { ok: false; reason: SignInRejection };

export interface SignInAttempt {
  email: string;
  emailVerified: boolean;
  /** The existing user, when signing in (not when the account is about to be created). */
  userId?: string | undefined;
  /** The token from the signed `rooster.invite` cookie, if any. */
  inviteToken?: string | null | undefined;
}

/** The part of an email after the last `@`, lowercase. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * Allowlist rules 1 and 2 (04 §4.4): the exact address, or its exact domain, is listed.
 * Comparison is case-insensitive; subdomains do not match their parent domain.
 */
export function matchesAllowlist(
  email: string,
  list: { emails: readonly string[]; domains: readonly string[] },
): boolean {
  const address = email.toLowerCase();
  const domain = emailDomain(address);
  return (
    list.emails.some((e) => e.toLowerCase() === address) ||
    list.domains.some((d) => d.toLowerCase() === domain)
  );
}

/**
 * Who may sign in (FR-AUTH-2, 04 §4.4). Applied when an account is created and on every
 * sign-in of an existing user. The email must be verified, the user not disabled, and one
 * of: (1) the email or (2) its domain is allowlisted (env or `allowlist_entry`), (3) a
 * pending email invitation exists, (4) it is an admin email, or (5) a valid invite token
 * is carried through the OAuth flow. With no allowlist configured only admins get in.
 *
 * An existing user is also admitted while they belong to a live shared org: invites are
 * consumed when accepted, so without this a person who joined through an invite (rules 3
 * and 5) could never sign in again. Removed from every shared org and not allowlisted,
 * they are rejected again.
 */
export class SignInPolicy {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly orgs: OrgService,
  ) {}

  check(attempt: SignInAttempt): SignInDecision {
    const email = attempt.email.toLowerCase();
    if (attempt.userId !== undefined && this.isDisabled(attempt.userId)) {
      return { ok: false, reason: 'account_disabled' };
    }
    if (!attempt.emailVerified) return { ok: false, reason: 'unverified_email' };
    const { config } = this.deps;
    if (isAdminEmail(config, email)) return { ok: true };
    if (matchesAllowlist(email, { emails: config.allowedEmails, domains: config.allowedDomains })) {
      return { ok: true };
    }
    if (this.inAllowlistTable(email) || this.hasPendingInvitation(email)) return { ok: true };
    if (attempt.inviteToken && this.orgs.inviteAdmits(attempt.inviteToken, email)) {
      return { ok: true };
    }
    if (attempt.userId !== undefined && this.inSharedOrg(attempt.userId)) return { ok: true };
    return { ok: false, reason: 'not_invited' };
  }

  /**
   * Whether an existing user is admitted on their own, without an invite token: the check
   * behind a sign-in whose carried invite could not be accepted after all.
   */
  admitsExisting(userId: string): boolean {
    const row = this.deps.db.orm
      .select({ email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (row === undefined) return false;
    return this.check({ email: row.email, emailVerified: row.emailVerified, userId }).ok;
  }

  isDisabled(userId: string): boolean {
    const row = this.deps.db.orm
      .select({ disabledAt: user.disabledAt })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    return row?.disabledAt != null;
  }

  /** `allowlist_entry.value` is COLLATE NOCASE, so these lookups are case-insensitive. */
  private inAllowlistTable(email: string): boolean {
    const row = this.deps.db.orm
      .select({ id: allowlistEntry.id })
      .from(allowlistEntry)
      .where(
        or(
          and(eq(allowlistEntry.kind, 'email'), eq(allowlistEntry.value, email)),
          and(eq(allowlistEntry.kind, 'domain'), eq(allowlistEntry.value, emailDomain(email))),
        ),
      )
      .get();
    return row !== undefined;
  }

  private inSharedOrg(userId: string): boolean {
    const row = this.deps.db.orm
      .select({ id: member.id })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(
        and(
          eq(member.userId, userId),
          eq(organization.isPersonal, false),
          isNull(organization.deletedAt),
        ),
      )
      .get();
    return row !== undefined;
  }

  private hasPendingInvitation(email: string): boolean {
    const row = this.deps.db.orm
      .select({ id: invitation.id })
      .from(invitation)
      .innerJoin(organization, eq(organization.id, invitation.organizationId))
      .where(
        and(
          eq(invitation.email, email),
          eq(invitation.status, 'pending'),
          gt(invitation.expiresAt, this.deps.clock()),
          isNull(organization.deletedAt),
        ),
      )
      .get();
    return row !== undefined;
  }
}
