import { emptyListState } from '@rooster/core/reducers';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import { cachedListStates } from './search';

describe('offline search over the cache', () => {
  test('AC-1.0.1 only lists of orgs in the current /me are searched', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['my-list', 'o1'], emptyListState('o1'));
    queryClient.setQueryData(['my-list', 'revoked'], emptyListState('revoked'));
    expect(cachedListStates(queryClient, new Set(['o1'])).map((l) => l.orgId)).toEqual(['o1']);
    expect(cachedListStates(queryClient, new Set())).toEqual([]);
  });
});
