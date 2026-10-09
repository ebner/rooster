import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { idempotency } from '../db/schema/index.ts';
import type { ServiceDeps, Tx } from './context.ts';

/** Stored responses are replayed for 7 days (04 §6.2, 05 §4.5). */
export const IDEMPOTENCY_TTL_MS = 7 * 86_400_000;

export interface StoredResponse {
  status: number;
  /** Hash of method, path and body of the original request. */
  fingerprint: string;
  contentType: string | null;
  /** The response body as sent; empty for 204 and for a secret. */
  body: string;
  /**
   * The credential that made the request: `session` (the browser) or `grant:<id>`. A replay
   * must come from the same credential.
   */
  credential: string;
  /** The grant's `updated_at` then; a replay after its access changed is refused. */
  grantVersion: number | null;
  /** The body held a secret (a new PAT) and was not stored. */
  secret: boolean;
}

/**
 * 05 §3 keeps `idempotency.response` as one TEXT column. It holds a JSON envelope with the
 * body plus the request fingerprint, so a reused key with a different request is detected
 * without an extra column.
 */
interface Envelope {
  fp: string;
  ct: string | null;
  body: string;
  /** Absent in rows from before Phase 8: those all came from browser sessions. */
  cred?: string;
  gv?: number | null;
  secret?: boolean;
}

function parseEnvelope(text: string): Envelope | null {
  try {
    const value = JSON.parse(text) as Partial<Envelope>;
    if (typeof value.fp !== 'string' || typeof value.body !== 'string') return null;
    return {
      fp: value.fp,
      ct: typeof value.ct === 'string' ? value.ct : null,
      body: value.body,
      cred: typeof value.cred === 'string' ? value.cred : 'session',
      gv: typeof value.gv === 'number' ? value.gv : null,
      secret: value.secret === true,
    };
  } catch {
    return null;
  }
}

/**
 * Drops every stored response of `userIds`, in the caller's transaction. Called when people
 * lose access to an org: a replay would otherwise hand them a response body (a task, a
 * member list) from it after the access is gone. Rows are not org-scoped, so all of the
 * user's go; a retry that arrives later runs for real.
 */
export function forgetStoredResponses(tx: Tx, userIds: readonly string[]): void {
  if (userIds.length === 0) return;
  tx.delete(idempotency)
    .where(inArray(idempotency.userId, [...userIds]))
    .run();
}

/**
 * The `(opId, userId) → response` store behind the idempotency middleware. Keys are scoped
 * per user, so one user can never replay another's response.
 */
export class IdempotencyStore {
  constructor(private readonly deps: ServiceDeps) {}

  get(userId: string, opId: string): StoredResponse | null {
    const row = this.deps.db.orm
      .select()
      .from(idempotency)
      .where(
        and(
          eq(idempotency.opId, opId),
          eq(idempotency.userId, userId),
          gte(idempotency.createdAt, this.deps.clock() - IDEMPOTENCY_TTL_MS),
        ),
      )
      .get();
    if (row === undefined) return null;
    const envelope = parseEnvelope(row.response);
    if (envelope === null) return null;
    return {
      status: row.status,
      fingerprint: envelope.fp,
      contentType: envelope.ct,
      body: envelope.body,
      credential: envelope.cred ?? 'session',
      grantVersion: envelope.gv ?? null,
      secret: envelope.secret === true,
    };
  }

  put(userId: string, opId: string, response: StoredResponse): void {
    const envelope: Envelope = {
      fp: response.fingerprint,
      ct: response.contentType,
      // Secrets are never persisted (a PAT in plaintext).
      body: response.secret ? '' : response.body,
      cred: response.credential,
      gv: response.grantVersion,
      ...(response.secret ? { secret: true } : {}),
    };
    const values = {
      opId,
      userId,
      status: response.status,
      response: JSON.stringify(envelope),
      createdAt: this.deps.clock(),
    };
    // An expired row with the same key is replaced.
    this.deps.db.orm
      .insert(idempotency)
      .values(values)
      .onConflictDoUpdate({ target: [idempotency.opId, idempotency.userId], set: values })
      .run();
  }

  /** Deletes rows older than the TTL; returns how many went. */
  purge(now: number): number {
    return this.deps.db.orm
      .delete(idempotency)
      .where(lt(idempotency.createdAt, now - IDEMPOTENCY_TTL_MS))
      .run().changes;
  }
}
