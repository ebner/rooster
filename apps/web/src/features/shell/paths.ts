import type { Org } from '../../data/types';

/** Views a sidebar org section can link to (02 §2). `everyone` is for shared orgs only. */
export type OrgViewId = 'my' | 'today' | 'week' | 'overdue' | 'nodate' | 'everyone';

/**
 * Phase 13 (ADR 0073 A): the views of All organisations, across every org (`/all/<view>`).
 * The same names as core `ALL_VIEWS`.
 */
export type AllViewId = 'today' | 'week' | 'overdue';

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
  /** Phase 13 (ADR 0073 B): a view of the org (`saved_view`); the pane opens over it. */
  savedView: (slug: string, viewId: string) => `/o/${slug}/v/${viewId}`,
  /** "+ New view" (ADR 0073 B7): an unsaved view with an editable header, created on save. */
  newSavedView: (slug: string) => `/o/${slug}/v/new`,
  orgSettings: (slug: string) => `/o/${slug}/settings`,
  /** Phase 13 (ADR 0073 A8): All organisations → Today, Next 7 days, Overdue. */
  allView: (view: AllViewId) => `/all/${view}`,
  /** The detail pane over the last All organisations view. */
  allTask: (taskId: string) => `/all/t/${taskId}`,
  orgInvites: (slug: string) => `/o/${slug}/settings#invites`,
  /** Phones: the settings index; tablet and up redirect to the first section. */
  settingsIndex: '/settings',
  settings: (section: SettingsSection) => `/settings/${section}`,
  /**
   * Settings → Connected apps, at one grant when given (`#grant-<id>`): where the
   * `device_connected` notice leads, to revoke it (11 §9.4).
   */
  connectedApps: (grantId?: string) =>
    `/settings/security#${grantId && /^[0-9a-f-]{36}$/i.test(grantId) ? `grant-${grantId}` : 'connected-apps'}`,
  admin: '/admin',
  /** The notification inbox (P6, FR-NOT-1): one list across every org. */
  inbox: '/inbox',
  /** The user guide (ADR 0052 §2): the page list, and one page per slug. */
  help: '/help',
  helpPage: (slug: string) => `/help/${slug}`,
} as const;

const savedViewPath = /^\/o\/[^/]+\/v\/([^/]+)\/?$/;

/**
 * The view a path shows (`/o/<slug>/v/<id>`, ADR 0073 B): its ID, `'new'` for "+ New view", or
 * null for any other path (the pane over a view is `/o/<slug>/t/<id>`, as for every list).
 */
export function savedViewIdOfPath(pathname: string): string | null {
  return savedViewPath.exec(pathname)?.[1] ?? null;
}
