import type { Task } from '@rooster/core/schemas';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findOrg, useDisplayPrefs, useMe, useOrgMembers } from '../../data';
import { exportUrl } from '../../data/export';
import { useDeletePermanently, useRestoreFromTrash, useTrash } from '../../data/trash';
import { useMinuteClock } from '../../features/dates/use-viewer-date-context';
import { DataPage } from '../../features/settings/data-page';
import { orgUrlSlug, paths } from '../../features/shell/paths';
import { useSyncStore } from '../../state/sync-store';
import { toast } from '../../ui/toast';

interface DataSearch {
  /** Org slug (`personal` for the personal org); default: the first org. */
  org?: string;
}

export const Route = createFileRoute('/_app/settings/data')({
  validateSearch: (search: Record<string, unknown>): DataSearch =>
    typeof search.org === 'string' ? { org: search.org } : {},
  component: DataRoute,
});

/** FR-SET-5: export and Trash, per org (online only). */
function DataRoute() {
  const { t } = useTranslation('settings');
  const me = useMe().data;
  const search = Route.useSearch();
  const navigate = useNavigate();
  const online = useSyncStore((s) => s.online);
  const prefs = useDisplayPrefs();
  const now = useMinuteClock();
  const org = me ? ((search.org ? findOrg(me.orgs, search.org) : null) ?? me.orgs[0]) : undefined;
  const trash = useTrash(org?.id);
  const members = useOrgMembers(org?.id);
  const restore = useRestoreFromTrash();
  const remove = useDeletePermanently();
  const [pendingId, setPendingId] = useState<string | null>(null);
  if (!me || !org) return null;

  const failed = () => toast({ message: t('data.failed'), tone: 'danger' });
  const run = async (task: Task, action: () => Promise<unknown>) => {
    setPendingId(task.id);
    try {
      await action();
    } finally {
      setPendingId(null);
    }
  };

  return (
    <DataPage
      orgs={me.orgs}
      orgId={org.id}
      onOrgChange={(orgId) => {
        const next = me.orgs.find((o) => o.id === orgId);
        if (next) {
          void navigate({
            href: `${paths.settings('data')}?org=${orgUrlSlug(next)}`,
            replace: true,
          });
        }
      }}
      online={online}
      exportHref={(format) => exportUrl(org.id, format)}
      trash={{
        items: trash.items,
        error: trash.error,
        hasMore: trash.hasMore,
        isLoadingMore: trash.isLoadingMore,
        onLoadMore: trash.loadMore,
      }}
      nameOf={(userId) => members.data?.find((m) => m.userId === userId)?.name ?? null}
      viewerId={me.user.id}
      pendingId={pendingId}
      prefs={prefs}
      now={now}
      storage={me.storage}
      onRestore={(task) =>
        void run(task, () =>
          restore.mutateAsync({ orgId: org.id, taskId: task.id }).then(
            () =>
              toast({
                message: t('data.restored', { title: task.title }),
                action: {
                  label: t('data.show'),
                  onAction: () => void navigate({ href: paths.task(orgUrlSlug(org), task.id) }),
                },
              }),
            failed,
          ),
        )
      }
      onDeletePermanently={(task) =>
        void run(task, () =>
          remove
            .mutateAsync({ orgId: org.id, taskId: task.id })
            .then(() => toast({ message: t('data.deleted', { title: task.title }) }), failed),
        )
      }
    />
  );
}
