import type { HttpBindings } from '@hono/node-server';
import type { Context } from 'hono';

/**
 * The client's IP address: the socket peer, or the first `X-Forwarded-For` hop when
 * `ROOSTER_TRUST_PROXY` is set (04 §4.11). `null` when unknown (e.g. `app.request()`).
 */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  const env = c.env as Partial<HttpBindings> | undefined;
  return env?.incoming?.socket.remoteAddress ?? null;
}
