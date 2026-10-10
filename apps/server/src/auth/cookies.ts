import { readCookie, signCookieValue, verifyCookieValue } from '../lib/tokens.ts';

/**
 * On https the cookies carry the `__Host-` prefix: browsers then accept them only with
 * Secure, `Path=/` and no Domain, so a sibling subdomain cannot plant or shadow them. Plain
 * http (local development, e2e) cannot use the prefix.
 */
const HOST_PREFIX = '__Host-';

/** better-auth's session cookie (04 §4.4). httpOnly, SameSite=Lax, Secure on https. */
export const SESSION_COOKIE = 'rooster.session';

/**
 * Carries a claimed invite through the OAuth round trip (04 §4.4, rule 5): set by
 * `POST /api/v1/invites/:token/claim`, read when the account is created or signs in.
 */
export const INVITE_COOKIE = 'rooster.invite';
export const INVITE_COOKIE_TTL_MS = 15 * 60 * 1000;

/** better-auth's `rooster.<name>` cookie, or `__Host-rooster.<name>` when the base URL is https. */
export function authCookieName(name: string, secure: boolean): string {
  return `${secure ? HOST_PREFIX : ''}rooster.${name}`;
}

/** `rooster.session`, or `__Host-rooster.session` when the base URL is https. */
export function sessionCookieName(secure: boolean): string {
  return secure ? `${HOST_PREFIX}${SESSION_COOKIE}` : SESSION_COOKIE;
}

/** `rooster.invite`, or `__Host-rooster.invite` when the base URL is https. */
export function inviteCookieName(secure: boolean): string {
  return secure ? `${HOST_PREFIX}${INVITE_COOKIE}` : INVITE_COOKIE;
}

function attributes(secure: boolean, maxAgeSeconds: number): string {
  return `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * `Set-Cookie` for a claimed invite. The expiry is part of the signed value, so the cookie
 * is useless after 15 minutes even if a client keeps sending it.
 */
export function inviteCookie(secret: string, token: string, now: number, secure: boolean): string {
  const value = signCookieValue(secret, `${token}|${now + INVITE_COOKIE_TTL_MS}`);
  return `${inviteCookieName(secure)}=${value}; ${attributes(secure, INVITE_COOKIE_TTL_MS / 1000)}`;
}

export function clearInviteCookie(secure: boolean): string {
  return `${inviteCookieName(secure)}=; ${attributes(secure, 0)}`;
}

/** The invite token of a valid, unexpired `rooster.invite` cookie in a `Cookie` header. */
export function readInviteToken(
  cookieHeader: string | null | undefined,
  secret: string,
  now: number,
  secure: boolean,
): string | null {
  const raw = readCookie(cookieHeader, inviteCookieName(secure));
  if (raw === null) return null;
  const value = verifyCookieValue(secret, raw);
  if (value === null) return null;
  const bar = value.lastIndexOf('|');
  const expiresAt = Number(value.slice(bar + 1));
  if (bar <= 0 || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return value.slice(0, bar);
}
