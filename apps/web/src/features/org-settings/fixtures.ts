import type { OrgInvite, OrgMember } from '../../data/types';
import { fixtureIds } from '../shell/fixtures';

const day = 24 * 60 * 60 * 1000;
const now = Date.now();

export const fixtureMembers: Record<string, OrgMember[]> = {
  [fixtureIds.personalOrg]: [
    {
      userId: fixtureIds.jannik,
      name: 'Jannik Lunde',
      email: 'jannik@example.com',
      image: null,
      role: 'owner',
    },
  ],
  [fixtureIds.companyOrg]: [
    {
      userId: fixtureIds.jannik,
      name: 'Jannik Lunde',
      email: 'jannik@example.com',
      image: null,
      role: 'owner',
    },
    {
      userId: fixtureIds.anna,
      name: 'Anna Lindqvist',
      email: 'anna@example.com',
      image: null,
      role: 'owner',
    },
    {
      userId: fixtureIds.markus,
      name: 'Markus Lindén',
      email: 'markus@example.com',
      image: null,
      role: 'member',
    },
    {
      userId: fixtureIds.sara,
      name: 'Sara Nilsson',
      email: 'sara@example.com',
      image: null,
      role: 'member',
    },
  ],
  [fixtureIds.clubOrg]: [
    {
      userId: fixtureIds.olof,
      name: 'Olof Bergström',
      email: 'olof@example.com',
      image: null,
      role: 'owner',
    },
    {
      userId: fixtureIds.jannik,
      name: 'Jannik Lunde',
      email: 'jannik@example.com',
      image: null,
      role: 'member',
    },
  ],
};

export const fixtureInvites: Record<string, OrgInvite[]> = {
  [fixtureIds.companyOrg]: [
    {
      id: '0192f5d0-7a1e-7c3a-9f10-0000000000b1',
      kind: 'email',
      email: 'olof@example.com',
      role: 'member',
      multiUse: false,
      uses: 0,
      url: 'https://rooster.example.com/invite/demo',
      expiresAt: now + 5 * day,
      createdAt: now - 2 * day,
    },
    {
      id: '0192f5d0-7a1e-7c3a-9f10-0000000000b2',
      kind: 'link',
      email: null,
      role: 'member',
      multiUse: true,
      uses: 2,
      url: null,
      expiresAt: now + 6 * day,
      createdAt: now - day,
    },
  ],
};
