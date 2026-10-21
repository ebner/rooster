import { createHash } from 'node:crypto';
import type { OAuthClientInfo } from '@rooster/core/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  verification,
} from '../db/schema/index.ts';
import type { Tx } from './context.ts';

// Helpers for OAuth grants (11 §4, ADR 0041): the plugin's rows that point at a rooster grant
// through `referenceId`, and how a client presents itself.

export type OAuthClientRow = typeof oauthClient.$inferSelect;

/**
 * The provider's `referenceId` when the user has no live grant for the client. No consent row
 * ever carries it, so the provider shows the consent screen instead of issuing a code, and a
 * code stamped with it is refused at the token endpoint.
 */
export const NO_GRANT_REFERENCE = 'rooster:no-grant';

/** The plugin's `storeTokens: 'hashed'`: SHA-256, base64url without padding. */
export function hashOAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** A plugin `string[]` column (JSON text on SQLite); anything unreadable is empty. */
export function jsonList(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text === '') return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** The `client_discovery_id` of clients from Client ID Metadata Documents. */
export const CIMD_DISCOVERY_ID = 'cimd';

/** `http://127.0.0.1:<port>`, `http://[::1]…` or `http://localhost…`: "an app on this computer". */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (
      url.protocol === 'http:' &&
      (host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))
    );
  } catch {
    return false;
  }
}

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function httpUrl(value: string | null): string | null {
  if (value === null || value === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Look-alikes of the letters of "rooster" that NFKC leaves alone (Cyrillic, Greek). */
const CONFUSABLES: Readonly<Record<string, string>> = {
  '0': 'o',
  о: 'o',
  ο: 'o',
  е: 'e',
  ε: 'e',
  ѕ: 's',
  т: 't',
  τ: 't',
  г: 'r',
};

/**
 * Whether a client's self-chosen name passes for rooster's own (the first-party "rooster CLI"):
 * "rooster" in it after NFKC, case folding, the look-alikes above, and with everything but
 * letters dropped (so "R o o s t e r", "rooster‌CLI" with a zero-width joiner and "rооster"
 * with Cyrillic o's all count).
 */
export function impersonatesRooster(name: string): boolean {
  const folded = [...name.normalize('NFKC').toLowerCase()]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join('')
    .replace(/[^a-z]/g, '');
  return folded.includes('rooster');
}

/**
 * How the consent screen and Connected apps present a client (11 §3.1):
 * - CIMD: the metadata URL's host is the domain; "Verified" when the redirect host equals it
 *   (`redirectUri` given: that one; else every registered redirect URI).
 * - DCR (`dynamic`): the redirect host is the domain; never verified ("Unverified app").
 * - A name that passes for rooster's own (`impersonatesRooster`) is replaced by the domain.
 */
export function clientInfo(row: OAuthClientRow, redirectUri?: string): OAuthClientInfo {
  const cimd = row.clientDiscoveryId === CIMD_DISCOVERY_ID;
  const redirects = redirectUri === undefined ? jsonList(row.redirectUris) : [redirectUri];
  const metadataHost = cimd ? hostOf(row.clientId) : null;
  const redirectHost = redirects.length > 0 ? hostOf(redirects[0] as string) : null;
  const domain = metadataHost ?? redirectHost ?? '';
  const verified =
    metadataHost !== null &&
    redirects.length > 0 &&
    redirects.every((r) => hostOf(r) === metadataHost);
  const name = row.name?.trim();
  return {
    // An app never takes rooster's own name: it is shown by its host instead.
    name:
      name === undefined || name === '' || impersonatesRooster(name) ? domain : name.slice(0, 100),
    domain,
    logoUri: httpUrl(row.icon),
    clientUri: httpUrl(row.uri),
    verified,
    dynamic: !cimd,
  };
}

export function findClient(tx: Tx, clientId: string): OAuthClientRow | undefined {
  return tx.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).get();
}

/**
 * Deletes everything the provider holds for a grant: access and refresh tokens, consent rows
 * and unredeemed authorization codes. In the caller's transaction (revocation, ADR 0041).
 */
export function deleteGrantArtifacts(tx: Tx, grantIds: readonly string[]): void {
  if (grantIds.length === 0) return;
  const refresh = tx
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(inArray(oauthRefreshToken.referenceId, [...grantIds]))
    .all()
    .map((r) => r.id);
  tx.delete(oauthAccessToken)
    .where(inArray(oauthAccessToken.referenceId, [...grantIds]))
    .run();
  if (refresh.length > 0) {
    tx.delete(oauthAccessToken).where(inArray(oauthAccessToken.refreshId, refresh)).run();
    tx.delete(oauthRefreshToken).where(inArray(oauthRefreshToken.id, refresh)).run();
  }
  tx.delete(oauthConsent)
    .where(inArray(oauthConsent.referenceId, [...grantIds]))
    .run();
  for (const id of grantIds) {
    tx.delete(verification)
      .where(
        sql`CASE WHEN json_valid(${verification.value}) THEN json_extract(${verification.value}, '$.type') = 'authorization_code' AND json_extract(${verification.value}, '$.referenceId') = ${id} ELSE 0 END`,
      )
      .run();
  }
}

/** Consent rows of (user, client) that belong to no grant or another grant than `keep`. */
export function deleteStaleConsents(tx: Tx, userId: string, clientId: string, keep: string): void {
  tx.delete(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, userId),
        eq(oauthConsent.clientId, clientId),
        sql`(${oauthConsent.referenceId} IS NULL OR ${oauthConsent.referenceId} <> ${keep})`,
      ),
    )
    .run();
}

/** The authorization code's stored request (the plugin's verification value), or null. */
export function authorizationCodeValue(
  tx: Tx,
  code: string,
): { referenceId?: unknown; userId?: unknown; query?: { client_id?: unknown } } | null {
  const row = tx
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.identifier, hashOAuthToken(code)))
    .get();
  if (row === undefined) return null;
  try {
    const value = JSON.parse(row.value) as unknown;
    return value !== null && typeof value === 'object'
      ? (value as { referenceId?: unknown })
      : null;
  } catch {
    return null;
  }
}
