import type { Me } from '../../data/types';

/** Demo identities shared by every fixture file (stable UUIDv7-shaped ids). */
export const fixtureIds = {
  jannik: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e02',
  anna: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e01',
  markus: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e03',
  sara: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e04',
  olof: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e05',
  personalOrg: '0192f5d0-7a1e-7c3a-9f10-0000000000a1',
  companyOrg: '0192f5d0-7a1e-7c3a-9f10-0000000000a2',
  clubOrg: '0192f5d0-7a1e-7c3a-9f10-0000000000a3',
} as const;

export const fixtureMe: Me = {
  user: {
    id: fixtureIds.jannik,
    name: 'Jannik Lunde',
    email: 'jannik@example.com',
    image: null,
    isAdmin: true,
    locale: 'en',
    timezone: 'Europe/Stockholm',
    weekStart: 1,
    dateFormat: 'MMM d',
    timeFormat: '24h',
  },
  orgs: [
    {
      id: fixtureIds.personalOrg,
      slug: 'personal-0192f5d0',
      name: 'Personal',
      isPersonal: true,
      avatarEmoji: '🏡',
      color: 'green',
      role: 'owner',
      collapsed: false,
    },
    {
      id: fixtureIds.companyOrg,
      slug: 'northwind',
      name: 'Northwind',
      isPersonal: false,
      avatarEmoji: null,
      color: 'blue',
      role: 'owner',
      collapsed: false,
    },
    {
      id: fixtureIds.clubOrg,
      slug: 'book-club',
      name: 'Book club',
      isPersonal: false,
      avatarEmoji: '📚',
      color: 'amber',
      role: 'member',
      collapsed: false,
    },
  ],
};
