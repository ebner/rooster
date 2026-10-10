import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';
import { problemResponse } from './errors.ts';

/** better-auth's endpoints take small JSON bodies (sign-in, sign-out). */
export const AUTH_BODY_LIMIT = 64 * 1024;
/** The largest API body is a task with a 100,000-character description, or a bulk op. */
export const API_BODY_LIMIT = 1024 * 1024;

/** The first allocation for a body; it doubles from here up to the limit. */
const INITIAL_BUFFER = 16 * 1024;

/**
 * Reads `body` into one buffer of at most `maxSize` bytes, or returns null once it is larger.
 * Every chunk is copied out and dropped as it arrives: a client that dribbles a body in
 * one-byte chunks must not make the server hold one object per chunk (each costs hundreds of
 * bytes), which a list of chunks does. Memory stays bounded by `maxSize` per request.
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array>,
  maxSize: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return buffer.subarray(0, size);
    if (value.byteLength > maxSize - size) {
      await reader.cancel().catch(() => {});
      return null;
    }
    if (size + value.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(
        Math.min(maxSize, Math.max(size + value.byteLength, buffer.byteLength * 2, INITIAL_BUFFER)),
      );
      grown.set(buffer.subarray(0, size));
      buffer = grown;
    }
    buffer.set(value, size);
    size += value.byteLength;
  }
}

function tooLarge(c: Context<AppEnv>, maxSize: number) {
  return problemResponse(
    c,
    413,
    'payload_too_large',
    `The request body exceeds the limit of ${maxSize / 1024} KB.`,
  );
}

/**
 * `413 payload_too_large` above `maxSize` bytes. A declared `Content-Length` is checked up
 * front; any body is then read into one bounded buffer (`readBodyBounded`) and cut off at the
 * limit, so neither a chunked nor a dribbled declared body can hold more than `maxSize`.
 * Enforced here rather than left to the reverse proxy, whose limit may not cover proxied
 * bodies. An unread rest is left to the Node adapter, which drains it after the response.
 */
export function bodyLimitFor(maxSize: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = c.req.raw;
    if (raw.body === null || raw.method === 'GET' || raw.method === 'HEAD') return next();
    const declared = raw.headers.has('transfer-encoding')
      ? null
      : raw.headers.get('content-length');
    if (declared !== null && !(Number(declared) <= maxSize)) return tooLarge(c, maxSize);
    const body = await readBodyBounded(raw.body, maxSize);
    if (body === null) return tooLarge(c, maxSize);
    c.req.raw = new Request(raw, { body, duplex: 'half' } as RequestInit);
    return next();
  };
}

/**
 * The upload routes (P10, ADR 0049 §3.1): multipart bodies streamed to disk by their handlers,
 * which enforce `ROOSTER_UPLOAD_MAX_MB` (attachments) or 2 MB (avatars) themselves while
 * streaming. They are exempt from the 1 MB API limit, the JSON-only CSRF rule and the
 * idempotency store, which would all read (and buffer) the body first.
 */
const UPLOAD_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/v1\/tasks\/[^/]+\/attachments$/ },
  { method: 'PUT', path: /^\/api\/v1\/me\/avatar$/ },
];

export function isUploadRequest(method: string, path: string): boolean {
  return UPLOAD_ROUTES.some((r) => r.method === method && r.path.test(path));
}

/** The `/api/v1` limit for every route but the uploads. */
export function apiBodyLimit(): MiddlewareHandler<AppEnv> {
  const limit = bodyLimitFor(API_BODY_LIMIT);
  return (c, next) => (isUploadRequest(c.req.method, c.req.path) ? next() : limit(c, next));
}
