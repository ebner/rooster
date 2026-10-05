import type { MiddlewareHandler } from 'hono';
import { runWithOrigin } from '../events/origin.ts';
import type { OpMeta } from '../services/context.ts';
import type { AppEnv } from './context.ts';

const DAY_MS = 86_400_000;
/** 04 §6.2: a skewed client clock can backdate an edit by at most 30 days … */
export const EDIT_TIME_MAX_PAST_MS = 30 * DAY_MS;
/** … and can win against the future by at most 5 s. */
export const EDIT_TIME_MAX_FUTURE_MS = 5_000;

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_RE = /^[a-z]+(?:\/[A-Za-z0-9._+-]{1,32})?$/;

/**
 * `X-Rooster-Edit-Time` clamped to `[now − 30 d, now + 5 s]`. A missing or malformed header
 * means "now" (06 §1).
 */
export function clampEditTime(header: string | undefined, now: number): number {
  if (header === undefined || !/^\d{1,16}$/.test(header.trim())) return now;
  const value = Number(header.trim());
  return Math.min(Math.max(value, now - EDIT_TIME_MAX_PAST_MS), now + EDIT_TIME_MAX_FUTURE_MS);
}

export function parseOpMeta(
  headers: {
    editTime?: string | undefined;
    clientId?: string | undefined;
    client?: string | undefined;
  },
  now: number,
): OpMeta {
  const clientId = headers.clientId?.trim();
  const client = headers.client?.trim();
  return {
    editTime: clampEditTime(headers.editTime, now),
    clientId: clientId !== undefined && CLIENT_ID_RE.test(clientId) ? clientId : null,
    client: client !== undefined && CLIENT_RE.test(client) ? client : null,
  };
}

/**
 * Captures edit time and client identity into `c.var.opMeta` for the services (04 §6.2), and
 * makes the client ID the origin of every domain event the request emits (04 §4.5).
 */
export function requestMeta(clock: () => number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const meta = parseOpMeta(
      {
        editTime: c.req.header('x-rooster-edit-time'),
        clientId: c.req.header('x-rooster-client-id'),
        client: c.req.header('x-rooster-client'),
      },
      clock(),
    );
    c.set('opMeta', meta);
    return runWithOrigin(meta.clientId, () => next());
  };
}
