import type { Org } from '../../data/types';

/** Views a sidebar org section can link to. P2+ append today, week, overdue, nodate, everyone. */
export type OrgViewId = 'my';

export type SettingsSection = 'profile' | 'security';

/** The personal org is addressed by the `personal` alias (05 §2), giving stable URLs. */
export function orgUrlSlug(org: Pick<Org, 'isPersonal' | 'slug'>): string {
  return org.isPersonal ? 'personal' : org.slug;
}

/** URL builders for 02 §2. */
export const paths = {
  home: '/',
  login: '/login',
  orgView: (slug: string, view: OrgViewId) => `/o/${slug}/${view}`,
  orgSettings: (slug: string) => `/o/${slug}/settings`,
  orgInvites: (slug: string) => `/o/${slug}/settings#invites`,
  settings: (section: SettingsSection) => `/settings/${section}`,
  admin: '/admin',
} as const;
