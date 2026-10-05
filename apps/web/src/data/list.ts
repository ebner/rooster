import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ok } from './query-result';
import type { ListGroup, QueryResult } from './types';

/**
 * The default groups every membership starts with (FR-AUTH-3), named in the UI
 * language. Phase 1 has no group endpoint; P2 replaces this with `GET …/my-list`.
 */
export function useMyGroups(orgId: string | undefined): QueryResult<ListGroup[]> {
  const { t } = useTranslation('shell');
  return useMemo(
    () =>
      ok(
        orgId
          ? [
              { id: `${orgId}-inbox`, kind: 'inbox' as const, name: t('groups.inbox') },
              { id: `${orgId}-today`, kind: 'normal' as const, name: t('groups.today') },
              { id: `${orgId}-prio`, kind: 'normal' as const, name: t('groups.prio') },
              { id: `${orgId}-upcoming`, kind: 'normal' as const, name: t('groups.upcoming') },
            ]
          : [],
      ),
    [orgId, t],
  );
}
