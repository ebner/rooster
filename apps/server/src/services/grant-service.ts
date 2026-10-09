import { randomBytes } from 'node:crypto';
import { defaultKeyHasher } from '@better-auth/api-key';
import {
  expandScopes,
  GRANT_SCOPES,
  type GrantConstraints,
  type GrantScope,
  hasScope,
  isGrantScope,
  isNarrowing,
  minimalScopes,
} from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import type {
  DeviceApprove,
  DeviceRequest,
  Grant,
  GrantKind,
  GrantPatch,
  SseNotification,
  TokenCreate,
  TokenCreated,
} from '@rooster/core/schemas';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  accessGrant,
  apikey,
  deviceCode,
  member,
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

const DAY_MS = 86_400_000;
/** `last_used_at`/`last_used_ip` are written at most this often per grant (11 §2.4). */
export const GRANT_TOUCH_MS = 60_000;

/** The CLI's client id for the device flow (07 §2). */
export const CLI_CLIENT_ID = 'rooster-cli';
const CLI_CLIENT_NAME = 'rooster CLI';

/** PATs are `rooster_pat_` + 48 random letters and digits (04 §4.4). */
export const PAT_PREFIX = 'rooster_pat_';
const PAT_RANDOM_LENGTH = 48;
/** Stored in `apikey.start` and shown as `tokenPrefix` to tell tokens apart. */
const PAT_VISIBLE_LENGTH = PAT_PREFIX.length + 4;

/** The Settings → Connected apps query key (SSE contract, like `['me']`). */
export const GRANTS_KEY = ['grants'] as const;

type GrantRow = typeof accessGrant.$inferSelect;

const grantNotFound = () => new AppError('not_found', 404, 'Grant not found.');
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
    return {
      id: row.id,
      kind: row.kind,
      clientId: row.clientId,
      scopes: parseScopes(row.scopes),
      constraints: parseConstraints(row.constraints),
      updatedAt: row.updatedAt,
    };
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

  /** Whether a grant still authorises its stream (checked on every SSE heartbeat). */
  private grantActive(grantId: string, userId: string): boolean {
    const row = this.deps.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, grantId))
      .get();
    return this.live(row, this.now()) && row.userId === userId && this.userActor(userId) !== null;
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
        (actor.via === 'pat' || this.sessionActive(userId, sessionId)),
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
      // P9 (WP 9.3) fills these for OAuth grants.
      idleTimeoutMs: null,
      client: null,
      lastUsedAt: row.lastUsedAt,
      lastUsedIp: row.lastUsedIp,
      current: actor.grant?.id === row.id,
    };
  }

  /**
   * Every live (unrevoked) grant of the user, newest first; expired ones are listed until
   * revoked. The browser session sees all; a CLI device or PAT may list too (`rooster token
   * ls`, `apps ls`).
   */
  list(actor: Actor): Grant[] {
    return readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(accessGrant)
        .where(and(eq(accessGrant.userId, actor.userId), isNull(accessGrant.revokedAt)))
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
    };
    tx.insert(accessGrant).values(row).run();
    return row;
  }

  private emitGrants(tx: Tx, actor: Actor, grantId: string, ended: readonly string[] = []): void {
    emitAfterCommit(this.deps, tx, {
      // Grant changes are user-level, like settings.
      type: 'user.updated',
      orgId: null,
      actorId: actor.userId,
      subjects: [grantId],
      audiences: [selfAudience(actor.userId, null, [[...GRANTS_KEY]])],
    });
    if (ended.length > 0) {
      // Streams opened with the grant reconnect (and see the new constraints) or end.
      emitAfterCommit(this.deps, tx, {
        type: 'session.ended',
        orgId: null,
        actorId: actor.userId,
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
      const next = { ...row, ...changes };
      const access = changes.scopes !== undefined || changes.constraints !== undefined;
      this.emitGrants(tx, actor, row.id, access ? [row.id, ...this.sessionsOf(tx, row.id)] : []);
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
      this.emitGrants(tx, actor, row.id, [row.id, ...sessions]);
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
      this.emitGrants(tx, actor, row.id);
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

  private requestedScopes(scope: string | null): GrantScope[] {
    const scopes = parseScopes(scope);
    return scopes.length > 0 ? scopes : [...GRANT_SCOPES];
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
        requestedScopes: minimalScopes(this.requestedScopes(row.scope)),
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
      const requested = expandScopes(this.requestedScopes(row.scope));
      if ([...expandScopes(input.scopes)].some((s) => !requested.has(s))) {
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
        scopes: input.scopes,
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
      this.emitGrants(tx, actor, grant.id);
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
