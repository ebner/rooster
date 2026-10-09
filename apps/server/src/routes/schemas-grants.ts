import {
  deviceApproveSchema,
  deviceRequestSchema,
  grantConstraintsSchema,
  grantPatchSchema,
  grantSchema,
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
