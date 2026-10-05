import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';
import { problemResponse } from './errors.ts';

export interface RateLimitOptions {
  /** Requests allowed per user within `windowMs`. */
  max: number;
  windowMs: number;
}

/** 06 §1: 600 requests per minute per user for the API. */
export const API_RATE_LIMIT: RateLimitOptions = { max: 600, windowMs: 60_000 };

/**
 * A per-user sliding-window limiter over the request timestamps of the last window. It is
 * in memory: a single process serves the instance (04 §1), and a restart simply resets it.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly options: RateLimitOptions) {}

  /** Records a hit; returns 0 when allowed, else the ms until the next request is allowed. */
  hit(key: string, now: number): number {
    const { max, windowMs } = this.options;
    this.sweep(now);
    const since = now - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= max) {
      this.hits.set(key, list);
      return Math.max(1, (list[0] ?? now) + windowMs - now);
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }

  /** Forgets idle users once per window, so the map does not grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    const since = now - this.options.windowMs;
    for (const [key, list] of this.hits) {
      if ((list[list.length - 1] ?? 0) <= since) this.hits.delete(key);
    }
  }
}

/**
 * Limits authenticated `/api/v1` requests per user (`429 rate_limited` with `Retry-After`).
 * Public routes (meta, OpenAPI, invite preview) have no actor and are not counted; health
 * probes live outside `/api/v1`.
 */
export function userRateLimit(
  options: RateLimitOptions,
  clock: () => number,
): MiddlewareHandler<AppEnv> {
  const limiter = new SlidingWindowLimiter(options);
  return async (c, next) => {
    const actor = c.get('actor');
    if (actor === undefined) return next();
    const waitMs = limiter.hit(actor.userId, clock());
    if (waitMs > 0) {
      c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
      return problemResponse(c, 429, 'rate_limited', 'Too many requests; slow down.');
    }
    return next();
  };
}
