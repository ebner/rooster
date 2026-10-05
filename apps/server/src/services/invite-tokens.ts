import { isUuidv7 } from '@rooster/core/ids';
import { hashToken, hmacBase64, safeEqual } from '../lib/tokens.ts';

/**
 * Invite URLs carry one of two token kinds:
 * - **link** invites: a random 256-bit token; only its SHA-256 is stored (`invite_link`).
 * - **email** invites: `<invitationId>.<HMAC>`. The better-auth-shaped `invitation` table
 *   has no token column, so the token is the row ID signed with the auth secret. It can be
 *   re-derived to show the URL again, and a revoke (status `canceled`) invalidates it.
 */
export type ParsedInviteToken = { kind: 'link'; tokenHash: string } | { kind: 'email'; id: string };

const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function emailSignature(secret: string, id: string): string {
  return hmacBase64(secret, `rooster-invite:${id}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function emailInviteToken(secret: string, invitationId: string): string {
  return `${invitationId}.${emailSignature(secret, invitationId)}`;
}

/** Classifies and authenticates a token from a URL; `null` for anything malformed or forged. */
export function parseInviteToken(secret: string, token: string): ParsedInviteToken | null {
  const dot = token.indexOf('.');
  if (dot !== -1) {
    const id = token.slice(0, dot);
    if (!isUuidv7(id)) return null;
    return safeEqual(token.slice(dot + 1), emailSignature(secret, id))
      ? { kind: 'email', id }
      : null;
  }
  return LINK_TOKEN.test(token) ? { kind: 'link', tokenHash: hashToken(token) } : null;
}
