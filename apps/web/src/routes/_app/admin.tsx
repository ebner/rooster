import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
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
import { NotAllowed } from '../../features/shell/org-not-found';
import { toast } from '../../ui/toast';

export const Route = createFileRoute('/_app/admin')({
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
  if (!me.data.user.isAdmin) return <NotAllowed />;
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
