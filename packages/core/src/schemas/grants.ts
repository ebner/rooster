import { z } from 'zod';
import { GRANT_SCOPES } from '../grants.ts';
import { idSchema, timestampSchema } from './common.ts';

/**
 * Phase 8 grant contract (docs/spec/11-agent-access.md §2–3, 06 §2.1). One grant per PAT, CLI
 * device session or (P9) OAuth client authorization. DTOs are additive-only within API v1.
 */

export const grantScopeSchema = z.enum(GRANT_SCOPES);
export const grantScopesSchema = z.array(grantScopeSchema).min(1).max(GRANT_SCOPES.length);

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
