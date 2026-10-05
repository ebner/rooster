import type { Config } from '../config.ts';
import type { AppDb, Orm } from '../db/client.ts';
import type { Logger } from '../lib/logger.ts';

export type Scope = 'read' | 'write';

/** Who is making a request (04 §4.3). Bearer and PAT actors arrive in Phase 8. */
export interface Actor {
  userId: string;
  email: string;
  /** `ROOSTER_ADMIN_EMAILS` lists the actor's (verified) email. */
  isAdmin: boolean;
  via: 'session';
  /** The better-auth session behind the request. */
  sessionId: string;
  scopes: readonly Scope[];
}

/**
 * Per-mutation metadata from the request headers (06 §1): the LWW edit time (already
 * clamped), the originating client instance and the client kind (`web`, `cli/1.2`, …).
 */
export interface OpMeta {
  editTime: number;
  clientId: string | null;
  client: string | null;
}

export interface ServiceDeps {
  db: AppDb;
  config: Config;
  logger: Logger;
  /** ms epoch; injectable for tests. */
  clock: () => number;
}

/** A Drizzle transaction on the single better-sqlite3 connection. */
export type Tx = Parameters<Parameters<Orm['transaction']>[0]>[0];

/**
 * Runs `fn` in a `BEGIN IMMEDIATE` transaction (05 §1). better-sqlite3 is synchronous, so
 * `fn` must not be async: a promise would escape the transaction.
 */
export function immediate<T>(db: AppDb, fn: (tx: Tx) => T): T {
  return db.orm.transaction(fn, { behavior: 'immediate' });
}

export function isAdminEmail(config: Config, email: string): boolean {
  return config.adminEmails.includes(email.toLowerCase());
}
