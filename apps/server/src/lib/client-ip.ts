import type { HttpBindings } from '@hono/node-server';
import type { Context } from 'hono';

export interface ProxyTrust {
  /** `ROOSTER_TRUST_PROXY`: honour `X-Forwarded-For`. */
  trustProxy: boolean;
  /** `ROOSTER_TRUSTED_PROXY_HOPS`: how many proxies in front of the server append to it. */
  trustedProxyHops: number;
}

/**
 * The client's IP address (04 §4.11): the socket peer, or with `ROOSTER_TRUST_PROXY` the
 * `X-Forwarded-For` entry the outermost trusted proxy appended, which is the Nth from the
 * right for N trusted hops. Entries further left come from the client and can be forged.
 * A header with fewer entries than hops did not pass through every proxy, so the socket
 * peer is used. `null` when unknown (e.g. `app.request()`).
 */
export function clientIp(c: Context, proxy: ProxyTrust): string | null {
  if (proxy.trustProxy) {
    const hops = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const forwarded = hops[hops.length - proxy.trustedProxyHops];
    if (forwarded !== undefined) return forwarded;
  }
  const env = c.env as Partial<HttpBindings> | undefined;
  return env?.incoming?.socket.remoteAddress ?? null;
}
