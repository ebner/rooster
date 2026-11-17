import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import { dropGoneViewCaches, invalidateViewsFor } from './view-invalidation';

/** ADR 0073 B: the task keys the server sends refetch the org's views and their rows. */

const org = 'org-1';
const other = 'org-2';

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['views', org, 'live'], []);
  queryClient.setQueryData(['views', other, 'live'], []);
  queryClient.setQueryData(['view-tasks', 'v1', 'open'], {
    orgId: org,
    items: [{ id: 't1' }],
    counts: { open: 1, done: 0 },
  });
  queryClient.setQueryData(['view-tasks', 'v2', 'open'], {
    orgId: other,
    items: [],
    counts: { open: 0, done: 0 },
  });
  const stale = (key: unknown[]) => queryClient.getQueryState(key)?.isInvalidated === true;
  return { queryClient, stale };
}

describe('invalidateViewsFor', () => {
  test.each([['everyone'], ['my-list']])('%s of an org: its views and their rows', (root) => {
    const { queryClient, stale } = setup();
    invalidateViewsFor(queryClient, [root, org]);
    expect(stale(['views', org, 'live'])).toBe(true);
    expect(stale(['view-tasks', 'v1', 'open'])).toBe(true);
    expect(stale(['views', other, 'live'])).toBe(false);
    expect(stale(['view-tasks', 'v2', 'open'])).toBe(false);
  });

  test('a task: only the views holding it', () => {
    const { queryClient, stale } = setup();
    invalidateViewsFor(queryClient, ['task', 't1']);
    expect(stale(['view-tasks', 'v1', 'open'])).toBe(true);
    expect(stale(['view-tasks', 'v2', 'open'])).toBe(false);
    expect(stale(['views', org, 'live'])).toBe(false);
  });
});

describe('dropGoneViewCaches', () => {
  test('a view gone from its org’s live list loses its rows’ caches', () => {
    const { queryClient } = setup();
    const stop = dropGoneViewCaches(queryClient);
    queryClient.setQueryData(['views', org, 'live'], [{ id: 'v9' }]);
    expect(queryClient.getQueryData(['view-tasks', 'v1', 'open'])).toBeUndefined();
    // Another org's views are not touched.
    expect(queryClient.getQueryData(['view-tasks', 'v2', 'open'])).toBeDefined();
    stop();
  });
});
