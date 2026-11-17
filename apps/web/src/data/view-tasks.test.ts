import { listOps } from '@rooster/core/reducers';
import type { SavedViewQuery, Task } from '@rooster/core/schemas';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import { getListPipeline } from './list';
import { createFixtureTransport } from './pipeline/fixture-transport';
import { applyOpToViewTasks, type ViewTasksData } from './pipeline/view-tasks-ops';
import { fetchViewTasks, viewCounts, viewTasksKey } from './view-tasks';

/** ADR 0073 B: a view's rows cache, kept optimistic by the pipeline. */

const me = '01900000-0000-7000-8000-000000000001';
const anna = '01900000-0000-7000-8000-000000000002';
const org = '01900000-0000-7000-8000-0000000000aa';
const ctx = { userId: me, timezone: 'UTC', allDayReminderTime: '09:00', now: 5 };

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    orgId: org,
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title: id,
    assigneeId: me,
    createdBy: me,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    tagIds: ['t1'],
    completedAt: null,
    hasDescription: false,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const query: SavedViewQuery = {
  tags: ['t1'],
  tagMode: 'any',
  assignee: 'anyone',
  due: 'any',
  status: 'open',
};
const matchCtx = { viewerId: me, due: { today: '2030-01-01', nowMs: 0, viewerTz: 'UTC' } };

describe('applyOpToViewTasks', () => {
  test('a subtask is a row of its own, even when it shares its parent’s assignee', () => {
    const rows = applyOpToViewTasks(
      [task('p')],
      listOps.createTask({ id: 's', title: 'Sub', parentId: 'p', tagIds: ['t1'] }),
      ctx,
      org,
    );
    expect(rows.map((t) => [t.id, t.assigneeId, t.orgId])).toEqual([
      ['p', me, org],
      ['s', me, org],
    ]);
    expect(rows[0]?.counts.subtasks).toBe(1);
  });

  test('a task created into an empty view takes the view’s org', () => {
    const rows = applyOpToViewTasks([], listOps.createTask({ id: 'n', title: 'New' }), ctx, org);
    expect(rows[0]?.orgId).toBe(org);
  });

  test('reassigning a parent keeps its subtask rows (Everyone’s would fold them)', () => {
    const rows = applyOpToViewTasks(
      [task('p', { assigneeId: anna }), task('s', { parentId: 'p' })],
      listOps.patchTask('p', { assigneeId: me }),
      ctx,
      org,
    );
    expect(rows.map((t) => t.id).sort()).toEqual(['p', 's']);
  });
});

async function viewSetup() {
  const transport = createFixtureTransport({
    userId: me,
    tasks: {
      0: [
        { title: 'Tagged', tags: ['juniper'] },
        { title: 'Other tagged', tags: ['juniper'] },
        'Plain',
      ],
    },
  });
  await transport.fetchMyList(org);
  const tagId = transport.tags(org)[0]?.id as string;
  transport.views.set('v1', { id: 'v1', orgId: org, query: { ...query, tags: [tagId] } });
  const queryClient = new QueryClient();
  const pipeline = getListPipeline(queryClient, transport);
  await queryClient.fetchQuery({ queryKey: ['my-list', org], queryFn: () => pipeline.fetch(org) });
  return { transport, queryClient, pipeline, tagId };
}

describe('the cache', () => {
  test('a fetch replays queued ops; the pipeline writes new ops into the cache at once', async () => {
    const { pipeline, queryClient, transport, tagId } = await viewSetup();
    transport.send = () => new Promise(() => {});
    const id = (title: string) =>
      Object.values(transport.state(org).tasks).find((t) => t.title === title)?.id as string;
    pipeline.enqueue(org, [listOps.removeTag(id('Tagged'), tagId)], ctx);
    const data = await fetchViewTasks(pipeline, org, 'v1', false);
    // The server doesn't know yet; the queued op is replayed over its answer.
    expect(data.items.find((t) => t.title === 'Tagged')?.tagIds).toEqual([]);
    queryClient.setQueryData(viewTasksKey('v1', false), data);
    pipeline.enqueue(org, [listOps.completeTask(id('Other tagged'), true)], ctx);
    const after = queryClient.getQueryData<ViewTasksData>(viewTasksKey('v1', false));
    expect(after?.items.find((t) => t.title === 'Other tagged')?.completedAt).not.toBeNull();
  });

  test('a task the view lacks that gets its tag: the view is refetched once confirmed', async () => {
    const { pipeline, queryClient, transport, tagId } = await viewSetup();
    queryClient.setQueryData(
      viewTasksKey('v1', false),
      await fetchViewTasks(pipeline, org, 'v1', false),
    );
    const plain = Object.values(transport.state(org).tasks).find((t) => t.title === 'Plain');
    pipeline.enqueue(org, [listOps.addTag(plain?.id as string, tagId)], ctx);
    await pipeline.idle();
    expect(queryClient.getQueryState(viewTasksKey('v1', false))?.isInvalidated).toBe(true);
  });

  test('counts: the server’s, plus what changed since; breadcrumb parents never count', () => {
    const data: ViewTasksData = {
      orgId: org,
      items: [
        task('a'),
        task('b', { completedAt: 3 }),
        // A completed parent sent for a breadcrumb, already in the server's done count.
        task('parent', { completedAt: 2 }),
        task('untagged', { tagIds: [] }),
      ],
      counts: { open: 2, done: 7 },
      doneAtFetch: ['parent'],
    };
    expect(viewCounts(data, query, matchCtx)).toEqual({ open: 1, done: 8 });
  });
});
