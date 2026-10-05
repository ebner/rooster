import { and, eq, gte, lt } from 'drizzle-orm';
import { idempotency } from '../db/schema/index.ts';
import type { ServiceDeps } from './context.ts';

/** Stored responses are replayed for 7 days (04 §6.2, 05 §4.5). */
export const IDEMPOTENCY_TTL_MS = 7 * 86_400_000;

export interface StoredResponse {
  status: number;
  /** Hash of method, path and body of the original request. */
  fingerprint: string;
  contentType: string | null;
  /** The response body as sent; empty for 204. */
  body: string;
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
}

function parseEnvelope(text: string): Envelope | null {
  try {
    const value = JSON.parse(text) as Partial<Envelope>;
    if (typeof value.fp !== 'string' || typeof value.body !== 'string') return null;
    return { fp: value.fp, ct: typeof value.ct === 'string' ? value.ct : null, body: value.body };
  } catch {
    return null;
  }
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
    };
  }

  put(userId: string, opId: string, response: StoredResponse): void {
    const envelope: Envelope = {
      fp: response.fingerprint,
      ct: response.contentType,
      body: response.body,
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
