/** TanStack Query keys (04 §5.1 style): one root per resource, then its scope. */
export const queryKeys = {
  meta: ['meta'] as const,
  me: ['me'] as const,
  sessions: ['sessions'] as const,
  orgMembers: (orgId: string) => ['org-members', orgId] as const,
  orgInvites: (orgId: string) => ['org-invites', orgId] as const,
  invitePreview: (token: string) => ['invite-preview', token] as const,
  allowlist: ['admin', 'allowlist'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminBackups: ['admin', 'backups'] as const,
  /** P11. Admin → System (08 §9). */
  adminSystem: ['admin', 'system'] as const,
  /** `scope`: an org ID, or `all` for every org of the viewer. */
  search: (scope: string, q: string) => ['search', scope, q] as const,
  /** SSE invalidates `['trash', orgId]` (04 §4.5); the pages hang below it. */
  trash: (orgId: string) => ['trash', orgId] as const,
  /** P6. SSE invalidates `['everyone', orgId]`; the filter variants hang below it. */
  everyone: (orgId: string, filters: string) => ['everyone', orgId, filters] as const,
  /** P6. The task's comment and activity feed (SSE `['activity', taskId]`). */
  activity: (taskId: string) => ['activity', taskId] as const,
  /** P6. The notification inbox (SSE `['notifications']`); the filter hangs below it. */
  notifications: (filter: 'all' | 'unread') => ['notifications', filter] as const,
  notificationPrefs: ['notification-prefs'] as const,
  /** P9. The OAuth consent screen's request (11 §3.1), by the provider's signed query. */
  oauthConsent: (oauthQuery: string) => ['oauth-consent', oauthQuery] as const,
  /** P9. Settings → Security → Linked identities (FR-SET-3). */
  identities: ['identities'] as const,
  /** Removed sign-in identities; under `identities`, so invalidating that refreshes both. */
  removedIdentities: ['identities', 'removed'] as const,
};
