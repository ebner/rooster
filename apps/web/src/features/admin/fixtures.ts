import type { AdminUser, AllowlistEntry } from '../../data/types';
import { fixtureIds } from '../shell/fixtures';

const day = 24 * 60 * 60 * 1000;
const now = Date.now();

export const fixtureAllowlist: AllowlistEntry[] = [
  { id: 'allow-1', kind: 'domain', value: 'example.com', createdAt: now - 30 * day },
  { id: 'allow-2', kind: 'email', value: 'olof@example.org', createdAt: now - 3 * day },
];

export const fixtureAdminUsers: AdminUser[] = [
  {
    id: fixtureIds.jannik,
    name: 'Jannik Lunde',
    email: 'jannik@example.com',
    image: null,
    createdAt: now - 40 * day,
    disabledAt: null,
    isAdmin: true,
  },
  {
    id: fixtureIds.anna,
    name: 'Anna Lindqvist',
    email: 'anna@example.com',
    image: null,
    createdAt: now - 35 * day,
    disabledAt: null,
    isAdmin: false,
  },
  {
    id: fixtureIds.markus,
    name: 'Markus Lindén',
    email: 'markus@example.com',
    image: null,
    createdAt: now - 20 * day,
    disabledAt: null,
    isAdmin: false,
  },
  {
    id: fixtureIds.sara,
    name: 'Sara Nilsson',
    email: 'sara@example.com',
    image: null,
    createdAt: now - 9 * day,
    disabledAt: now - 2 * day,
    isAdmin: false,
  },
  {
    id: fixtureIds.olof,
    name: 'Olof Bergström',
    email: 'olof@example.org',
    image: null,
    createdAt: now - 2 * day,
    disabledAt: null,
    isAdmin: false,
  },
];
