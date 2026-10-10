import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './context.ts';
import { problemResponse } from './errors.ts';

/** better-auth's endpoints take small JSON bodies (sign-in, sign-out). */
export const AUTH_BODY_LIMIT = 64 * 1024;
/** The largest API body is a task with a 100,000-character description, or a bulk op. */
export const API_BODY_LIMIT = 1024 * 1024;

/**
 * `413 payload_too_large` above `maxSize` bytes. A declared `Content-Length` is checked up
 * front; a chunked body is counted while it is read and cut off at the limit. Enforced
 * here rather than left to the reverse proxy, whose limit may not cover proxied bodies.
 */
export function bodyLimitFor(maxSize: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      problemResponse(
        c,
        413,
        'payload_too_large',
        `The request body exceeds the limit of ${maxSize / 1024} KB.`,
      ),
  });
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
