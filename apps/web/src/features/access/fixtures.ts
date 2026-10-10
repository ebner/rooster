import type {
  Grant,
  LinkedIdentity,
  OAuthConsentRequest,
  RemovedIdentity,
} from '@rooster/core/schemas';
import { fixtureIds } from '../shell/fixtures';
import type { GrantOrgOption } from './grant-model';

/** Kitchen-sink and test fixtures for the grant UI (P8, WP 8.2). */
export const fixtureGroupIds = {
  personalInbox: '0192f5d0-7a1e-7c3a-9f10-00000000b001',
  personalHome: '0192f5d0-7a1e-7c3a-9f10-00000000b002',
  personalErrands: '0192f5d0-7a1e-7c3a-9f10-00000000b003',
  companyInbox: '0192f5d0-7a1e-7c3a-9f10-00000000b011',
  companyToday: '0192f5d0-7a1e-7c3a-9f10-00000000b012',
  companyPrio: '0192f5d0-7a1e-7c3a-9f10-00000000b013',
  companyLater: '0192f5d0-7a1e-7c3a-9f10-00000000b014',
} as const;

export const fixtureGrantOrgs: GrantOrgOption[] = [
  {
    id: fixtureIds.personalOrg,
    name: 'Personal',
    isPersonal: true,
    groups: [
      { id: fixtureGroupIds.personalInbox, name: 'Inbox', isInbox: true },
      { id: fixtureGroupIds.personalHome, name: 'Home', isInbox: false },
      { id: fixtureGroupIds.personalErrands, name: 'Errands', isInbox: false },
    ],
  },
  {
    id: fixtureIds.companyOrg,
    name: 'Acme',
    isPersonal: false,
    groups: [
      { id: fixtureGroupIds.companyInbox, name: 'Inbox', isInbox: true },
      { id: fixtureGroupIds.companyToday, name: 'Today', isInbox: false },
      { id: fixtureGroupIds.companyPrio, name: 'Prio', isInbox: false },
      { id: fixtureGroupIds.companyLater, name: 'Later', isInbox: false },
    ],
  },
];

const minute = 60 * 1000;
const day = 24 * 60 * minute;

export function fixtureGrants(now: number): Grant[] {
  return [
    {
      id: '0192f5d0-7a1e-7c3a-9f10-00000000c001',
      kind: 'device',
      clientId: 'rooster-cli',
      label: 'rooster CLI on build-box',
      scopes: ['tasks:delete', 'comments:write', 'groups:write', 'notifications:read'],
      constraints: { orgs: 'all' },
      tokenPrefix: null,
      createdAt: now - 40 * day,
      updatedAt: now - 40 * day,
      expiresAt: null,
      idleTimeoutMs: null,
      client: null,
      lastUsedAt: now - 5 * minute,
      lastUsedIp: '83.250.12.7',
      current: false,
    },
    {
      id: '0192f5d0-7a1e-7c3a-9f10-00000000c002',
      kind: 'pat',
      clientId: null,
      label: 'Prio sync script',
      scopes: ['tasks:write'],
      constraints: {
        orgs: [
          { orgId: fixtureIds.personalOrg, read: 'all', write: 'none' },
          {
            orgId: fixtureIds.companyOrg,
            read: 'all',
            write: { groups: [fixtureGroupIds.companyPrio] },
          },
        ],
      },
      tokenPrefix: 'rooster_pat_ab12',
      createdAt: now - 12 * day,
      updatedAt: now - 2 * day,
      expiresAt: now + 78 * day,
      idleTimeoutMs: null,
      client: null,
      lastUsedAt: now - 2 * day,
      lastUsedIp: '10.0.0.14',
      current: false,
    },
    {
      id: '0192f5d0-7a1e-7c3a-9f10-00000000c003',
      kind: 'oauth',
      clientId: 'https://claude.ai/oauth/client-metadata.json',
      label: 'Claude',
      scopes: ['tasks:write'],
      constraints: {
        orgs: [
          {
            orgId: fixtureIds.personalOrg,
            read: { groups: [fixtureGroupIds.personalInbox, fixtureGroupIds.personalHome] },
            write: { groups: [fixtureGroupIds.personalInbox] },
          },
        ],
      },
      tokenPrefix: null,
      createdAt: now - 3 * day,
      updatedAt: now - 3 * day,
      expiresAt: now + 87 * day,
      idleTimeoutMs: null,
      client: {
        name: 'Claude',
        domain: 'claude.ai',
        logoUri: null,
        clientUri: 'https://claude.ai',
        verified: true,
        dynamic: false,
      },
      lastUsedAt: null,
      lastUsedIp: null,
      current: false,
    },
    {
      id: '0192f5d0-7a1e-7c3a-9f10-00000000c004',
      kind: 'pat',
      clientId: null,
      label: 'Old backup token',
      scopes: ['tasks:read'],
      constraints: {
        orgs: [{ orgId: fixtureIds.personalOrg, read: 'all', write: 'none' }],
      },
      tokenPrefix: 'rooster_pat_9f3c',
      createdAt: now - 120 * day,
      updatedAt: now - 120 * day,
      expiresAt: now - 30 * day,
      idleTimeoutMs: null,
      client: null,
      lastUsedAt: now - 31 * day,
      lastUsedIp: '192.168.1.20',
      current: false,
    },
  ];
}

export const fixtureUserCode = 'WDJBMJHT';

const signedQuery =
  'response_type=code&client_id=fixture&scope=tasks%3Aread&exp=1&ba_param=client_id&sig=fixture';

/** OAuth consent requests (P9, 11 §3.1): one per state the kitchen sink and tests show. */
export function fixtureConsentRequests(now: number): {
  verified: OAuthConsentRequest;
  dynamic: OAuthConsentRequest;
  loopback: OAuthConsentRequest;
  stepUp: OAuthConsentRequest;
  stepUpDeleting: OAuthConsentRequest;
} {
  const claude = fixtureGrants(now).find((grant) => grant.kind === 'oauth') ?? null;
  return {
    verified: {
      oauthQuery: signedQuery,
      clientId: 'https://claude.ai/oauth/mcp-client-metadata.json',
      client: {
        name: 'Claude',
        domain: 'claude.ai',
        logoUri: null,
        clientUri: 'https://claude.ai',
        verified: true,
        dynamic: false,
      },
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      loopback: false,
      resource: 'https://rooster.example.com/mcp',
      requestedScopes: ['tasks:write'],
      newScopes: [],
      existing: null,
      prefill: null,
    },
    dynamic: {
      oauthQuery: signedQuery,
      clientId: 'dcr_8f2a1c',
      client: {
        name: 'Task Helper\u202e (official)',
        domain: 'tasks-helper.example.net',
        logoUri: 'http://tasks-helper.example.net/logo.png',
        clientUri: null,
        verified: false,
        dynamic: true,
      },
      redirectUri: 'https://tasks-helper.example.net/oauth/callback',
      loopback: false,
      resource: 'https://rooster.example.com/api/v1',
      requestedScopes: ['tasks:read', 'notifications:read'],
      newScopes: [],
      existing: null,
      prefill: null,
    },
    loopback: {
      oauthQuery: signedQuery,
      clientId: 'https://zed.dev/mcp/client.json',
      client: {
        name: 'Zed',
        domain: 'zed.dev',
        logoUri: null,
        clientUri: 'https://zed.dev',
        verified: false,
        dynamic: false,
      },
      redirectUri: 'http://127.0.0.1:53682/callback',
      loopback: true,
      resource: 'https://rooster.example.com/mcp',
      requestedScopes: ['tasks:write', 'comments:write'],
      newScopes: [],
      existing: null,
      prefill: null,
    },
    stepUp: {
      oauthQuery: signedQuery,
      clientId: 'https://claude.ai/oauth/mcp-client-metadata.json',
      client: {
        name: 'Claude',
        domain: 'claude.ai',
        logoUri: null,
        clientUri: 'https://claude.ai',
        verified: true,
        dynamic: false,
      },
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      loopback: false,
      resource: 'https://rooster.example.com/mcp',
      requestedScopes: ['tasks:write', 'comments:write', 'tasks:delete'],
      newScopes: ['comments:write', 'tasks:delete'],
      existing: claude,
      prefill: null,
    },
    // A step-up of a grant that already deletes and names a group deleted since.
    stepUpDeleting: {
      oauthQuery: signedQuery,
      clientId: 'https://claude.ai/oauth/mcp-client-metadata.json',
      client: {
        name: 'Claude',
        domain: 'claude.ai',
        logoUri: null,
        clientUri: 'https://claude.ai',
        verified: true,
        dynamic: false,
      },
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      loopback: false,
      resource: 'https://rooster.example.com/mcp',
      requestedScopes: ['tasks:write', 'notifications:read'],
      newScopes: ['notifications:read'],
      existing: claude && {
        ...claude,
        scopes: ['tasks:delete'],
        constraints: {
          orgs: [
            {
              orgId: fixtureIds.personalOrg,
              read: 'all',
              write: { groups: [fixtureGroupIds.personalInbox, deletedGroupId] },
            },
          ],
        },
      },
      prefill: null,
    },
  };
}

/** A group id no fixture org has any more (deleted since a grant named it). */
export const deletedGroupId = '0192f5d0-7a1e-7c3a-9f10-00000000b0ff';

/** Linked sign-in identities (P9, FR-SET-3). */
export function fixtureIdentities(now: number): LinkedIdentity[] {
  return [
    {
      id: 'acc_google_1',
      providerId: 'google',
      providerName: 'Google',
      email: 'jannik@example.com',
      createdAt: now - 400 * day,
    },
    {
      id: 'acc_oidc_1',
      providerId: 'company-sso',
      providerName: 'Company SSO',
      email: 'jannik@company.example',
      createdAt: now - 20 * day,
    },
  ];
}

/** Removed sign-in identities, blocked until allowed again (FR-SET-3). */
export function fixtureRemovedIdentities(now: number): RemovedIdentity[] {
  return [
    {
      id: 'acc_google_old',
      providerId: 'google',
      providerName: 'Google',
      email: 'jannik.old@example.com',
      removedAt: now - 3 * day,
    },
    {
      id: 'acc_oidc_old',
      providerId: 'company-sso',
      providerName: 'Company SSO',
      email: null,
      removedAt: now - 60 * day,
    },
  ];
}
