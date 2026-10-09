import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { session, user } from './auth.ts';

// Phase 9 OAuth 2.1 authorization server (11 §4, ADR 0041): the tables of
// `@better-auth/oauth-provider` 1.7.7, named exactly as the plugin's models. The JS property
// names are the plugin's field names; `string[]` and `json` fields are JSON text (the adapter
// encodes them on SQLite), dates are `timestamp_ms` integers. `referenceId` on tokens and
// consents is rooster's `access_grant.id`. Like the other better-auth tables, not STRICT.

/** OAuth clients: Client ID Metadata Documents (`clientDiscoveryId = 'cimd'`) and DCR. */
export const oauthClient = sqliteTable(
  'oauthClient',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: integer('disabled', { mode: 'boolean' }).default(false),
    skipConsent: integer('skip_consent', { mode: 'boolean' }),
    enableEndSession: integer('enable_end_session', { mode: 'boolean' }),
    subjectType: text('subject_type'),
    scopes: text('scopes'),
    clientCredentialsScopes: text('client_credentials_scopes'),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts'),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris'),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: integer('backchannel_logout_session_required', {
      mode: 'boolean',
    }),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types'),
    responseTypes: text('response_types'),
    requirePKCE: integer('require_pkce', { mode: 'boolean' }),
    dpopBoundAccessTokens: integer('dpop_bound_access_tokens', { mode: 'boolean' }).default(false),
    referenceId: text('reference_id'),
    metadata: text('metadata'),
  },
  (t) => [
    uniqueIndex('oauth_client_client_id').on(t.clientId),
    index('oauth_client_user').on(t.userId),
  ],
);

/** The protected resources (RFC 8707): `<base>/mcp` and `<base>/api/v1`, seeded at boot. */
export const oauthResource = sqliteTable(
  'oauthResource',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    name: text('name').notNull(),
    accessTokenTtl: integer('access_token_ttl'),
    refreshTokenTtl: integer('refresh_token_ttl'),
    signingAlgorithm: text('signing_algorithm'),
    signingKeyId: text('signing_key_id'),
    allowedScopes: text('allowed_scopes'),
    customClaims: text('custom_claims'),
    dpopBoundAccessTokensRequired: integer('dpop_bound_access_tokens_required', {
      mode: 'boolean',
    }).default(false),
    disabled: integer('disabled', { mode: 'boolean' }).default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
    policyVersion: integer('policy_version').default(1),
    metadata: text('metadata'),
  },
  (t) => [uniqueIndex('oauth_resource_identifier').on(t.identifier)],
);

/** Which clients may request which resources (unused: `enforcePerClientResources` is off). */
export const oauthClientResource = sqliteTable(
  'oauthClientResource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: text('metadata'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('oauth_client_resource_client').on(t.clientId),
    index('oauth_client_resource_resource').on(t.resourceId),
    uniqueIndex('oauth_client_resource_pair').on(t.clientId, t.resourceId),
  ],
);

/** Refresh tokens (`offline_access`), stored hashed; rotated on every use. */
export const oauthRefreshToken = sqliteTable(
  'oauthRefreshToken',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** rooster's `access_grant.id`. */
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requested_user_info_claims'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    revoked: integer('revoked', { mode: 'timestamp_ms' }),
    rotatedAt: integer('rotated_at', { mode: 'timestamp_ms' }),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: integer('rotation_replay_expires_at', { mode: 'timestamp_ms' }),
    authTime: integer('auth_time', { mode: 'timestamp_ms' }),
    confirmation: text('confirmation'),
    scopes: text('scopes').notNull(),
  },
  (t) => [
    uniqueIndex('oauth_refresh_token_token').on(t.token),
    index('oauth_refresh_token_client').on(t.clientId),
    index('oauth_refresh_token_session').on(t.sessionId),
    index('oauth_refresh_token_user').on(t.userId),
    index('oauth_refresh_token_code').on(t.authorizationCodeId),
    index('oauth_refresh_token_reference').on(t.referenceId),
  ],
);

/** Opaque access tokens, stored hashed and looked up on every request (11 §4.3). */
export const oauthAccessToken = sqliteTable(
  'oauthAccessToken',
  {
    id: text('id').primaryKey(),
    token: text('token'),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    /** rooster's `access_grant.id`. */
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requested_user_info_claims'),
    refreshId: text('refresh_id').references(() => oauthRefreshToken.id),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    revoked: integer('revoked', { mode: 'timestamp_ms' }),
    confirmation: text('confirmation'),
    scopes: text('scopes').notNull(),
  },
  (t) => [
    uniqueIndex('oauth_access_token_token').on(t.token),
    index('oauth_access_token_client').on(t.clientId),
    index('oauth_access_token_session').on(t.sessionId),
    index('oauth_access_token_user').on(t.userId),
    index('oauth_access_token_code').on(t.authorizationCodeId),
    index('oauth_access_token_refresh').on(t.refreshId),
    index('oauth_access_token_reference').on(t.referenceId),
  ],
);

/** What a user consented to per client (and grant): repeat authorizations skip the screen. */
export const oauthConsent = sqliteTable(
  'oauthConsent',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    /** rooster's `access_grant.id`. */
    referenceId: text('reference_id'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requested_user_info_claims'),
    scopes: text('scopes').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('oauth_consent_client').on(t.clientId),
    index('oauth_consent_user').on(t.userId),
    index('oauth_consent_reference').on(t.referenceId),
  ],
);

/** Single-use `private_key_jwt` assertion ids (`id` is a digest of the `jti`). */
export const oauthClientAssertion = sqliteTable('oauthClientAssertion', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});
