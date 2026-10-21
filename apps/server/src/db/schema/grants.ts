import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';

// Phase 8 agent access (05 §3, 11 §2): the grant behind every PAT, CLI device session and
// (P9) OAuth client, plus the better-auth plugin tables that point at it.

/** One row per PAT, CLI device session or OAuth client authorization (11 §2). */
export const accessGrant = sqliteTable(
  'access_grant',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['pat', 'device', 'oauth'] }).notNull(),
    /** OAuth client id (a CIMD URL or `rooster-cli`); null for PATs. */
    clientId: text('client_id'),
    /** Shown in Settings → Connected apps. */
    label: text('label').notNull(),
    /** Space-separated capabilities (11 §2.1). */
    scopes: text('scopes').notNull(),
    /** JSON (11 §2.2). */
    constraints: text('constraints').notNull().default('{"orgs":"all"}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
    lastUsedAt: integer('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    /**
     * rooster's: the grant that minted this PAT (`rooster token create` from a CLI device);
     * revoking that grant leaves the PAT alone.
     */
    createdByGrantId: text('created_by_grant_id'),
    /**
     * P9 "This session only" (ADR 0041): an OAuth grant ends once its refresh token has gone
     * unused this long. Null: no idle limit.
     */
    idleTimeoutMs: integer('idle_timeout_ms'),
    /**
     * Phase 12 (11 §9.4): a CLI login through the OAuth device grant is bound to the resource it
     * asked for (`api` or `mcp`). Null for every other grant (a PAT's audience is in its key's
     * metadata, an OAuth app's tokens each carry their own resource).
     */
    audience: text('audience', { enum: ['api', 'mcp'] }),
  },
  (t) => [
    check('access_grant_kind', sql`kind IN ('pat','device','oauth')`),
    index('access_grant_user').on(t.userId).where(sql`revoked_at IS NULL`),
    uniqueIndex('access_grant_oauth')
      .on(t.userId, t.clientId)
      .where(sql`kind = 'oauth' AND revoked_at IS NULL`),
  ],
);

/**
 * PATs (`@better-auth/api-key`). The JS property names are the plugin's field names; the key
 * is stored hashed, and `metadata` is JSON `{grantId}` (the grant holds the permission).
 */
export const apikey = sqliteTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: integer('last_refill_at', { mode: 'timestamp_ms' }),
    enabled: integer('enabled', { mode: 'boolean' }).default(true),
    rateLimitEnabled: integer('rate_limit_enabled', { mode: 'boolean' }).default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: integer('last_request', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [
    index('apikey_config').on(t.configId),
    index('apikey_reference').on(t.referenceId),
    uniqueIndex('apikey_key').on(t.key),
  ],
);

/**
 * Device authorisation requests (better-auth `deviceAuthorization`, RFC 8628). `grantId` is
 * rooster's: approval through `POST /api/v1/device/:userCode/approve` creates the grant and
 * records it here, and redeeming the code links the new session (legacy) or the OAuth tokens
 * (Phase 12) to it. Both codes are stored as SHA-256 hashes (04 §4, `hashDeviceSecret`).
 */
export const deviceCode = sqliteTable(
  'deviceCode',
  {
    id: text('id').primaryKey(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').notNull(),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    scope: text('scope'),
    grantId: text('grant_id'),
    /** The requesting client's `User-Agent`, for the default device label. */
    userAgent: text('user_agent'),
    /**
     * Phase 12 (11 §9): the OAuth client of a device grant request (`rooster-cli` or a CIMD URL);
     * null for the legacy CLI flow, whose redemption is a bearer session.
     */
    oauthClientId: text('oauth_client_id'),
    /** Phase 12: the one resource (RFC 8707) the tokens will be bound to; null for legacy. */
    resource: text('resource'),
    /** Phase 12: the IP address of the device authorization request (shown at `/device`). */
    requestIp: text('request_ip'),
    /** Phase 12: when the device authorization request was made. */
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('device_code_device_code').on(t.deviceCode),
    uniqueIndex('device_code_user_code').on(t.userCode),
  ],
);
