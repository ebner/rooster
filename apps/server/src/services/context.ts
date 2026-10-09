import type { GrantConstraints, GrantScope } from '@rooster/core/grants';
import type { GrantKind } from '@rooster/core/schemas';
import type { Config } from '../config.ts';
import type { AppDb, Orm } from '../db/client.ts';
import type { DomainEvent, EventBus } from '../events/bus.ts';
import { currentOrigin } from '../events/origin.ts';
import type { Logger } from '../lib/logger.ts';

/** The grant behind a PAT or CLI device request (11 §2); null for the browser session. */
export interface ActorGrant {
  id: string;
  kind: GrantKind;
  /** `rooster-cli` for devices (an OAuth client id in P9); null for PATs. */
  clientId: string | null;
  /** As stored; check with `hasScope`, which applies the implications. */
  scopes: readonly GrantScope[];
  constraints: GrantConstraints;
  /** `updated_at` of the grant: changes whenever its access is edited. */
  updatedAt: number;
  /**
   * P9, OAuth only: the protected resource the access token is bound to (11 §4.3). Activity
   * records `via: 'mcp'` for `'mcp'` and `'oauth'` for `'api'` (11 §2.3).
   */
  resource?: 'mcp' | 'api';
}

/**
 * How the request authenticated: the browser cookie, a session token as bearer, a PAT, or (P9)
 * an OAuth access token, including the remote MCP endpoint's in-process calls.
 */
export type ActorVia = 'session' | 'bearer' | 'pat' | 'oauth';

/** Who is making a request (04 §4.3). */
export interface Actor {
  userId: string;
  email: string;
  /** `ROOSTER_ADMIN_EMAILS` lists the actor's (verified) email. */
  isAdmin: boolean;
  via: ActorVia;
  /**
   * The better-auth session behind the request; for a PAT, its grant ID (an SSE stream is
   * bookkept and ended per session).
   */
  sessionId: string;
  /** Null: the browser session, full access. Else every service checks it (`authorizeGrant`). */
  grant: ActorGrant | null;
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
  /** Domain events, published after commit (04 §4.5). */
  events: EventBus;
}

/** A Drizzle transaction on the single better-sqlite3 connection. */
export type Tx = Parameters<Parameters<Orm['transaction']>[0]>[0];

/**
 * Runs `fn` in a `BEGIN IMMEDIATE` transaction (05 §1). better-sqlite3 is synchronous, so
 * `fn` must not be async: a promise would escape the transaction.
 */
export function immediate<T>(db: AppDb, fn: (tx: Tx) => T): T {
  const queue: (() => void)[] = [];
  const result = db.orm.transaction(
    (tx) => {
      commitQueues.set(tx, queue);
      return fn(tx);
    },
    { behavior: 'immediate' },
  );
  // Only reached after COMMIT: a throw inside `fn` rolls back and drops the queue.
  for (const callback of queue) callback();
  return result;
}

/**
 * Runs a read-only `fn` in a `BEGIN DEFERRED` transaction: one consistent snapshot without
 * taking the write lock, so a long read never blocks writers in other connections.
 */
export function readOnly<T>(db: AppDb, fn: (tx: Tx) => T): T {
  return db.orm.transaction(fn, { behavior: 'deferred' });
}

const commitQueues = new WeakMap<Tx, (() => void)[]>();

/** Runs `callback` once the transaction `tx` (opened by `immediate`) has committed. */
export function afterCommit(tx: Tx, callback: () => void): void {
  const queue = commitQueues.get(tx);
  if (queue === undefined) throw new Error('afterCommit needs a transaction from immediate()');
  queue.push(callback);
}

export type EventDraft = Omit<DomainEvent, 'origin'>;

/**
 * Publishes a domain event once `tx` commits, tagged with the request's client ID. Audiences
 * are computed by the caller inside `tx`, so they match the committed state exactly; nothing
 * is published for rolled-back work.
 */
export function emitAfterCommit(deps: ServiceDeps, tx: Tx, event: EventDraft): void {
  const origin = currentOrigin();
  afterCommit(tx, () => deps.events.publish({ ...event, origin }));
}

export function isAdminEmail(config: Config, email: string): boolean {
  return config.adminEmails.includes(email.toLowerCase());
}
