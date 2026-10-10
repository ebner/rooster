import { createHash, randomBytes } from 'node:crypto';
import { defaultKeyHasher } from '@better-auth/api-key';
import {
  ADMIN_SCOPE,
  expandScopes,
  GRANT_SCOPES,
  type GrantConstraints,
  type GrantScope,
  hasScope,
  isGrantScope,
  isNarrowing,
  minimalScopes,
  OAUTH_EXCLUDED_SCOPES,
} from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import {
  type DeviceApprove,
  type DeviceRequest,
  type Grant,
  type GrantKind,
  type GrantPatch,
  grantConstraintsSchema,
  type OAuthConsentDecision,
  type OAuthConsentRequest,
  SESSION_ONLY_IDLE_MS,
  type SseNotification,
  type TokenCreate,
  type TokenCreated,
} from '@rooster/core/schemas';
import { and, desc, eq, inArray, isNull, lt, max, notInArray, or, sql } from 'drizzle-orm';
import type { OAuthResource } from '../auth/oauth-bearer.ts';
import { resourceOf, resourceUri } from '../auth/oauth-metadata.ts';
import {
  accessGrant,
  apikey,
  deviceCode,
  member,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  organization,
  session,
  taskGroup,
  user,
} from '../db/schema/index.ts';
import type { PriorGroups } from '../events/bus.ts';
import { AppError, type FieldError } from '../lib/errors.ts';
import {
  type Actor,
  type ActorGrant,
  type ActorVia,
  emitAfterCommit,
  immediate,
  isAdminEmail,
  readOnly,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { selfAudience } from './event-audience.ts';
import { canReadNotification, requireBrowserSession, visibleKeys } from './grant-access.ts';
import {
  authorizationCodeValue,
  clientInfo,
  deleteGrantArtifacts,
  deleteStaleConsents,
  findClient,
  hashOAuthToken,
  isLoopbackRedirect,
  jsonList,
  NO_GRANT_REFERENCE,
} from './oauth-grants.ts';

const DAY_MS = 86_400_000;
/** `last_used_at`/`last_used_ip` are written at most this often per grant (11 §2.4). */
export const GRANT_TOUCH_MS = 60_000;

/** The CLI's client id for the device flow (07 §2). */
export const CLI_CLIENT_ID = 'rooster-cli';
const CLI_CLIENT_NAME = 'rooster CLI';

/**
 * OAuth access and refresh tokens carry these prefixes (the plugin adds them and does not store
 * them; auth.ts configures the same values).
 */
export const OAUTH_ACCESS_PREFIX = 'rooster_at_';
export const OAUTH_REFRESH_PREFIX = 'rooster_rt_';

/** PATs are `rooster_pat_` + 48 random letters and digits (04 §4.4). */
export const PAT_PREFIX = 'rooster_pat_';
const PAT_RANDOM_LENGTH = 48;
/** Stored in `apikey.start` and shown as `tokenPrefix` to tell tokens apart. */
const PAT_VISIBLE_LENGTH = PAT_PREFIX.length + 4;

/** The Settings → Connected apps query key (SSE contract, like `['me']`). */
export const GRANTS_KEY = ['grants'] as const;

type GrantRow = typeof accessGrant.$inferSelect;

const grantNotFound = () => new AppError('not_found', 404, 'Grant not found.');
const consentNotFound = () =>
  new AppError(
    'not_found',
    404,
    'That authorization request is unknown or has expired. Start again in the app.',
  );
const adminOnly = () =>
  new AppError('admin_only_scope', 403, 'Only instance admins can grant the "admin" permission.');

/** The outcome of an OAuth token request check (the mount answers `invalid_grant` on `false`). */
export type OAuthTokenCheck =
  | { ok: true; grantId: string | null }
  | { ok: false; description: string };

/** A provider `confirmation` column (JSON) that binds a token to a key (DPoP `jkt`). */
function isBound(confirmation: string | null): boolean {
  return confirmation !== null && confirmation !== '' && confirmation !== 'null';
}

/**
 * What `applyOAuthConsent` decided, to finish or undo it around the provider's answer. A new
 * grant exists from the start (the provider stamps its ID on the code); a step-up of a live
 * grant is staged here and written only once the provider has issued the code, so a failed or
 * overlapping decision never leaves a widened grant behind.
 */
export interface PreparedConsent {
  grantId: string;
  clientId: string;
  userId: string;
  /** True when the decision created the grant (undo deletes it). */
  created: boolean;
  /** Step-up only: what `finishOAuthConsent` writes, merged with the grant as it is then. */
  stepUp: {
    approved: GrantScope[];
    fields: {
      label: string;
      constraints: string;
      expiresAt: number | null;
      idleTimeoutMs: number | null;
    };
  } | null;
  /**
   * The `scope` to hand the provider: the requested scopes the grant covers; empty when it
   * covers none literally (the provider then keeps the request's own scopes).
   */
  pluginScope: string;
  /** Every resource consented for this grant, the new one included. */
  resources: string[];
}

/** How long a displayed consent request may be decided (the provider's signed query: 10 min). */
const CONSENT_VIEW_TTL_MS = 10 * 60 * 1000;
/** Displayed consent requests remembered at once; the oldest are forgotten first. */
const CONSENT_VIEWS_MAX = 10_000;

/** The capabilities an OAuth client may get, in contract order. */
const ALL_OAUTH_SCOPES = GRANT_SCOPES.filter((s) => !OAUTH_EXCLUDED_SCOPES.includes(s));
const deviceNotFound = () =>
  new AppError('not_found', 404, 'That code is unknown or has expired. Start again in the CLI.');

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlphanumeric(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  // 248 is the largest multiple of 62 below 256: no modulo bias.
  for (const byte of bytes) {
    if (byte < 248) out += ALPHANUMERIC[byte % 62];
    if (out.length === length) break;
  }
  return out.length === length ? out : out + randomAlphanumeric(length - out.length);
}

/** Space-separated scope text → known scopes (unknown words dropped). */
export function parseScopes(text: string | null | undefined): GrantScope[] {
  return [...new Set((text ?? '').split(/\s+/).filter(isGrantScope))];
}

function parseConstraints(text: string): GrantConstraints {
  try {
    const value = JSON.parse(text) as GrantConstraints;
    if (value !== null && typeof value === 'object' && 'orgs' in value) return value;
  } catch {
    // Unreadable constraints grant nothing.
  }
  return { orgs: [] };
}

/** User codes are shown as `ABCD-EFGH`; typed codes may carry dashes, spaces or lower case. */
export function normalizeUserCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/**
 * The default device label from the CLI's `User-Agent` (`rooster-cli/<v> (<platform>; <arch>;
 * <hostname>)`): "rooster CLI on <hostname>", else "… on <OS>", else "rooster CLI".
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const m = /\(([^)]*)\)/.exec(userAgent ?? '');
  const parts = (m?.[1] ?? '').split(';').map((p) => p.trim());
  const os: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  const host = parts[2];
  if (host !== undefined && host !== '') return `${CLI_CLIENT_NAME} on ${host.slice(0, 60)}`;
  const platform = parts[0] ?? '';
  const name = os[platform.toLowerCase()] ?? (platform === '' ? null : platform.slice(0, 30));
  return name === null ? CLI_CLIENT_NAME : `${CLI_CLIENT_NAME} on ${name}`;
}

/** A freshly minted PAT: the secret (shown once), its hash and the visible start. */
export interface MintedToken {
  token: string;
  hash: string;
  start: string;
}

export async function mintToken(): Promise<MintedToken> {
  const token = `${PAT_PREFIX}${randomAlphanumeric(PAT_RANDOM_LENGTH)}`;
  return { token, hash: await defaultKeyHasher(token), start: token.slice(0, PAT_VISIBLE_LENGTH) };
}

/** What an SSE stream may carry for its actor (11 §2.3: only what the grant may read). */
export interface StreamAccess {
  sessionId: string;
  isValid: () => boolean;
  /** The keys of an invalidation the grant may receive (orgs, tasks and scopes it reaches). */
  filterKeys?: (
    org: string | null,
    keys: readonly (readonly string[])[],
    prior?: PriorGroups,
  ) => (readonly string[])[];
  /** Orgs where the grant reads only some groups (the hub's `hasRestrictedGrantStream`). */
  restrictedOrgs?: readonly string[];
  /** Rewrites or drops (`null`) a `notification` message; absent for the browser. */
  notification?: (data: unknown) => unknown | null;
}

/**
 * Grants (11 §2): one per PAT, CLI device session or (P9) OAuth client. Resolves the actor of
 * every non-browser credential, and manages Settings → Connected apps, PATs and device
 * approval (06 §2.1).
 */
export class GrantService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly sessionActive: (userId: string, sessionId: string) => boolean,
    /** The bell badge as the actor may see it (NotificationService.unreadCountFor). */
    private readonly unreadCount: (actor: Actor) => number,
  ) {}

  /**
   * Consent requests the browser displayed, by session and signed query (expiry, ms). A decision
   * is accepted only from the session the request was shown to: if the browser's cookie changes
   * to another account between GET and POST, the decision is refused rather than granting that
   * account (ASVS 4.1.2). In memory: rooster runs one process, and after a restart the page
   * simply has to be loaded again.
   */
  private readonly consentViews = new Map<string, number>();

  private consentViewKey(actor: Actor, oauthQuery: string): string {
    const digest = createHash('sha256').update(oauthQuery).digest('base64url');
    return `${actor.sessionId}:${digest}`;
  }

  private rememberConsentView(actor: Actor, oauthQuery: string): void {
    const now = this.now();
    const key = this.consentViewKey(actor, oauthQuery);
    this.consentViews.delete(key);
    this.consentViews.set(key, now + CONSENT_VIEW_TTL_MS);
    // Insertion order is expiry order: drop the expired, then the oldest beyond the cap.
    for (const [k, expiresAt] of this.consentViews) {
      if (expiresAt > now && this.consentViews.size <= CONSENT_VIEWS_MAX) break;
      this.consentViews.delete(k);
    }
  }

  private requireConsentView(actor: Actor, oauthQuery: string): void {
    const expiresAt = this.consentViews.get(this.consentViewKey(actor, oauthQuery));
    if (expiresAt === undefined || expiresAt <= this.now()) throw consentNotFound();
  }

  private now(): number {
    return this.deps.clock();
  }

  // --- actor resolution (04 §4.3–4.4) ---------------------------------------------------------

  private live(row: GrantRow | undefined, now: number): row is GrantRow {
    return (
      row !== undefined && row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now)
    );
  }

  private toActorGrant(row: GrantRow): ActorGrant {
    const scopes = parseScopes(row.scopes);
    return {
      id: row.id,
      kind: row.kind,
      clientId: row.clientId,
      // An OAuth grant never carries `admin` (ADR 0041), whatever the row says.
      scopes:
        row.kind === 'oauth' ? scopes.filter((s) => !OAUTH_EXCLUDED_SCOPES.includes(s)) : scopes,
      constraints: parseConstraints(row.constraints),
      updatedAt: row.updatedAt,
    };
  }

  /**
   * "This session only" (ADR 0041 §3): the grant's last use is its newest token issuance (a
   * code exchange or a refresh, each of which writes a fresh token row), else its consent.
   * Past `idle_timeout_ms` since then, the grant is over.
   */
  private idleExpired(row: GrantRow, now: number): boolean {
    if (row.idleTimeoutMs === null) return false;
    const db = this.deps.db.orm;
    const refreshed = db
      .select({ at: max(oauthRefreshToken.createdAt) })
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.referenceId, row.id))
      .get()?.at;
    const issued = db
      .select({ at: max(oauthAccessToken.createdAt) })
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.referenceId, row.id))
      .get()?.at;
    const last = Math.max(row.updatedAt, refreshed?.getTime() ?? 0, issued?.getTime() ?? 0);
    return now - last > row.idleTimeoutMs;
  }

  /** A live OAuth grant: unrevoked, unexpired and not idle-expired. */
  private liveOAuth(row: GrantRow | undefined, now: number): row is GrantRow {
    return this.live(row, now) && row.kind === 'oauth' && !this.idleExpired(row, now);
  }

  /** Whether the session is a CLI device session (linked to a grant). */
  isGrantSession(sessionId: string): boolean {
    const row = this.deps.db.orm
      .select({ grantId: session.grantId })
      .from(session)
      .where(eq(session.id, sessionId))
      .get();
    return row !== undefined && row.grantId !== null;
  }

  /** At most once a minute per grant, so a busy CLI does not write on every request. */
  private touch(row: GrantRow, ip: string | null, now: number): void {
    if (row.lastUsedAt !== null && now - row.lastUsedAt < GRANT_TOUCH_MS) return;
    this.deps.db.orm
      .update(accessGrant)
      .set({ lastUsedAt: now, lastUsedIp: ip })
      .where(
        and(
          eq(accessGrant.id, row.id),
          or(isNull(accessGrant.lastUsedAt), lt(accessGrant.lastUsedAt, now - GRANT_TOUCH_MS)),
        ),
      )
      .run();
  }

  private userActor(userId: string): Omit<Actor, 'via' | 'sessionId' | 'grant'> | null {
    const row = this.deps.db.orm
      .select({ email: user.email, emailVerified: user.emailVerified, disabledAt: user.disabledAt })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (row === undefined || row.disabledAt !== null) return null;
    return {
      userId,
      email: row.email,
      isAdmin: row.emailVerified && isAdminEmail(this.deps.config, row.email),
    };
  }

  /**
   * The actor of a better-auth session. A browser session (no grant) is accepted only from
   * its cookie, and a CLI device session (linked to a grant) only as a bearer token, so a
   * leaked cookie token is no unconstrained bearer credential and a device token never
   * passes for the browser. A revoked or expired grant, or a disabled user, is `null` (401).
   */
  resolveSession(
    userId: string,
    sessionId: string,
    via: ActorVia,
    ip: string | null,
  ): Actor | null {
    const base = this.userActor(userId);
    if (base === null) return null;
    const link = this.deps.db.orm
      .select({ grantId: session.grantId })
      .from(session)
      .where(eq(session.id, sessionId))
      .get();
    const grantId = link?.grantId ?? null;
    if ((grantId === null) !== (via === 'session')) return null;
    if (grantId === null) return { ...base, via, sessionId, grant: null };
    const now = this.now();
    const row = this.deps.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    if (!this.live(row, now) || row.userId !== userId) return null;
    this.touch(row, ip, now);
    return { ...base, via, sessionId, grant: this.toActorGrant(row) };
  }

  /** The actor of a PAT (`Authorization: Bearer rooster_pat_…`), by the key's hash. */
  resolvePat(hash: string, ip: string | null): Actor | null {
    const now = this.now();
    const key = this.deps.db.orm.select().from(apikey).where(eq(apikey.key, hash)).get();
    if (key === undefined || key.enabled === false) return null;
    if (key.expiresAt !== null && key.expiresAt.getTime() <= now) return null;
    let grantId: unknown;
    try {
      grantId = (JSON.parse(key.metadata ?? '{}') as { grantId?: unknown }).grantId;
    } catch {
      return null;
    }
    if (typeof grantId !== 'string') return null;
    const row = this.deps.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    if (!this.live(row, now) || row.kind !== 'pat' || row.userId !== key.referenceId) return null;
    const base = this.userActor(row.userId);
    if (base === null) return null;
    this.touch(row, ip, now);
    return { ...base, via: 'pat', sessionId: row.id, grant: this.toActorGrant(row) };
  }

  /**
   * The actor of an OAuth access token (`rooster_at_…`) at `resource` (11 §4.3): the hashed
   * token must exist, be unexpired and unrevoked, be bound to exactly this resource, and point
   * (`referenceId`) at a live OAuth grant of the same user and client. Scopes and constraints
   * are the grant's, read on every request. Null answers `401`.
   */
  resolveOAuthToken(token: string, resource: OAuthResource, ip: string | null): Actor | null {
    if (!token.startsWith(OAUTH_ACCESS_PREFIX)) return null;
    const now = this.now();
    const db = this.deps.db.orm;
    const hash = hashOAuthToken(token.slice(OAUTH_ACCESS_PREFIX.length));
    const row = db.select().from(oauthAccessToken).where(eq(oauthAccessToken.token, hash)).get();
    if (row === undefined || row.revoked !== null || row.expiresAt === null) return null;
    if (row.expiresAt.getTime() <= now || row.referenceId === null) return null;
    // Sender-constrained (DPoP) tokens are never issued here; one that is bound fails closed
    // rather than working as a plain bearer token.
    if (isBound(row.confirmation)) return null;
    const resources = jsonList(row.resources);
    if (resources.length !== 1 || resources[0] !== resourceUri(this.deps.config, resource)) {
      return null;
    }
    const grant = db.select().from(accessGrant).where(eq(accessGrant.id, row.referenceId)).get();
    if (!this.live(grant, now) || grant.kind !== 'oauth') return null;
    if (grant.userId !== row.userId || grant.clientId !== row.clientId) return null;
    if (
      grant.idleTimeoutMs !== null &&
      now - (row.createdAt?.getTime() ?? 0) > grant.idleTimeoutMs
    ) {
      return null;
    }
    const base = this.userActor(grant.userId);
    if (base === null) return null;
    this.touch(grant, ip, now);
    return {
      ...base,
      via: 'oauth',
      sessionId: grant.id,
      grant: { ...this.toActorGrant(grant), resource, oauthTokenId: row.id },
    };
  }

  /**
   * Whether every scope of a refresh request's `scope` is within the grant (implied scopes
   * spelled out, as token responses report them, plus `offline_access`).
   */
  oauthScopeCovered(grantId: string, scope: string): boolean {
    const row = this.deps.db.orm
      .select({ scopes: accessGrant.scopes })
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    if (row === undefined) return false;
    const covered = expandScopes(parseScopes(row.scopes));
    return scope
      .split(' ')
      .filter((s) => s !== '')
      .every(
        (s) =>
          s === 'offline_access' ||
          (isGrantScope(s) && !OAUTH_EXCLUDED_SCOPES.includes(s) && covered.has(s)),
      );
  }

  /** Whether an access token row is still usable (an OAuth event stream's heartbeat). */
  private oauthTokenActive(tokenId: string): boolean {
    const row = this.deps.db.orm
      .select({ revoked: oauthAccessToken.revoked, expiresAt: oauthAccessToken.expiresAt })
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.id, tokenId))
      .get();
    return (
      row !== undefined &&
      row.revoked === null &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() > this.now()
    );
  }

  /**
   * The `scope` a token response reports: what the grant allows now (implied scopes spelled
   * out), plus `offline_access` when a refresh token comes with it. The provider would report
   * the requested scopes, which the user may have narrowed (ADR 0041).
   */
  oauthTokenScope(grantId: string, withRefresh: boolean): string | null {
    const row = this.deps.db.orm
      .select({ scopes: accessGrant.scopes })
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    if (row === undefined) return null;
    const covered = expandScopes(parseScopes(row.scopes));
    const scopes: string[] = ALL_OAUTH_SCOPES.filter((s) => covered.has(s));
    return [...scopes, ...(withRefresh ? ['offline_access'] : [])].join(' ');
  }

  /**
   * The protected resources (RFC 8707) as the provider's `oauthResource` rows: `<base>/mcp` and
   * `<base>/api/v1`, with the access token lifetime. Rows of an earlier base URL are disabled,
   * so no new token names them. Run once when the auth instance is built; a database without
   * the table (not migrated yet) is skipped.
   */
  seedOAuthResources(accessTokenTtlS: number): void {
    const resources = (['mcp', 'api'] as const).map((r) => ({
      identifier: resourceUri(this.deps.config, r),
      name: r === 'mcp' ? 'rooster MCP' : 'rooster API',
    }));
    try {
      immediate(this.deps.db, (tx) => {
        const now = new Date(this.now());
        const ours = resources.map((r) => r.identifier);
        tx.update(oauthResource)
          .set({ disabled: true, updatedAt: now })
          .where(and(notInArray(oauthResource.identifier, ours), eq(oauthResource.disabled, false)))
          .run();
        for (const r of resources) {
          tx.insert(oauthResource)
            .values({
              id: uuidv7(),
              ...r,
              accessTokenTtl: accessTokenTtlS,
              disabled: false,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: oauthResource.identifier,
              set: {
                name: r.name,
                accessTokenTtl: accessTokenTtlS,
                disabled: false,
                updatedAt: now,
              },
            })
            .run();
        }
      });
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      if (!/no such table/i.test(`${String(error)} ${String(cause)}`)) throw error;
    }
  }

  /** The user's live OAuth grant for a client, if any (the provider's consent handoff). */
  liveOAuthGrantId(userId: string, clientId: string): string | null {
    const row = this.deps.db.orm
      .select()
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.userId, userId),
          eq(accessGrant.clientId, clientId),
          eq(accessGrant.kind, 'oauth'),
          isNull(accessGrant.revokedAt),
        ),
      )
      .get();
    return this.liveOAuth(row, this.now()) ? row.id : null;
  }

  /**
   * `POST /api/auth/oauth2/token` with `grant_type=authorization_code`, before the provider
   * redeems the code: the code must carry a live OAuth grant of its user and client. A code
   * without one means the grant handoff failed, which must never mint a token.
   */
  checkOAuthCode(code: string): OAuthTokenCheck {
    const value = readOnly(this.deps.db, (tx) => authorizationCodeValue(tx, code));
    // Unknown or used codes are the provider's to answer (replay handling included).
    if (value === null) return { ok: true, grantId: null };
    const grantId = value.referenceId;
    if (typeof grantId !== 'string' || grantId === NO_GRANT_REFERENCE) {
      this.deps.logger.error('OAuth authorization code without a rooster grant');
      return { ok: false, description: 'The authorization has no grant; authorize again.' };
    }
    const row = this.deps.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    if (
      !this.liveOAuth(row, this.now()) ||
      row.userId !== value.userId ||
      row.clientId !== value.query?.client_id
    ) {
      return { ok: false, description: 'The authorization was revoked or has expired.' };
    }
    return { ok: true, grantId: row.id };
  }

  /**
   * `POST /api/auth/oauth2/token` with `grant_type=refresh_token`, before the provider rotates
   * it (11 §2.4, ADR 0041):
   * - a refresh token that was already rotated (or revoked) is reuse: the whole grant is
   *   revoked, with its tokens and consent;
   * - "this session only": once the grant has had no token activity for `idle_timeout_ms`, it
   *   ends; a stale refresh token of a grant still in use (another chain refreshed since) is only
   *   refused;
   * - a token whose grant is no longer live, or one bound to a key (DPoP), is refused.
   * The caller serialises this check and the provider's rotation per token (auth/mount.ts).
   */
  checkOAuthRefresh(refreshToken: string): OAuthTokenCheck {
    if (!refreshToken.startsWith(OAUTH_REFRESH_PREFIX)) return { ok: true, grantId: null };
    const now = this.now();
    const hash = hashOAuthToken(refreshToken.slice(OAUTH_REFRESH_PREFIX.length));
    const row = this.deps.db.orm
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.token, hash))
      .get();
    if (row === undefined) return { ok: true, grantId: null };
    const grant =
      row.referenceId === null
        ? undefined
        : this.deps.db.orm
            .select()
            .from(accessGrant)
            .where(eq(accessGrant.id, row.referenceId))
            .get();
    if (row.revoked !== null) {
      this.deps.logger.warn(
        { grantId: grant?.id ?? null },
        'OAuth refresh token reused: revoking the grant',
      );
      this.revokeOAuthGrant(grant, row.referenceId);
      return { ok: false, description: 'The refresh token was already used; authorize again.' };
    }
    if (grant === undefined || !this.live(grant, now) || grant.kind !== 'oauth') {
      return { ok: false, description: 'The authorization was revoked or has expired.' };
    }
    if (grant.userId !== row.userId || grant.clientId !== row.clientId) {
      return { ok: false, description: 'The authorization was revoked or has expired.' };
    }
    if (isBound(row.confirmation)) {
      return { ok: false, description: 'Sender-constrained tokens are not supported.' };
    }
    if (grant.idleTimeoutMs !== null) {
      if (this.idleExpired(grant, now)) {
        this.revokeOAuthGrant(grant, grant.id);
        return { ok: false, description: 'The session ended after a day without use.' };
      }
      if (now - (row.createdAt?.getTime() ?? 0) > grant.idleTimeoutMs) {
        return { ok: false, description: 'This refresh token went unused for too long.' };
      }
    }
    return { ok: true, grantId: grant.id };
  }

  /** Revokes an OAuth grant outside a user request (refresh reuse, idle expiry). */
  private revokeOAuthGrant(grant: GrantRow | undefined, referenceId: string | null): void {
    immediate(this.deps.db, (tx) => {
      const ids = [grant?.id ?? referenceId].filter((id): id is string => typeof id === 'string');
      deleteGrantArtifacts(tx, ids);
      if (grant === undefined || grant.revokedAt !== null) return;
      const now = this.now();
      tx.update(accessGrant)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(accessGrant.id, grant.id))
        .run();
      this.emitGrants(tx, grant.userId, grant.id, [grant.id]);
    });
  }

  /** Whether a grant still authorises its stream (checked on every SSE heartbeat). */
  private grantActive(grantId: string, userId: string): boolean {
    const row = this.deps.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    const now = this.now();
    return (
      this.live(row, now) &&
      (row.kind !== 'oauth' || !this.idleExpired(row, now)) &&
      row.userId === userId &&
      this.userActor(userId) !== null
    );
  }

  streamAccess(actor: Actor): StreamAccess {
    const { userId, sessionId, grant } = actor;
    if (grant === null) {
      return { sessionId, isValid: () => this.sessionActive(userId, sessionId) };
    }
    const reads = hasScope(grant.scopes, 'notifications:read');
    const orgs = grant.constraints.orgs;
    return {
      sessionId,
      restrictedOrgs:
        orgs === 'all' ? [] : orgs.filter((o) => o.read !== 'all').map((o) => o.orgId),
      isValid: () =>
        this.grantActive(grant.id, userId) &&
        (grant.oauthTokenId === undefined || this.oauthTokenActive(grant.oauthTokenId)) &&
        (actor.via === 'pat' || actor.via === 'oauth' || this.sessionActive(userId, sessionId)),
      filterKeys: (org, keys, prior) =>
        readOnly(this.deps.db, (tx) => visibleKeys(tx, actor, org, keys, prior)),
      // The count is recomputed for the orgs the grant reaches; a new notification elsewhere
      // is not news to it (11 §2.3).
      notification: (data) => {
        if (!reads) return null;
        const message = data as SseNotification;
        const preview = message.notification;
        if (
          preview !== null &&
          !readOnly(this.deps.db, (tx) => canReadNotification(tx, actor, preview))
        ) {
          return null;
        }
        return { ...message, unreadCount: this.unreadCount(actor) };
      },
    };
  }

  // --- Connected apps (11 §3.2) ----------------------------------------------------------------

  private clientOf(tx: Tx, clientId: string): Grant['client'] {
    const client = findClient(tx, clientId);
    return client === undefined ? null : clientInfo(client);
  }

  private toDto(tx: Tx, actor: Actor, row: GrantRow): Grant {
    const key =
      row.kind === 'pat'
        ? tx
            .select({ start: apikey.start })
            .from(apikey)
            .where(sql`json_extract(${apikey.metadata}, '$.grantId') = ${row.id}`)
            .get()
        : undefined;
    return {
      id: row.id,
      kind: row.kind,
      clientId: row.clientId,
      label: row.label,
      scopes: minimalScopes(parseScopes(row.scopes)),
      constraints: parseConstraints(row.constraints) as Grant['constraints'],
      tokenPrefix: key?.start ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
      idleTimeoutMs: row.idleTimeoutMs,
      client:
        row.kind === 'oauth' && row.clientId !== null ? this.clientOf(tx, row.clientId) : null,
      lastUsedAt: row.lastUsedAt,
      lastUsedIp: row.lastUsedIp,
      current: actor.grant?.id === row.id,
    };
  }

  /**
   * Every live (unrevoked) grant of the user, newest first; expired ones are listed until
   * revoked. The browser session sees all; a CLI device or PAT may list too (`rooster token
   * ls`, `apps ls`). An OAuth app sees only its own grant: the user's other tokens and apps
   * are none of its business (06 §2.1 lists the exception for PATs and devices only).
   */
  list(actor: Actor): Grant[] {
    const onlyOwn = actor.grant?.kind === 'oauth' ? actor.grant.id : undefined;
    return readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(accessGrant)
        .where(
          and(
            eq(accessGrant.userId, actor.userId),
            isNull(accessGrant.revokedAt),
            onlyOwn === undefined ? undefined : eq(accessGrant.id, onlyOwn),
          ),
        )
        .orderBy(desc(accessGrant.createdAt), desc(accessGrant.id))
        .all()
        .map((row) => this.toDto(tx, actor, row)),
    );
  }

  private requireOwn(tx: Tx, actor: Actor, id: string): GrantRow {
    const row = tx.select().from(accessGrant).where(eq(accessGrant.id, id)).get();
    if (row === undefined || row.userId !== actor.userId || row.revokedAt !== null) {
      throw grantNotFound();
    }
    return row;
  }

  /**
   * Orgs must be the user's live memberships and groups the user's own live groups in that
   * org; anything else is `422 validation_failed`.
   */
  private validateConstraints(tx: Tx, userId: string, constraints: GrantConstraints): void {
    if (constraints.orgs === 'all') return;
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    constraints.orgs.forEach((org, i) => {
      const path = `constraints.orgs.${i}`;
      if (seen.has(org.orgId)) errors.push({ path: `${path}.orgId`, message: 'Listed twice' });
      seen.add(org.orgId);
      const membership = tx
        .select({ id: member.id })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(
            eq(member.userId, userId),
            eq(member.organizationId, org.orgId),
            isNull(organization.deletedAt),
          ),
        )
        .get();
      if (membership === undefined) {
        errors.push({ path: `${path}.orgId`, message: 'Not one of your organisations' });
        return;
      }
      const lists: [string, readonly string[]][] = [];
      if (org.read !== 'all') lists.push(['read', org.read.groups]);
      if (org.write !== 'all' && org.write !== 'none') lists.push(['write', org.write.groups]);
      for (const [field, groups] of lists) {
        const found = new Set(
          tx
            .select({ id: taskGroup.id })
            .from(taskGroup)
            .where(
              and(
                inArray(taskGroup.id, [...groups]),
                eq(taskGroup.userId, userId),
                eq(taskGroup.orgId, org.orgId),
                isNull(taskGroup.deletedAt),
              ),
            )
            .all()
            .map((g) => g.id),
        );
        groups.forEach((g, j) => {
          if (!found.has(g)) {
            errors.push({
              path: `${path}.${field}.groups.${j}`,
              message: 'Not one of your groups here',
            });
          }
        });
      }
    });
    if (errors.length > 0) {
      throw new AppError(
        'validation_failed',
        422,
        'The constraints name unknown orgs or groups.',
        errors,
      );
    }
  }

  private insertGrant(
    tx: Tx,
    input: {
      userId: string;
      kind: GrantKind;
      clientId: string | null;
      label: string;
      scopes: readonly GrantScope[];
      constraints: GrantConstraints;
      expiresInDays?: number | undefined;
      createdByGrantId?: string | null;
      idleTimeoutMs?: number | null;
    },
  ): GrantRow {
    const now = this.now();
    const row: GrantRow = {
      id: uuidv7(),
      userId: input.userId,
      kind: input.kind,
      clientId: input.clientId,
      label: input.label,
      scopes: minimalScopes(input.scopes).join(' '),
      constraints: JSON.stringify(input.constraints),
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresInDays === undefined ? null : now + input.expiresInDays * DAY_MS,
      revokedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdByGrantId: input.createdByGrantId ?? null,
      idleTimeoutMs: input.idleTimeoutMs ?? null,
    };
    tx.insert(accessGrant).values(row).run();
    return row;
  }

  private emitGrants(tx: Tx, userId: string, grantId: string, ended: readonly string[] = []): void {
    emitAfterCommit(this.deps, tx, {
      // Grant changes are user-level, like settings.
      type: 'user.updated',
      orgId: null,
      actorId: userId,
      subjects: [grantId],
      audiences: [selfAudience(userId, null, [[...GRANTS_KEY]])],
    });
    if (ended.length > 0) {
      // Streams opened with the grant reconnect (and see the new constraints) or end.
      emitAfterCommit(this.deps, tx, {
        type: 'session.ended',
        orgId: null,
        actorId: userId,
        subjects: [...ended],
        audiences: [],
      });
    }
  }

  private sessionsOf(tx: Tx, grantId: string): string[] {
    return tx
      .select({ id: session.id })
      .from(session)
      .where(eq(session.grantId, grantId))
      .all()
      .map((s) => s.id);
  }

  /**
   * PATCH /me/grants/:id (browser session only). PATs and devices change freely; an OAuth
   * client's scopes, constraints and expiry may only narrow (`422 widening_not_allowed`).
   * Takes effect on the next request; open streams of the grant reconnect.
   */
  patch(actor: Actor, id: string, patch: GrantPatch): Grant {
    requireBrowserSession(actor);
    return immediate(this.deps.db, (tx) => {
      const row = this.requireOwn(tx, actor, id);
      const changes: Partial<GrantRow> = {};
      const currentScopes = parseScopes(row.scopes);
      const currentConstraints = parseConstraints(row.constraints);
      if (patch.constraints !== undefined) {
        this.validateConstraints(tx, actor.userId, patch.constraints);
      }
      if (
        patch.scopes?.includes(ADMIN_SCOPE) === true &&
        !currentScopes.includes(ADMIN_SCOPE) &&
        !actor.isAdmin
      ) {
        throw adminOnly();
      }
      if (row.kind === 'oauth') {
        const widened: string[] = [];
        if (patch.scopes !== undefined) {
          const allowed = expandScopes(currentScopes);
          if ([...expandScopes(patch.scopes)].some((s) => !allowed.has(s))) widened.push('scopes');
        }
        if (
          patch.constraints !== undefined &&
          !isNarrowing(currentConstraints, patch.constraints)
        ) {
          widened.push('constraints');
        }
        if (
          patch.expiresAt !== undefined &&
          row.expiresAt !== null &&
          (patch.expiresAt === null || patch.expiresAt > row.expiresAt)
        ) {
          widened.push('expiresAt');
        }
        if (widened.length > 0) {
          throw new AppError(
            'widening_not_allowed',
            422,
            "An app's access can only be narrowed here; reconnect the app to widen it.",
            widened.map((path) => ({ path, message: 'Wider than what the app was granted' })),
          );
        }
      }
      if (patch.label !== undefined) changes.label = patch.label;
      if (patch.scopes !== undefined) changes.scopes = minimalScopes(patch.scopes).join(' ');
      if (patch.constraints !== undefined) changes.constraints = JSON.stringify(patch.constraints);
      if (patch.expiresAt !== undefined) changes.expiresAt = patch.expiresAt;
      changes.updatedAt = this.now();
      tx.update(accessGrant).set(changes).where(eq(accessGrant.id, row.id)).run();
      // Narrowed app scopes: the provider's consent forgets the rest, so asking for them again
      // shows the consent screen instead of silently minting a token without them.
      if (row.kind === 'oauth' && changes.scopes !== undefined) {
        this.syncConsentScopes(tx, row.id, parseScopes(changes.scopes));
      }
      const next = { ...row, ...changes };
      const access = changes.scopes !== undefined || changes.constraints !== undefined;
      this.emitGrants(
        tx,
        actor.userId,
        row.id,
        access ? [row.id, ...this.sessionsOf(tx, row.id)] : [],
      );
      return this.toDto(tx, actor, next);
    });
  }

  /**
   * DELETE /me/grants/:id: revokes the grant and deletes what points at it (the PAT, the device
   * session). The browser session may revoke any of the user's grants; a CLI device or PAT
   * only its own (`rooster logout`, `rooster token revoke` of the token in use).
   */
  revoke(actor: Actor, id: string): void {
    if (actor.grant !== null && actor.grant.id !== id) requireBrowserSession(actor);
    immediate(this.deps.db, (tx) => {
      const row = this.requireOwn(tx, actor, id);
      const now = this.now();
      tx.update(accessGrant)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(accessGrant.id, row.id))
        .run();
      const sessions = this.sessionsOf(tx, row.id);
      if (sessions.length > 0) tx.delete(session).where(inArray(session.id, sessions)).run();
      tx.delete(apikey).where(sql`json_extract(${apikey.metadata}, '$.grantId') = ${row.id}`).run();
      // An app's tokens, consent and pending codes go with it (ADR 0041).
      if (row.kind === 'oauth') deleteGrantArtifacts(tx, [row.id]);
      this.emitGrants(tx, actor.userId, row.id, [row.id, ...sessions]);
    });
  }

  /**
   * POST /me/tokens: a PAT with its grant; the token is shown once. The browser session may
   * create any PAT. A CLI device (`rooster token create`, 07 §4) may create one within its own
   * grant: scopes it has, narrower constraints, and an expiry no later than its own (else
   * `422 widening_not_allowed`); the PAT records `createdByGrantId` and outlives a revoke of
   * its creator. A PAT cannot mint PATs (`403 forbidden_scope`).
   */
  async createToken(actor: Actor, input: TokenCreate): Promise<TokenCreated> {
    if (actor.grant !== null && actor.grant.kind !== 'device') requireBrowserSession(actor);
    // `admin` only from an instance admin (ADR 0042 §1); a device must also hold it itself.
    if (input.scopes.includes(ADMIN_SCOPE) && !actor.isAdmin) throw adminOnly();
    const minted = await mintToken();
    return immediate(this.deps.db, (tx) => {
      this.validateConstraints(tx, actor.userId, input.constraints);
      const expiresAt =
        input.expiresInDays === undefined ? null : this.now() + input.expiresInDays * DAY_MS;
      if (actor.grant !== null) this.requireSubset(tx, actor.grant, input, expiresAt);
      const row = this.insertGrant(tx, {
        userId: actor.userId,
        kind: 'pat',
        clientId: null,
        label: input.name,
        scopes: input.scopes,
        constraints: input.constraints,
        expiresInDays: input.expiresInDays,
        createdByGrantId: actor.grant?.id ?? null,
      });
      const now = new Date(this.now());
      // The `@better-auth/api-key` row (its defaults; per-key rate limits off: the API's
      // per-user limit applies). Its expiry stays null: the grant's governs.
      tx.insert(apikey)
        .values({
          id: uuidv7(),
          configId: 'default',
          name: input.name,
          start: minted.start,
          referenceId: actor.userId,
          prefix: PAT_PREFIX,
          key: minted.hash,
          enabled: true,
          rateLimitEnabled: false,
          requestCount: 0,
          createdAt: now,
          updatedAt: now,
          metadata: JSON.stringify({ grantId: row.id }),
        })
        .run();
      this.emitGrants(tx, actor.userId, row.id);
      return { token: minted.token, grant: this.toDto(tx, actor, row) };
    });
  }

  /** A token minted by a grant gives at most what the grant has (11 §2). */
  private requireSubset(
    tx: Tx,
    creator: ActorGrant,
    input: TokenCreate,
    expiresAt: number | null,
  ): void {
    const widened: FieldError[] = [];
    const allowed = expandScopes(creator.scopes);
    if ([...expandScopes(input.scopes)].some((s) => !allowed.has(s))) {
      widened.push({ path: 'scopes', message: 'Wider than this device was granted' });
    }
    if (!isNarrowing(creator.constraints, input.constraints)) {
      widened.push({ path: 'constraints', message: 'Wider than this device was granted' });
    }
    const limit = tx
      .select({ expiresAt: accessGrant.expiresAt })
      .from(accessGrant)
      .where(eq(accessGrant.id, creator.id))
      .get()?.expiresAt;
    if (limit != null && (expiresAt === null || expiresAt > limit)) {
      widened.push({ path: 'expiresInDays', message: 'Later than this device’s own expiry' });
    }
    if (widened.length > 0) {
      throw new AppError(
        'widening_not_allowed',
        422,
        'A token made from the CLI can have at most the access of the CLI itself.',
        widened,
      );
    }
  }

  // --- device approval (07 §2, ADR 0036 §6) ----------------------------------------------------

  private pendingDevice(tx: Tx, actor: Actor, userCode: string) {
    const wanted = normalizeUserCode(userCode);
    const row = tx
      .select()
      .from(deviceCode)
      .where(or(eq(deviceCode.userCode, userCode), eq(deviceCode.userCode, wanted)))
      .get();
    if (
      row === undefined ||
      row.status !== 'pending' ||
      row.expiresAt.getTime() <= this.now() ||
      (row.userId !== null && row.userId !== actor.userId)
    ) {
      throw deviceNotFound();
    }
    return row;
  }

  /**
   * What a device asked for: everything when it named nothing. `admin` stays only for instance
   * admins; anyone else's request loses it silently (ADR 0042 §1).
   */
  private requestedScopes(actor: Actor, scope: string | null): GrantScope[] {
    const scopes = parseScopes(scope);
    const requested = scopes.length > 0 ? scopes : [...GRANT_SCOPES];
    return actor.isAdmin ? requested : requested.filter((s) => s !== ADMIN_SCOPE);
  }

  /** GET /device/:userCode: what the CLI asks for, before the user approves (11 §3.1). */
  deviceRequest(actor: Actor, userCode: string): DeviceRequest {
    requireBrowserSession(actor);
    return readOnly(this.deps.db, (tx) => {
      const row = this.pendingDevice(tx, actor, userCode);
      return {
        userCode: row.userCode,
        clientId: row.clientId ?? CLI_CLIENT_ID,
        clientName: CLI_CLIENT_NAME,
        requestedScopes: minimalScopes(this.requestedScopes(actor, row.scope)),
        expiresAt: row.expiresAt.getTime(),
      };
    });
  }

  /**
   * POST /device/:userCode/approve: creates the device grant (scopes no wider than requested,
   * `422 widening_not_allowed`) and marks the code approved with it. The CLI's next poll of
   * `/api/auth/device/token` gets a bearer session linked to the grant (auth.ts).
   */
  approveDevice(actor: Actor, userCode: string, input: DeviceApprove): Grant {
    requireBrowserSession(actor);
    return immediate(this.deps.db, (tx) => {
      const row = this.pendingDevice(tx, actor, userCode);
      const requested = expandScopes(this.requestedScopes(actor, row.scope));
      // A non-admin's `admin` is dropped, not refused (ADR 0042 §1).
      const scopes = actor.isAdmin ? input.scopes : input.scopes.filter((s) => s !== ADMIN_SCOPE);
      if (scopes.length === 0) {
        throw new AppError('validation_failed', 422, 'Approve at least one capability.', [
          { path: 'scopes', message: 'Nothing left to approve' },
        ]);
      }
      if ([...expandScopes(scopes)].some((s) => !requested.has(s))) {
        throw new AppError('widening_not_allowed', 422, 'Approve at most what the CLI asked for.', [
          { path: 'scopes', message: 'Not requested by the device' },
        ]);
      }
      this.validateConstraints(tx, actor.userId, input.constraints);
      const grant = this.insertGrant(tx, {
        userId: actor.userId,
        kind: 'device',
        clientId: row.clientId ?? CLI_CLIENT_ID,
        label: input.label ?? deviceLabel(row.userAgent),
        scopes,
        constraints: input.constraints,
        expiresInDays: input.expiresInDays,
      });
      tx.update(deviceCode)
        .set({
          status: 'approved',
          userId: actor.userId,
          grantId: grant.id,
          // The token response echoes it, so the CLI learns what was approved.
          scope: grant.scopes,
        })
        .where(eq(deviceCode.id, row.id))
        .run();
      this.emitGrants(tx, actor.userId, grant.id);
      return this.toDto(tx, actor, grant);
    });
  }

  /** POST /device/:userCode/deny: the CLI's next poll gets `access_denied`. */
  denyDevice(actor: Actor, userCode: string): void {
    requireBrowserSession(actor);
    immediate(this.deps.db, (tx) => {
      const row = this.pendingDevice(tx, actor, userCode);
      tx.update(deviceCode)
        .set({ status: 'denied', userId: actor.userId })
        .where(eq(deviceCode.id, row.id))
        .run();
    });
  }

  // --- OAuth consent (11 §3.1, ADR 0041, ADR 0042 §4) ------------------------------------------

  /**
   * The authorization request behind a verified `oauth_query`: its client (already resolved by
   * the provider, so in `oauthClient`), redirect URI, the one resource and the requested
   * scopes. Anything else is the "unknown or expired" `404`.
   */
  private consentQuery(tx: Tx, query: URLSearchParams | null) {
    if (query === null) throw consentNotFound();
    const clientId = query.get('client_id');
    const client = clientId === null ? undefined : findClient(tx, clientId);
    const resources = query.getAll('resource');
    const resource = resources.length === 1 ? (resources[0] as string) : null;
    if (
      clientId === null ||
      client === undefined ||
      client.disabled === true ||
      resource === null ||
      resourceOf(this.deps.config, resource) === null
    ) {
      throw consentNotFound();
    }
    const literal = (query.get('scope') ?? '').split(' ').filter((s) => s !== '');
    const scopes = ALL_OAUTH_SCOPES.filter((s) => literal.includes(s));
    return {
      clientId,
      client,
      redirectUri: query.get('redirect_uri') ?? '',
      resource,
      literal,
      scopes,
      authorizationDetails: query.get('authorization_details'),
    };
  }

  /** The user's unrevoked OAuth grant for a client (live or not). */
  private oauthRow(tx: Tx, userId: string, clientId: string): GrantRow | undefined {
    return tx
      .select()
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.userId, userId),
          eq(accessGrant.clientId, clientId),
          eq(accessGrant.kind, 'oauth'),
          isNull(accessGrant.revokedAt),
        ),
      )
      .get();
  }

  /**
   * RFC 9396 `authorization_details` of type `rooster_access` pre-fill the constraints (never
   * scopes, so never `tasks:delete`). Unreadable or foreign orgs and groups: no pre-fill.
   */
  private consentPrefill(
    tx: Tx,
    userId: string,
    raw: string | null,
  ): OAuthConsentRequest['prefill'] {
    if (raw === null || raw.length > 8192) return null;
    let details: unknown;
    try {
      details = JSON.parse(raw);
    } catch {
      return null;
    }
    const entry = (Array.isArray(details) ? details : []).find(
      (d): d is Record<string, unknown> =>
        d !== null && typeof d === 'object' && (d as { type?: unknown }).type === 'rooster_access',
    );
    if (entry === undefined) return null;
    const parsed = grantConstraintsSchema.safeParse({ orgs: entry.orgs });
    if (!parsed.success) return null;
    try {
      this.validateConstraints(tx, userId, parsed.data);
    } catch {
      return null;
    }
    return parsed.data;
  }

  /**
   * The grant with its constraints reduced to orgs and groups that still exist for the user
   * (a deleted group, a left org), so the step-up pre-fill is always a valid decision. An org
   * whose read list empties is dropped (reading nothing there); a write list that empties is
   * `none`. If no org would remain, the constraints stay as they are.
   */
  private withLiveConstraints(tx: Tx, userId: string, grant: Grant): Grant {
    const orgs = grant.constraints.orgs;
    if (orgs === 'all') return grant;
    const memberOf = new Set(
      tx
        .select({ orgId: member.organizationId })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(and(eq(member.userId, userId), isNull(organization.deletedAt)))
        .all()
        .map((m) => m.orgId),
    );
    const liveGroups = (orgId: string, groups: readonly string[]) => {
      if (groups.length === 0) return [];
      const found = new Set(
        tx
          .select({ id: taskGroup.id })
          .from(taskGroup)
          .where(
            and(
              inArray(taskGroup.id, [...groups]),
              eq(taskGroup.userId, userId),
              eq(taskGroup.orgId, orgId),
              isNull(taskGroup.deletedAt),
            ),
          )
          .all()
          .map((g) => g.id),
      );
      return groups.filter((g) => found.has(g));
    };
    const pruned = orgs.flatMap((org) => {
      if (!memberOf.has(org.orgId)) return [];
      let read: typeof org.read = org.read;
      if (read !== 'all') {
        const groups = liveGroups(org.orgId, read.groups);
        if (groups.length === 0) return [];
        read = { groups };
      }
      let write: typeof org.write = org.write;
      if (write !== 'all' && write !== 'none') {
        const groups = liveGroups(org.orgId, write.groups);
        write = groups.length === 0 ? 'none' : { groups };
      }
      return [{ orgId: org.orgId, read, write }];
    });
    return pruned.length === 0 ? grant : { ...grant, constraints: { orgs: pruned } };
  }

  /**
   * GET /oauth/consent: what the consent screen shows (11 §3.1). `query` is the provider's
   * signed query without its signature fields, or null when the signature or its expiry failed
   * (the route verifies it).
   */
  oauthConsentRequest(
    actor: Actor,
    oauthQuery: string,
    query: URLSearchParams | null,
  ): OAuthConsentRequest {
    requireBrowserSession(actor);
    return readOnly(this.deps.db, (tx) => {
      const req = this.consentQuery(tx, query);
      this.rememberConsentView(actor, oauthQuery);
      const row = this.oauthRow(tx, actor.userId, req.clientId);
      const existing = this.liveOAuth(row, this.now()) ? row : undefined;
      const have = expandScopes(existing === undefined ? [] : parseScopes(existing.scopes));
      return {
        oauthQuery,
        clientId: req.clientId,
        client: clientInfo(req.client, req.redirectUri),
        redirectUri: req.redirectUri,
        loopback: isLoopbackRedirect(req.redirectUri),
        resource: req.resource,
        requestedScopes: req.scopes,
        // Step-up only: a first request has nothing to be "new" against.
        newScopes: existing === undefined ? [] : req.scopes.filter((s) => !have.has(s)),
        existing:
          existing === undefined
            ? null
            : this.withLiveConstraints(tx, actor.userId, this.toDto(tx, actor, existing)),
        prefill: this.consentPrefill(tx, actor.userId, req.authorizationDetails),
      };
    });
  }

  /**
   * POST /oauth/consent, Allow: creates the user's grant for the client, or updates the live one
   * (step-up keeps what it had and adds what was approved now). Scopes are those approved and
   * requested (implied ones count), minus `OAUTH_EXCLUDED_SCOPES`; `tasks:delete` needs both the
   * request and the user's tick. "This session only" is an idle timeout instead of an expiry.
   * The caller then answers the provider within the grant handoff, and calls
   * `finishOAuthConsent` (or `undoOAuthConsent` if the provider failed), one decision of the
   * user at a time. Only the session the request was displayed to may decide it, and never
   * wider than the client's `authorization_details` (11 §2.2).
   */
  applyOAuthConsent(
    actor: Actor,
    query: URLSearchParams | null,
    decision: Extract<OAuthConsentDecision, { accept: true }>,
  ): PreparedConsent {
    requireBrowserSession(actor);
    return immediate(this.deps.db, (tx) => {
      const req = this.consentQuery(tx, query);
      this.requireConsentView(actor, decision.oauthQuery);
      const requested = expandScopes(req.scopes);
      // What the user approved, implied scopes included (the web sends a minimal set, e.g.
      // `tasks:delete` standing for writing and reading too), kept where the app asked for it
      // (implied scopes of the request count); `tasks:delete` only when asked for literally.
      const approved = [...expandScopes(decision.scopes)].filter(
        (s) =>
          !OAUTH_EXCLUDED_SCOPES.includes(s) &&
          requested.has(s) &&
          (s !== 'tasks:delete' || req.scopes.includes('tasks:delete')),
      );
      // Narrowing is the user's call: the grant holds exactly what was approved (implied
      // scopes of the request included), however little of the request that is.
      if (approved.length === 0) {
        throw new AppError(
          'nothing_approved',
          422,
          'Choose at least one thing the app may do, or deny it.',
        );
      }
      this.validateConstraints(tx, actor.userId, decision.constraints);
      // The client's `authorization_details` are a ceiling the user may narrow, never widen
      // (11 §2.2, ADR 0046): the screen pre-fills them; the service enforces them.
      const ceiling = this.consentPrefill(tx, actor.userId, req.authorizationDetails);
      if (ceiling !== null && !isNarrowing(ceiling, decision.constraints)) {
        throw new AppError(
          'widening_not_allowed',
          422,
          'The app asked for less access than that; choose within what it asked for.',
        );
      }
      const now = this.now();
      const current = this.oauthRow(tx, actor.userId, req.clientId);
      const live = this.liveOAuth(current, now) ? current : undefined;
      const scopes = minimalScopes([...approved, ...(live ? parseScopes(live.scopes) : [])]);
      const covered = expandScopes(scopes);
      // The provider's consent may name only requested scopes: those the grant covers. When it
      // covers none of them literally (read approved for a write request), the provider records
      // the request as is; `finishOAuthConsent` then rewrites the consent to the grant, and token
      // responses report the grant's scopes (auth/mount.ts), which are what is enforced.
      const pluginScopes = req.literal.filter(
        (s) => s === 'offline_access' || covered.has(s as GrantScope),
      );
      const sessionOnly = decision.sessionOnly === true;
      const fields = {
        label: clientInfo(req.client).name.slice(0, 100) || req.clientId.slice(0, 100),
        constraints: JSON.stringify(decision.constraints),
        expiresAt:
          sessionOnly || decision.expiresInDays === undefined
            ? null
            : now + decision.expiresInDays * DAY_MS,
        idleTimeoutMs: sessionOnly ? SESSION_ONLY_IDLE_MS : null,
      };
      let grantId: string;
      if (live !== undefined) {
        // Staged: written by `finishOAuthConsent` once the provider has issued the code.
        grantId = live.id;
      } else {
        if (current !== undefined) {
          // Expired or idle but never revoked: it gives way (one live grant per user and app).
          tx.update(accessGrant)
            .set({ revokedAt: now, updatedAt: now })
            .where(eq(accessGrant.id, current.id))
            .run();
          deleteGrantArtifacts(tx, [current.id]);
        }
        const row = this.insertGrant(tx, {
          userId: actor.userId,
          kind: 'oauth',
          clientId: req.clientId,
          label: fields.label,
          scopes,
          constraints: decision.constraints,
          expiresInDays: sessionOnly ? undefined : decision.expiresInDays,
          idleTimeoutMs: fields.idleTimeoutMs,
        });
        grantId = row.id;
      }
      deleteStaleConsents(tx, actor.userId, req.clientId, grantId);
      const consented = tx
        .select({ resources: oauthConsent.resources })
        .from(oauthConsent)
        .where(eq(oauthConsent.referenceId, grantId))
        .all()
        .flatMap((r) => jsonList(r.resources));
      if (live === undefined) this.emitGrants(tx, actor.userId, grantId, []);
      return {
        grantId,
        clientId: req.clientId,
        userId: actor.userId,
        created: live === undefined,
        stepUp: live === undefined ? null : { approved, fields },
        pluginScope: pluginScopes.join(' '),
        resources: [...new Set([...consented, req.resource])],
      };
    });
  }

  /**
   * POST /oauth/consent, Deny: only checks the request is the user's to answer (displayed to
   * this session).
   */
  checkOAuthDeny(actor: Actor, query: URLSearchParams | null, oauthQuery: string): void {
    requireBrowserSession(actor);
    readOnly(this.deps.db, (tx) => this.consentQuery(tx, query));
    this.requireConsentView(actor, oauthQuery);
  }

  /**
   * After the provider recorded the consent: its scopes become everything the grant covers
   * (so a later request for an implied scope skips the screen) and its resources every
   * resource consented so far (a client using both `/mcp` and `/api/v1` is asked once each).
   */
  finishOAuthConsent(prepared: PreparedConsent): void {
    immediate(this.deps.db, (tx) => {
      let row = tx.select().from(accessGrant).where(eq(accessGrant.id, prepared.grantId)).get();
      // Revoked meanwhile (by the user, or refresh-token reuse): it stays revoked, and the code
      // just issued cannot be redeemed (`checkOAuthCode`).
      if (row === undefined || row.revokedAt !== null) return;
      if (prepared.stepUp !== null) {
        // Step-up keeps what the grant has now (a concurrent narrowing included) and adds what
        // was approved.
        const scopes = minimalScopes([...prepared.stepUp.approved, ...parseScopes(row.scopes)]);
        const update = {
          ...prepared.stepUp.fields,
          scopes: scopes.join(' '),
          updatedAt: this.now(),
        };
        tx.update(accessGrant).set(update).where(eq(accessGrant.id, row.id)).run();
        row = { ...row, ...update };
        this.emitGrants(tx, prepared.userId, row.id, [row.id]);
      }
      this.syncConsentScopes(tx, row.id, parseScopes(row.scopes));
      tx.update(oauthConsent)
        .set({ resources: JSON.stringify(prepared.resources) })
        .where(eq(oauthConsent.referenceId, row.id))
        .run();
    });
  }

  /**
   * The provider failed after `applyOAuthConsent`: a grant the decision created goes; a step-up
   * was never written, so the grant is untouched.
   */
  undoOAuthConsent(actor: Actor, prepared: PreparedConsent): void {
    if (!prepared.created) return;
    immediate(this.deps.db, (tx) => {
      deleteGrantArtifacts(tx, [prepared.grantId]);
      tx.delete(accessGrant).where(eq(accessGrant.id, prepared.grantId)).run();
      this.emitGrants(tx, actor.userId, prepared.grantId, [prepared.grantId]);
    });
  }

  /** The consent rows of a grant name exactly what it covers (plus `offline_access` if given). */
  private syncConsentScopes(tx: Tx, grantId: string, scopes: readonly GrantScope[]): void {
    const covered = [...expandScopes(scopes)].filter((s) => !OAUTH_EXCLUDED_SCOPES.includes(s));
    for (const consent of tx
      .select()
      .from(oauthConsent)
      .where(eq(oauthConsent.referenceId, grantId))
      .all()) {
      const offline = jsonList(consent.scopes).includes('offline_access');
      tx.update(oauthConsent)
        .set({ scopes: JSON.stringify(offline ? [...covered, 'offline_access'] : covered) })
        .where(eq(oauthConsent.id, consent.id))
        .run();
    }
  }

  /**
   * The grant an approved device code carries, for the session its redemption creates; null
   * when it has none or it is no longer live (the session is then refused).
   */
  liveDeviceGrant(grantId: string | null | undefined, userId: string): string | null {
    if (grantId === null || grantId === undefined) return null;
    const row = this.deps.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    return this.live(row, this.now()) && row.userId === userId && row.kind === 'device'
      ? row.id
      : null;
  }
}
