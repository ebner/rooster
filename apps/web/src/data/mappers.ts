import type { components } from '@rooster/api-client';
import type { InvitePreview, Me, Org, OrgInvite, OrgMember, UserSession } from './types';

type Schemas = components['schemas'];

/** API → view models. The array order of `orgs` is the sidebar order (`position`). */
export function toOrg(org: Schemas['Org']): Org {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    isPersonal: org.isPersonal,
    avatarEmoji: org.avatarEmoji,
    color: org.color,
    role: org.role,
    collapsed: org.collapsed,
  };
}

export function toMe(me: Schemas['Me']): Me {
  const { orgs, prefs, storage, ...user } = me;
  return { user, orgs: orgs.map(toOrg), prefs, ...(storage ? { storage } : {}) };
}

export function toMember(member: Schemas['Member']): OrgMember {
  const { joinedAt: _joinedAt, ...rest } = member;
  return rest;
}

export function toInvite(invite: Schemas['Invite']): OrgInvite {
  return invite;
}

export function toSession(session: Schemas['Session']): UserSession {
  return {
    id: session.id,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    createdAt: session.createdAt,
    lastActiveAt: session.updatedAt,
    isCurrent: session.current,
  };
}

export const notFoundPreview: InvitePreview = {
  status: 'notFound',
  org: null,
  inviterName: null,
  role: null,
  expiresAt: null,
};

/** The preview has no org id; the token stands in for the avatar's colour seed. */
export function toInvitePreview(token: string, preview: Schemas['InvitePreview']): InvitePreview {
  const status = preview.valid
    ? 'valid'
    : preview.reason === 'org_deleted' || preview.reason === null
      ? 'notFound'
      : preview.reason;
  return {
    status,
    org: {
      id: token,
      slug: preview.orgSlug,
      name: preview.orgName,
      avatarEmoji: preview.orgAvatarEmoji,
      color: preview.orgColor,
    },
    inviterName: preview.inviterName,
    role: preview.role,
    expiresAt: preview.expiresAt,
  };
}
