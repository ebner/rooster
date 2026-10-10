import { listOps } from '@rooster/core/reducers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test } from 'vitest';
import { fixtureMe } from '../features/shell/fixtures';
import { getListPipeline, ListTransportContext } from './list';
import { createFixtureTransport } from './pipeline/fixture-transport';
import { queryKeys } from './query-keys';
import { useTaskDetail } from './task-detail';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';
const HOUR = 3_600_000;

async function setup() {
  const transport = createFixtureTransport({
    userId,
    tasks: {
      1: [
        {
          title: 'Dentist',
          dueDate: '2030-03-04',
          dueTime: '14:00',
          dueTz: 'UTC',
          reminders: [60],
        },
      ],
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, fixtureMe);
  const pipeline = getListPipeline(queryClient, transport);
  await pipeline.fetch(orgId);
  const taskId = Object.values(transport.state(orgId).tasks).find((t) => t.title === 'Dentist')
    ?.id as string;
  // Offline: every op stays queued.
  transport.send = () => new Promise(() => {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>{children}</ListTransportContext.Provider>
    </QueryClientProvider>
  );
  // The pane of a task My tasks shows: only what the list cannot show is overlaid.
  const hook = renderHook(() => useTaskDetail(taskId, orgId, userId, true), { wrapper });
  await waitFor(() => expect(hook.result.current.data?.reminders).toHaveLength(1));
  return { pipeline, taskId, hook };
}

describe('the pane detail of a task in My tasks (descriptionOnly)', () => {
  test('a queued due change re-resolves its reminders before the server confirms', async () => {
    const { pipeline, taskId, hook } = await setup();
    const fireAt = Date.UTC(2030, 2, 4, 13);
    expect(hook.result.current.data?.reminders?.[0]?.fireAt).toBe(fireAt);
    pipeline.enqueue(
      orgId,
      [listOps.patchTask(taskId, { dueDate: '2030-03-05', dueTime: '14:00', dueTz: 'UTC' })],
      { userId },
    );
    await waitFor(() =>
      expect(hook.result.current.data?.reminders?.[0]?.fireAt).toBe(fireAt + 24 * HOUR),
    );
  });

  test('a queued cleared date shows its reminders as dormant', async () => {
    const { pipeline, taskId, hook } = await setup();
    pipeline.enqueue(orgId, [listOps.patchTask(taskId, { dueDate: null })], { userId });
    await waitFor(() => expect(hook.result.current.data?.reminders?.[0]?.fireAt).toBeNull());
    expect(hook.result.current.data?.nextReminderAt).toBeNull();
  });

  test('a queued clearReminders patch empties the list', async () => {
    const { pipeline, taskId, hook } = await setup();
    pipeline.enqueue(orgId, [listOps.patchTask(taskId, { clearReminders: true })], { userId });
    await waitFor(() => expect(hook.result.current.data?.reminders).toEqual([]));
  });
});
