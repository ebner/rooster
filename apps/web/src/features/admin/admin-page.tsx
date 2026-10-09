import type { ReactNode } from 'react';

export interface AdminPageProps {
  allowlist: ReactNode;
  users: ReactNode;
  backups?: ReactNode;
  /** Push key rotation (P7), when the server delivers push. */
  pushKeys?: ReactNode;
}

/**
 * Instance administration (FR-AUTH-8), backups (WP 2.9) and push keys (WP 7.1). System (P11)
 * joins later.
 */
export function AdminPage({ allowlist, users, backups, pushKeys }: AdminPageProps) {
  return (
    <div className="flex max-w-pane-max flex-col gap-12">
      {allowlist}
      {users}
      {backups}
      {pushKeys}
    </div>
  );
}
