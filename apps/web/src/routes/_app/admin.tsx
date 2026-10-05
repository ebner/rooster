import { createFileRoute, notFound } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  meQueryOptions,
  useAddAllowlistEntry,
  useAdminUsers,
  useAllowlist,
  useDisplayPrefs,
  useMe,
  useRemoveAllowlistEntry,
  useSetUserDisabled,
} from '../../data';
import { AdminPage } from '../../features/admin/admin-page';
import { AllowlistSection } from '../../features/admin/allowlist-section';
import { UsersSection } from '../../features/admin/users-section';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';
import { toast } from '../../ui/toast';

/** Instance admins only; everyone else gets the plain 404 (no hint that it exists). */
export const Route = createFileRoute('/_app/admin')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions);
    if (!me.user.isAdmin) throw notFound();
  },
  component: AdminRoute,
});

function AdminRoute() {
  const { t } = useTranslation('admin');
  const me = useMe();
  const allowlist = useAllowlist();
  const users = useAdminUsers();
  const prefs = useDisplayPrefs();
  const add = useAddAllowlistEntry();
  const remove = useRemoveAllowlistEntry();
  const setDisabled = useSetUserDisabled();

  if (!me.data) return null;
  const now = Date.now();
  const failed = () => toast({ message: t('error.saveFailed'), tone: 'danger' });

  return (
    <>
      <ViewHeader title={t('title')} />
      <ViewBody>
        <AdminPage
          allowlist={
            <AllowlistSection
              entries={allowlist.data ?? []}
              prefs={prefs}
              now={now}
              onAdd={async (entry) => {
                await add.mutateAsync(entry);
              }}
              onRemove={(id) =>
                remove
                  .mutateAsync({ id })
                  .then(() => toast({ message: t('allowlist.removed') }))
                  .catch(failed)
              }
            />
          }
          users={
            <UsersSection
              users={users.data ?? []}
              currentUserId={me.data.user.id}
              prefs={prefs}
              now={now}
              onSetDisabled={(userId, disabled) =>
                setDisabled
                  .mutateAsync({ userId, disabled })
                  .then(() =>
                    toast({
                      message: disabled ? t('users.disabledToast') : t('users.enabledToast'),
                    }),
                  )
                  .catch(failed)
              }
            />
          }
        />
      </ViewBody>
    </>
  );
}
