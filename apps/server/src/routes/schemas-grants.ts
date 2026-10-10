import {
  deviceApproveSchema,
  deviceRequestSchema,
  grantConstraintsSchema,
  grantPatchSchema,
  grantSchema,
  linkedIdentitySchema,
  oauthClientInfoSchema,
  oauthConsentDecisionSchema,
  oauthConsentRequestSchema,
  oauthConsentResultSchema,
  removedIdentitySchema,
  tokenCreatedSchema,
  tokenCreateSchema,
} from '@rooster/core/schemas';
import { describe, named } from '../lib/openapi.ts';

// Phase 8 agent access (11 §2–3, 06 §2.1): the grant DTOs from @rooster/core as OpenAPI
// components.

const constraintsExample = {
  orgs: [
    {
      orgId: '0199a1b2-0000-7000-8000-000000000001',
      read: 'all',
      write: { groups: ['0199a1b2-0000-7000-8000-0000000000a1'] },
    },
  ],
};

const grantExample = {
  id: '0199a1b2-0000-7000-8000-0000000000f1',
  kind: 'pat',
  clientId: null,
  label: 'Backup script',
  scopes: ['tasks:write'],
  constraints: constraintsExample,
  tokenPrefix: 'rooster_pat_Ab12',
  createdAt: 1767225600000,
  updatedAt: 1767225600000,
  expiresAt: 1774998000000,
  idleTimeoutMs: null,
  client: null,
  lastUsedAt: 1767312000000,
  lastUsedIp: '203.0.113.7',
  current: false,
};

export const GrantConstraintsSchema = named(grantConstraintsSchema, 'GrantConstraints', {
  description:
    'Where a grant may act (11 §2.2): `orgs: "all"` (including orgs joined later) or a list of orgs, each with `read` (`"all"` or `{groups}`) and `write` (`"none"`, `"all"` or `{groups}`). Groups are the user’s own groups; a task counts as being in the group where it sits in the user’s My tasks (a subtask: where its row sits).',
  example: constraintsExample,
});

// Nested components are re-attached so the document references them instead of inlining.
export const GrantSchema = named(
  grantSchema.extend({ constraints: GrantConstraintsSchema }),
  'Grant',
  {
    description:
      'One PAT, CLI device or (Phase 9) OAuth client authorization: capabilities (`scopes`) plus `constraints`.',
    example: grantExample,
  },
);

export const GrantPatchSchema = named(
  grantPatchSchema.safeExtend({ constraints: GrantConstraintsSchema.optional() }),
  'GrantPatch',
  {
    example: { label: 'Laptop CLI', constraints: { orgs: 'all' } },
  },
);

export const TokenCreateSchema = named(
  describe(tokenCreateSchema.extend({ constraints: GrantConstraintsSchema }), {
    name: 'Shown in Connected apps.',
    scopes:
      'Capabilities: `tasks:read`, `tasks:write`, `comments:write`, `tasks:assign`, `groups:write`, `tasks:delete`, `notifications:read`.',
    expiresInDays: 'Omitted: the token never expires.',
  }),
  'TokenCreate',
  {
    example: {
      name: 'Backup script',
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
      expiresInDays: 90,
    },
  },
);

export const TokenCreatedSchema = named(
  tokenCreatedSchema.extend({ grant: GrantSchema }),
  'TokenCreated',
  {
    example: { token: 'rooster_pat_Ab12…', grant: grantExample },
  },
);

export const DeviceRequestSchema = named(deviceRequestSchema, 'DeviceRequest', {
  example: {
    userCode: 'WDJBMJHT',
    clientId: 'rooster-cli',
    clientName: 'rooster CLI',
    requestedScopes: [
      'tasks:delete',
      'comments:write',
      'tasks:assign',
      'groups:write',
      'notifications:read',
    ],
    expiresAt: 1767226200000,
  },
});

export const DeviceApproveSchema = named(
  describe(deviceApproveSchema.extend({ constraints: GrantConstraintsSchema }), {
    scopes: 'No wider than the device requested (`422 widening_not_allowed`).',
    label: 'Default: "rooster CLI on <device>", from the CLI’s User-Agent.',
    expiresInDays: 'Omitted: the grant does not expire.',
  }),
  'DeviceApprove',
  {
    example: {
      scopes: ['tasks:write'],
      constraints: constraintsExample,
      label: 'rooster CLI on laptop',
    },
  },
);

// Phase 9 (11 §3.1, ADR 0042): the OAuth consent screen and linked sign-in identities.

const clientInfoExample = {
  name: 'Claude',
  domain: 'claude.ai',
  logoUri: 'https://claude.ai/logo.png',
  clientUri: 'https://claude.ai',
  verified: true,
  dynamic: false,
};

export const OAuthClientInfoSchema = named(oauthClientInfoSchema, 'OAuthClientInfo', {
  description:
    'How an OAuth app presents itself: from its Client ID Metadata Document (`verified` when the metadata host equals the redirect host) or its Dynamic Client Registration (`dynamic`: "Unverified app").',
  example: clientInfoExample,
});

export const OAuthConsentRequestSchema = named(
  oauthConsentRequestSchema.extend({
    client: OAuthClientInfoSchema,
    existing: GrantSchema.nullable(),
    prefill: GrantConstraintsSchema.nullable(),
  }),
  'OAuthConsentRequest',
  {
    example: {
      oauthQuery: 'client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fclient.json&…&sig=…',
      clientId: 'https://claude.ai/oauth/client.json',
      client: clientInfoExample,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      loopback: false,
      resource: 'https://rooster.example.com/mcp',
      requestedScopes: ['tasks:write'],
      newScopes: ['tasks:write'],
      existing: null,
      prefill: null,
    },
  },
);

export const OAuthConsentDecisionSchema = named(
  oauthConsentDecisionSchema,
  'OAuthConsentDecision',
  {
    description:
      'Allow (`accept: true`, with the approved scopes, constraints and expiry or `sessionOnly`) or Deny (`accept: false`). `oauthQuery` is the signed query from `GET /oauth/consent`, unchanged.',
    example: {
      accept: true,
      oauthQuery: 'client_id=…&sig=…',
      scopes: ['tasks:write'],
      constraints: constraintsExample,
      expiresInDays: 90,
    },
  },
);

export const OAuthConsentResultSchema = named(oauthConsentResultSchema, 'OAuthConsentResult', {
  example: {
    redirectTo:
      'https://claude.ai/api/mcp/auth_callback?code=…&state=…&iss=https%3A%2F%2Frooster.example.com%2Fapi%2Fauth',
  },
});

export const LinkedIdentitySchema = named(linkedIdentitySchema, 'LinkedIdentity', {
  example: {
    id: '0199a1b2-0000-7000-8000-0000000000c1',
    providerId: 'google',
    providerName: 'Google',
    email: 'ada@example.com',
    createdAt: 1767225600000,
  },
});

export const RemovedIdentitySchema = named(removedIdentitySchema, 'RemovedIdentity', {
  example: {
    id: '0199a1b2-0000-7000-8000-0000000000c2',
    providerId: 'google',
    providerName: 'Google',
    email: 'ada@gmail.example',
    removedAt: 1767312000000,
  },
});
