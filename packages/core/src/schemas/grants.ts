import { z } from 'zod';
import { ALL_GRANT_SCOPES } from '../grants.ts';
import { idSchema, timestampSchema } from './common.ts';

/**
 * Phase 8 grant contract (docs/spec/11-agent-access.md §2–3, 06 §2.1). One grant per PAT, CLI
 * device session or (P9) OAuth client authorization. DTOs are additive-only within API v1.
 */

export const grantScopeSchema = z.enum(ALL_GRANT_SCOPES);
export const grantScopesSchema = z.array(grantScopeSchema).min(1).max(ALL_GRANT_SCOPES.length);

const groupListSchema = z.object({ groups: z.array(idSchema).min(1).max(100) });

export const orgGrantSchema = z.object({
  orgId: idSchema,
  read: z.union([z.literal('all'), groupListSchema]),
  write: z.union([z.literal('none'), z.literal('all'), groupListSchema]),
});

export const grantConstraintsSchema = z.object({
  orgs: z.union([z.literal('all'), z.array(orgGrantSchema).min(1).max(50)]),
});

export const GRANT_KINDS = ['pat', 'device', 'oauth'] as const;
export const grantKindSchema = z.enum(GRANT_KINDS);

/**
 * P9: how an OAuth client presents itself (11 §3.1), from its Client ID Metadata Document or
 * its Dynamic Client Registration.
 */
export const oauthClientInfoSchema = z.object({
  /** `client_name`, else the client id's host. */
  name: z.string(),
  /** The host users should recognise: the metadata URL's host (CIMD) or the redirect host. */
  domain: z.string(),
  logoUri: z.url().nullable(),
  clientUri: z.url().nullable(),
  /** CIMD whose metadata host matches the redirect host. */
  verified: z.boolean(),
  /** Registered through DCR: shown as "Unverified app". */
  dynamic: z.boolean(),
});

/** One row of Settings → Connected apps (`GET /me/grants`). */
export const grantSchema = z.object({
  id: idSchema,
  kind: grantKindSchema,
  /** OAuth client id (P9) or `rooster-cli`; null for PATs. */
  clientId: z.string().nullable(),
  label: z.string(),
  scopes: z.array(grantScopeSchema),
  constraints: grantConstraintsSchema,
  /** PATs: the visible token prefix (`rooster_pat_ab12`), to tell tokens apart. */
  tokenPrefix: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
  /**
   * P9 "This session only" (11 §2.4): the grant ends once its refresh token has gone unused
   * this long (24 h). Null otherwise.
   */
  idleTimeoutMs: z.int().positive().nullable(),
  /** P9: the OAuth client's presentation; null for PATs and CLI devices. */
  client: oauthClientInfoSchema.nullable(),
  lastUsedAt: timestampSchema.nullable(),
  lastUsedIp: z.string().nullable(),
  /** True for the grant behind the request (`GET /me/grants` from the CLI). */
  current: z.boolean(),
});
export const grantListSchema = z.array(grantSchema);

/**
 * PATCH /me/grants/:id. PATs and devices may change freely; an OAuth client's scopes and
 * constraints may only be narrowed (`isNarrowing`, 11 §3.2) — else `422 widening_not_allowed`.
 */
export const grantPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    scopes: grantScopesSchema.optional(),
    constraints: grantConstraintsSchema.optional(),
    /** null = never. */
    expiresAt: timestampSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'Nothing to update' });

export const EXPIRY_DAYS = [7, 30, 90, 365] as const;

/** POST /me/tokens: a PAT. The token is returned once. */
export const tokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: grantScopesSchema,
  constraints: grantConstraintsSchema,
  /** Omitted = never expires. */
  expiresInDays: z.int().min(1).max(3650).optional(),
});
export const tokenCreatedSchema = z.object({
  /** `rooster_pat_…`, shown once. */
  token: z.string(),
  grant: grantSchema,
});

/**
 * GET /device/:userCode — what the `/device` page shows before approval (11 §3.1). The CLI
 * asks for `scopes` in its device code request; the user may approve fewer.
 */
export const deviceRequestSchema = z.object({
  userCode: z.string(),
  clientId: z.string(),
  /** Display name, e.g. "rooster CLI". */
  clientName: z.string(),
  requestedScopes: z.array(grantScopeSchema),
  expiresAt: timestampSchema,
});

/** POST /device/:userCode/approve — the grant the CLI session gets. */
export const deviceApproveSchema = z.object({
  scopes: grantScopesSchema,
  constraints: grantConstraintsSchema,
  /** Default: "rooster CLI on <device>" from the request's user agent. */
  label: z.string().trim().min(1).max(100).optional(),
  expiresInDays: z.int().min(1).max(3650).optional(),
});

/** "This session only": the idle timeout of an OAuth grant (11 §2.4, ADR 0041). */
export const SESSION_ONLY_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * GET /oauth/consent?oauth_query=… (P9, session only): what the consent screen (11 §3.1) shows
 * for the authorization request that better-auth's provider redirected to `/oauth/consent`.
 * `oauthQuery` is the provider's signed query, passed back unchanged on the decision.
 */
export const oauthConsentRequestSchema = z.object({
  oauthQuery: z.string(),
  clientId: z.string(),
  client: oauthClientInfoSchema,
  /** The exact redirect target, shown to the user. */
  redirectUri: z.string(),
  /** `http://127.0.0.1:<port>` or `localhost`: "an app on this computer". */
  loopback: z.boolean(),
  /** The protected resource (RFC 8707): `<base>/mcp` or `<base>/api/v1`. */
  resource: z.string(),
  /** What the client asked for, minus `OAUTH_EXCLUDED_SCOPES` and `offline_access`. */
  requestedScopes: z.array(grantScopeSchema),
  /** Step-up: the scopes not in the existing grant, highlighted as "new". */
  newScopes: z.array(grantScopeSchema),
  /** The live grant of this (user, client), to pre-fill constraints on step-up; else null. */
  existing: grantSchema.nullable(),
  /** RFC 9396 `authorization_details` of type `rooster_access`, if the client sent any. */
  prefill: grantConstraintsSchema.nullable(),
});

/**
 * POST /oauth/consent (P9, session only). Allow creates or updates the user's grant for the
 * client and answers the provider; Deny answers `access_denied`. Either way the response is
 * where the browser goes next (the client's redirect URI, with `iss`).
 */
export const oauthConsentDecisionSchema = z.discriminatedUnion('accept', [
  z.object({
    accept: z.literal(true),
    oauthQuery: z.string(),
    scopes: grantScopesSchema,
    constraints: grantConstraintsSchema,
    /** Omitted = never; ignored with `sessionOnly`. */
    expiresInDays: z.int().min(1).max(3650).optional(),
    /** "This session only" (`SESSION_ONLY_IDLE_MS`). */
    sessionOnly: z.boolean().optional(),
  }),
  z.object({ accept: z.literal(false), oauthQuery: z.string() }),
]);
export const oauthConsentResultSchema = z.object({ redirectTo: z.string() });

/** GET /me/identities (P9, FR-SET-3, session only): the user's linked sign-in identities. */
export const linkedIdentitySchema = z.object({
  /** better-auth account id; the DELETE path parameter. */
  id: z.string(),
  /** `google` or a configured OIDC provider id. */
  providerId: z.string(),
  /** The provider's display name from the server config. */
  providerName: z.string(),
  /** The email the provider vouched for at sign-in, when known. */
  email: z.string().nullable(),
  createdAt: timestampSchema,
});
export const linkedIdentityListSchema = z.array(linkedIdentitySchema);

export type GrantScopeValue = z.infer<typeof grantScopeSchema>;
export type OrgGrantValue = z.infer<typeof orgGrantSchema>;
export type GrantConstraintsValue = z.infer<typeof grantConstraintsSchema>;
export type GrantKind = z.infer<typeof grantKindSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type GrantPatch = z.infer<typeof grantPatchSchema>;
export type TokenCreate = z.infer<typeof tokenCreateSchema>;
export type TokenCreated = z.infer<typeof tokenCreatedSchema>;
export type DeviceRequest = z.infer<typeof deviceRequestSchema>;
export type DeviceApprove = z.infer<typeof deviceApproveSchema>;
export type OAuthClientInfo = z.infer<typeof oauthClientInfoSchema>;
export type OAuthConsentRequest = z.infer<typeof oauthConsentRequestSchema>;
export type OAuthConsentDecision = z.infer<typeof oauthConsentDecisionSchema>;
export type OAuthConsentResult = z.infer<typeof oauthConsentResultSchema>;
export type LinkedIdentity = z.infer<typeof linkedIdentitySchema>;
