import type { Grant } from '@rooster/core/schemas';
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
      lastUsedAt: now - 31 * day,
      lastUsedIp: '192.168.1.20',
      current: false,
    },
  ];
}

export const fixtureUserCode = 'WDJBMJHT';
