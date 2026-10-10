import type { LinkedIdentity, RemovedIdentity } from '@rooster/core/schemas';
import { and, asc, desc, eq } from 'drizzle-orm';
import { GOOGLE_PROVIDER_ID } from '../config.ts';
import { account, unlinkedIdentity } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { type Actor, immediate, readOnly, type ServiceDeps } from './context.ts';
import { requireBrowserSession } from './grant-access.ts';

type AccountRow = typeof account.$inferSelect;

type UnlinkedRow = typeof unlinkedIdentity.$inferSelect;

const identityNotFound = () => new AppError('not_found', 404, 'Sign-in identity not found.');

/**
 * The email in a stored ID token, for display only: better-auth verified the token at sign-in
 * and stores it unencrypted. Anything unreadable is null.
 */
function idTokenEmail(idToken: string | null): string | null {
  const payload = idToken?.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    const email = (claims as { email?: unknown } | null)?.email;
    return typeof email === 'string' && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

/**
 * Linked sign-in identities (FR-SET-3, ADR 0041 §7): the better-auth `account` rows of the user,
 * listed and unlinked from Settings → Security. Browser session only; the last identity stays.
 * An unlinked identity is recorded in `unlinked_identity` and stays blocked from signing in,
 * including linking again by email, until the user allows it again (`allow`).
 */
export class IdentityService {
  constructor(private readonly deps: ServiceDeps) {}

  private providerName(providerId: string): string {
    if (providerId === GOOGLE_PROVIDER_ID) return 'Google';
    return this.deps.config.oidcProviders.find((p) => p.id === providerId)?.name ?? providerId;
  }

  private toDto(row: AccountRow): LinkedIdentity {
    return {
      id: row.id,
      providerId: row.providerId,
      providerName: this.providerName(row.providerId),
      email: idTokenEmail(row.idToken),
      createdAt: row.createdAt.getTime(),
    };
  }

  private toRemovedDto(row: UnlinkedRow): RemovedIdentity {
    return {
      id: row.id,
      providerId: row.providerId,
      providerName: this.providerName(row.providerId),
      email: row.email,
      removedAt: row.unlinkedAt,
    };
  }

  /** GET /me/identities: oldest first. */
  list(actor: Actor): LinkedIdentity[] {
    requireBrowserSession(actor);
    return readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(account)
        .where(eq(account.userId, actor.userId))
        .orderBy(asc(account.createdAt), asc(account.id))
        .all()
        .map((row) => this.toDto(row)),
    );
  }

  /**
   * DELETE /me/identities/:id. Another user's identity is the same `404` as an unknown one;
   * removing the only identity is `409 last_identity` (the account could never sign in again).
   */
  unlink(actor: Actor, id: string): void {
    requireBrowserSession(actor);
    immediate(this.deps.db, (tx) => {
      const rows = tx.select().from(account).where(eq(account.userId, actor.userId)).all();
      const row = rows.find((r) => r.id === id);
      if (row === undefined) throw identityNotFound();
      if (rows.length <= 1) {
        throw new AppError(
          'last_identity',
          409,
          'This is your only way to sign in; link another identity before removing it.',
        );
      }
      const record = {
        id: row.id,
        userId: actor.userId,
        email: idTokenEmail(row.idToken),
        unlinkedAt: this.deps.clock(),
      };
      // Recorded before the account goes, in one transaction: there is never a moment in which
      // the identity is neither linked nor blocked.
      tx.insert(unlinkedIdentity)
        .values({ ...record, providerId: row.providerId, accountId: row.accountId })
        .onConflictDoUpdate({
          target: [unlinkedIdentity.providerId, unlinkedIdentity.accountId],
          set: record,
        })
        .run();
      tx.delete(account).where(eq(account.id, id)).run();
    });
  }

  /** GET /me/identities/removed: the identities this user unlinked, newest first. */
  listRemoved(actor: Actor): RemovedIdentity[] {
    requireBrowserSession(actor);
    return readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(unlinkedIdentity)
        .where(eq(unlinkedIdentity.userId, actor.userId))
        .orderBy(desc(unlinkedIdentity.unlinkedAt), desc(unlinkedIdentity.id))
        .all()
        .map((row) => this.toRemovedDto(row)),
    );
  }

  /**
   * DELETE /me/identities/removed/:id: allows a removed identity again, so the next sign-in
   * through it links it as before. Another user's record is the same `404` as an unknown one.
   */
  allow(actor: Actor, id: string): void {
    requireBrowserSession(actor);
    immediate(this.deps.db, (tx) => {
      const deleted = tx
        .delete(unlinkedIdentity)
        .where(and(eq(unlinkedIdentity.id, id), eq(unlinkedIdentity.userId, actor.userId)))
        .returning({ id: unlinkedIdentity.id })
        .all();
      if (deleted.length === 0) throw identityNotFound();
    });
  }

  /**
   * Whether this provider subject was unlinked and not allowed again. Called by better-auth's
   * account create hook and the sign-in gate (auth/auth.ts) for every identity about to be
   * linked or to create an account; not an actor-facing method.
   */
  isBlocked(providerId: string, accountId: string): boolean {
    return (
      readOnly(this.deps.db, (tx) =>
        tx
          .select({ id: unlinkedIdentity.id })
          .from(unlinkedIdentity)
          .where(
            and(
              eq(unlinkedIdentity.providerId, providerId),
              eq(unlinkedIdentity.accountId, accountId),
            ),
          )
          .get(),
      ) !== undefined
    );
  }
}
