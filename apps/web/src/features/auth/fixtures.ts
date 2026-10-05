import type { AuthProvider, InvitePreview } from '../../data/types';
import { fixtureIds } from '../shell/fixtures';

export const fixtureProviders: AuthProvider[] = [
  { id: 'google', name: 'Google' },
  { id: 'keycloak', name: 'Northwind SSO' },
];

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
const org = {
  id: fixtureIds.companyOrg,
  name: 'Northwind',
  avatarEmoji: null,
  color: 'blue',
} as const;

/** Preview tokens for `/invite/$token` in fixture mode: `demo`, `expired`, `revoked`, `used`. */
export const fixtureInvitePreviews: Record<string, InvitePreview> = {
  demo: {
    status: 'valid',
    org,
    inviterName: 'Anna Lindqvist',
    role: 'member',
    expiresAt: now + 6 * day,
  },
  expired: {
    status: 'expired',
    org,
    inviterName: 'Anna Lindqvist',
    role: 'member',
    expiresAt: now - day,
  },
  revoked: {
    status: 'revoked',
    org,
    inviterName: 'Anna Lindqvist',
    role: 'member',
    expiresAt: null,
  },
  used: { status: 'used', org, inviterName: 'Anna Lindqvist', role: 'owner', expiresAt: null },
};
