import type { ReactNode } from 'react';

export interface AdminPageProps {
  allowlist: ReactNode;
  users: ReactNode;
  backups?: ReactNode;
}

/** Instance administration (FR-AUTH-8) and backups (WP 2.9). System (P11) joins later. */
export function AdminPage({ allowlist, users, backups }: AdminPageProps) {
  return (
    <div className="flex max-w-pane-max flex-col gap-12">
      {allowlist}
      {users}
      {backups}
    </div>
  );
}
