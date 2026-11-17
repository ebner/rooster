import { uuidv7 } from '@rooster/core/ids';
import type { SavedView, SavedViewQuery } from '@rooster/core/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { errorCode } from '../../data/errors';
import { useOrgMembers } from '../../data/orgs';
import { queryKeys } from '../../data/query-keys';
import { useTags } from '../../data/tags';
import type { Org } from '../../data/types';
import { useCreateView } from '../../data/views';
import { useSyncStore } from '../../state/sync-store';
import { toast } from '../../ui/toast';
import { orgUrlSlug, paths } from '../shell/paths';
import { requestViewNameFocus } from './name-focus';
import { suggestViewName } from './query';

/**
 * "Save as view" (ADR 0073 B7): creates a private view of `org` with a query taken from a
 * filter (My tasks' tags, Everyone's filters, a palette search), named after it, and opens it
 * with the name selected for renaming. Online only, like every change to views.
 */
export function useSaveAsView(org: Org | null | undefined): (query: SavedViewQuery) => void {
  const { t } = useTranslation('views');
  const { t: tPeople } = useTranslation('people');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const online = useSyncStore((s) => s.online);
  const orgId = org?.id ?? '';
  const create = useCreateView(orgId);
  const tags = useTags(org ? orgId : undefined).data ?? [];
  const members = useOrgMembers(org && !org.isPersonal ? orgId : undefined).data ?? [];
  return (query) => {
    if (!org) return;
    if (!online) {
      toast({ message: t('saved.offline'), tone: 'danger' });
      return;
    }
    const name = suggestViewName(query, {
      tags,
      members,
      label: {
        me: t('saved.assignee.me'),
        unassigned: tPeople('unassigned'),
        due: (due) => t(`saved.due.${due}`),
        status: (status) => t(`saved.status.${status}`),
        fallback: t('saved.suggest.fallback'),
      },
    });
    create.mutateAsync({ id: uuidv7(), name, query, shared: false }).then(
      (created) => {
        queryClient.setQueryData<SavedView[]>(queryKeys.views(orgId, false), (list) =>
          list?.some((v) => v.id === created.id) ? list : [...(list ?? []), created],
        );
        void navigate({ href: paths.savedView(orgUrlSlug(org), created.id) });
        requestViewNameFocus();
        toast({ message: t('saved.savedAs', { name: created.name }) });
      },
      (error: unknown) =>
        toast({
          message: t(errorCode(error) === 'view_limit' ? 'saved.limit' : 'saved.saveFailed'),
          tone: 'danger',
        }),
    );
  };
}
