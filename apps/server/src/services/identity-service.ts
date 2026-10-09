import type { LinkedIdentity } from '@rooster/core/schemas';
import { asc, eq } from 'drizzle-orm';
import { GOOGLE_PROVIDER_ID } from '../config.ts';
import { account } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { type Actor, immediate, readOnly, type ServiceDeps } from './context.ts';
import { requireBrowserSession } from './grant-access.ts';

type AccountRow = typeof account.$inferSelect;

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
      if (!rows.some((row) => row.id === id)) throw identityNotFound();
      if (rows.length <= 1) {
        throw new AppError(
          'last_identity',
          409,
          'This is your only way to sign in; link another identity before removing it.',
        );
      }
      tx.delete(account).where(eq(account.id, id)).run();
    });
  }
}
