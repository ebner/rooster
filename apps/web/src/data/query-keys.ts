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
};
