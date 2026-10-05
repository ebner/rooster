import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { IdempotencyStore } from '../services/idempotency-store.ts';
import type { AppEnv } from './context.ts';
import { problemResponse } from './errors.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Responses that must not be replayed: the client retries these (04 §6.2), so the next
 * attempt has to run for real.
 */
function storable(status: number): boolean {
  return status < 500 && status !== 401 && status !== 429;
}

/**
 * `Idempotency-Key` on mutations (06 §1, AC-2.11). The first response for a (user, key) is
 * stored with a fingerprint of the request; a replay returns it unchanged without running
 * the handler again, and the same key on a different request is `422 idempotency_key_reuse`.
 * Concurrent requests with the same key wait for the first one to finish.
 */
export function idempotencyMiddleware(store: IdempotencyStore): MiddlewareHandler<AppEnv> {
  const inFlight = new Map<string, Promise<void>>();
  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    const actor = c.get('actor');
    if (key === undefined || actor === undefined || !MUTATING.has(c.req.method)) return next();
    if (!KEY_RE.test(key)) {
      return problemResponse(c, 422, 'validation_failed', 'Invalid Idempotency-Key header.', [
        { path: 'Idempotency-Key', message: 'Expected 1–128 characters of [A-Za-z0-9_-]' },
      ]);
    }
    const url = new URL(c.req.url);
    const fingerprint = createHash('sha256')
      .update(`${c.req.method} ${url.pathname}${url.search}\n`)
      .update(await c.req.text())
      .digest('hex');
    const slot = `${actor.userId}\u0000${key}`;
    for (;;) {
      const pending = inFlight.get(slot);
      if (pending === undefined) break;
      await pending;
    }

    const stored = store.get(actor.userId, key);
    if (stored !== null) {
      if (stored.fingerprint !== fingerprint) {
        return problemResponse(
          c,
          422,
          'idempotency_key_reuse',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      const headers = new Headers({ 'Idempotent-Replayed': 'true' });
      if (stored.contentType !== null) headers.set('Content-Type', stored.contentType);
      return new Response(stored.status === 204 ? null : stored.body, {
        status: stored.status,
        headers,
      });
    }

    let done = () => {};
    inFlight.set(
      slot,
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    try {
      await next();
      const status = c.res.status;
      if (storable(status)) {
        store.put(actor.userId, key, {
          status,
          fingerprint,
          contentType: c.res.headers.get('content-type'),
          body: status === 204 ? '' : await c.res.clone().text(),
        });
      }
    } finally {
      inFlight.delete(slot);
      done();
    }
  };
}
