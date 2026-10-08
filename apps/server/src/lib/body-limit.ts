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
