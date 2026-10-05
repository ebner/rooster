import type { ReactNode } from 'react';

export interface AdminPageProps {
  allowlist: ReactNode;
  users: ReactNode;
}

/** Instance administration (FR-AUTH-8). Backups (P2) and System (P11) join later. */
export function AdminPage({ allowlist, users }: AdminPageProps) {
  return (
    <div className="flex max-w-pane-max flex-col gap-12">
      {allowlist}
      {users}
    </div>
  );
}
