import type { ReactNode } from 'react';

export interface AdminPageProps {
  allowlist: ReactNode;
  users: ReactNode;
  backups?: ReactNode;
  /** Push key rotation (P7), when the server delivers push. */
  pushKeys?: ReactNode;
  /** The instance's status (P11, 08 §9). */
  system?: ReactNode;
}

/**
 * Instance administration (FR-AUTH-8), backups (WP 2.9), push keys (WP 7.1) and, first, the
 * system status (WP 11.5).
 */
export function AdminPage({ allowlist, users, backups, pushKeys, system }: AdminPageProps) {
  return (
    <div className="flex max-w-pane-max flex-col gap-12">
      {system}
      {allowlist}
      {users}
      {backups}
      {pushKeys}
    </div>
  );
}
