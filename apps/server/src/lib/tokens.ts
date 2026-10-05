import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A fresh 256-bit secret token, base64url (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest: how secret tokens are stored (04 §4.11). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** HMAC-SHA256 of `value`, base64 (the signed-cookie format of better-call and Hono). */
export function hmacBase64(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64');
}

/**
 * Signed cookie value `<value>.<base64 HMAC>`, URI-encoded. This is the format better-auth
 * uses for `rooster.session`, so the same helper verifies both.
 */
export function signCookieValue(secret: string, value: string): string {
  return encodeURIComponent(`${value}.${hmacBase64(secret, value)}`);
}

/** The value of a signed cookie, or `null` when the signature does not match. */
export function verifyCookieValue(secret: string, raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const dot = decoded.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = decoded.slice(0, dot);
  const signature = decoded.slice(dot + 1);
  return safeEqual(signature, hmacBase64(secret, value)) ? value : null;
}

/** Reads one cookie from a `Cookie` header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
