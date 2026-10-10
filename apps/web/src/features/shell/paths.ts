import type { Org } from '../../data/types';

/** Views a sidebar org section can link to (02 §2). `everyone` is for shared orgs only. */
export type OrgViewId = 'my' | 'today' | 'week' | 'overdue' | 'nodate' | 'everyone';

export type SettingsSection =
  | 'profile'
  | 'behaviour'
  | 'notifications'
  | 'calendar'
  | 'security'
  | 'data';

/** The personal org is addressed by the `personal` alias (05 §2), giving stable URLs. */
export function orgUrlSlug(org: Pick<Org, 'isPersonal' | 'slug'>): string {
  return org.isPersonal ? 'personal' : org.slug;
}

/** URL builders for 02 §2. */
export const paths = {
  home: '/',
  login: '/login',
  orgView: (slug: string, view: OrgViewId) => `/o/${slug}/${view}`,
  task: (slug: string, taskId: string) => `/o/${slug}/t/${taskId}`,
  orgSettings: (slug: string) => `/o/${slug}/settings`,
  orgInvites: (slug: string) => `/o/${slug}/settings#invites`,
  /** Phones: the settings index; tablet and up redirect to the first section. */
  settingsIndex: '/settings',
  settings: (section: SettingsSection) => `/settings/${section}`,
  admin: '/admin',
  /** The notification inbox (P6, FR-NOT-1): one list across every org. */
  inbox: '/inbox',
  /** The user guide (ADR 0052 §2): the page list, and one page per slug. */
  help: '/help',
  helpPage: (slug: string) => `/help/${slug}`,
} as const;
