import { listOps } from '@rooster/core/reducers';
import type { SavedViewQuery, Task } from '@rooster/core/schemas';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
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

/** Keeps a cache shown (a screen observes it), as the view screen does. */
function observe(queryClient: QueryClient, key: readonly unknown[]) {
  return new QueryObserver(queryClient, { queryKey: key, enabled: false }).subscribe(() => {});
}

describe('applyOpToViewTasks, bulk', () => {
  test('a bulk assign of a parent and its subtask keeps the subtask, reassigned', () => {
    const rows = applyOpToViewTasks(
      [task('p', { assigneeId: anna }), task('s', { parentId: 'p', assigneeId: anna })],
      listOps.bulk(org, { op: 'assign', ids: ['p', 's'], args: { assigneeId: me } }),
      ctx,
      org,
    );
    expect(rows.map((t) => [t.id, t.assigneeId]).sort()).toEqual([
      ['p', me],
      ['s', me],
    ]);
  });
});

describe('the cache', () => {
  test('a fetch replays queued ops; the pipeline writes new ops into a shown cache at once', async () => {
    const { pipeline, queryClient, transport, tagId } = await viewSetup();
    transport.send = () => new Promise(() => {});
    const id = (title: string) =>
      Object.values(transport.state(org).tasks).find((t) => t.title === title)?.id as string;
    pipeline.enqueue(org, [listOps.removeTag(id('Tagged'), tagId)], ctx);
    const data = await fetchViewTasks(pipeline, org, 'v1', false);
    // The server doesn't know yet; the queued op is replayed over its answer.
    expect(data.items.find((t) => t.title === 'Tagged')?.tagIds).toEqual([]);
    queryClient.setQueryData(viewTasksKey('v1', false), data);
    observe(queryClient, viewTasksKey('v1', false));
    pipeline.enqueue(org, [listOps.completeTask(id('Other tagged'), true)], ctx);
    const after = queryClient.getQueryData<ViewTasksData>(viewTasksKey('v1', false));
    expect(after?.items.find((t) => t.title === 'Other tagged')?.completedAt).not.toBeNull();
  });

  test('a cache no screen shows takes no ops: it is marked stale instead (no growth)', async () => {
    const { pipeline, queryClient, transport } = await viewSetup();
    transport.send = () => new Promise(() => {});
    const data = await fetchViewTasks(pipeline, org, 'v1', false);
    queryClient.setQueryData(viewTasksKey('v1', false), data);
    pipeline.enqueue(org, [listOps.createTask({ id: 'n1', title: 'Elsewhere' })], ctx);
    expect(queryClient.getQueryData<ViewTasksData>(viewTasksKey('v1', false))?.items).toBe(
      data.items,
    );
    expect(queryClient.getQueryState(viewTasksKey('v1', false))?.isInvalidated).toBe(true);
  });

  test('a restored outbox never replays onto a persisted cache that holds its ops already', async () => {
    const { pipeline, queryClient } = await viewSetup();
    const counted = task('c1', {
      counts: { subtasks: 0, subtasksDone: 0, comments: 1, attachments: 0 },
    });
    queryClient.setQueryData(viewTasksKey('v1', false), {
      orgId: org,
      items: [counted],
      counts: { open: 1, done: 0 },
    } satisfies ViewTasksData);
    const op = {
      ...listOps.createComment('c1', { id: 'm1', body: 'Hi' }),
      opId: 'op-1',
      editTime: 1,
      clientId: 'other',
    };
    pipeline.restore(new Map(), [{ op, orgId: org, ctx }]);
    const after = queryClient.getQueryData<ViewTasksData>(viewTasksKey('v1', false));
    expect(after?.items[0]?.counts.comments).toBe(1);
    expect(queryClient.getQueryState(viewTasksKey('v1', false))?.isInvalidated).toBe(true);
  });

  test('a task the view lacks that gets its tag: the view is refetched once confirmed', async () => {
    const { pipeline, queryClient, transport, tagId } = await viewSetup();
    queryClient.setQueryData(
      viewTasksKey('v1', false),
      await fetchViewTasks(pipeline, org, 'v1', false),
    );
    observe(queryClient, viewTasksKey('v1', false));
    const plain = Object.values(transport.state(org).tasks).find((t) => t.title === 'Plain');
    pipeline.enqueue(org, [listOps.addTag(plain?.id as string, tagId)], ctx);
    await pipeline.idle();
    expect(queryClient.getQueryState(viewTasksKey('v1', false))?.isInvalidated).toBe(true);
  });

  test('undoing a delete restores to each cache its own rows (Everyone’s and a view’s)', async () => {
    const queryClient = new QueryClient();
    const transport = createFixtureTransport({ userId: me });
    transport.send = () => new Promise(() => {});
    const pipeline = getListPipeline(queryClient, transport);
    const parent = task('p');
    const child = task('c', { parentId: 'p' });
    // Everyone's holds the parent only (the subtask shares its assignee); the view both.
    queryClient.setQueryData(['everyone', org, 'open'], [parent]);
    queryClient.setQueryData(viewTasksKey('v1', false), {
      orgId: org,
      items: [parent, child],
      counts: { open: 2, done: 0 },
    } satisfies ViewTasksData);
    observe(queryClient, viewTasksKey('v1', false));
    pipeline.enqueue(org, [listOps.deleteTask('p')], ctx);
    expect(queryClient.getQueryData<Task[]>(['everyone', org, 'open'])).toEqual([]);
    pipeline.enqueue(org, [listOps.restoreTask('p')], ctx);
    expect(queryClient.getQueryData<Task[]>(['everyone', org, 'open'])?.map((t) => t.id)).toEqual([
      'p',
    ]);
    expect(
      queryClient
        .getQueryData<ViewTasksData>(viewTasksKey('v1', false))
        ?.items.map((t) => t.id)
        .sort(),
    ).toEqual(['c', 'p']);
  });
});

describe('viewCounts', () => {
  const fetched = (items: Task[], counts: { open: number; done: number }): ViewTasksData => ({
    orgId: org,
    items,
    counts,
    baseline: items,
  });

  test('unchanged: the server’s counts, whatever rows the cache holds', () => {
    // A `done` view's rows hold only the completed matches, plus a breadcrumb parent.
    const data = fetched(
      [task('b', { completedAt: 3 }), task('parent', { tagIds: [], completedAt: 2 })],
      { open: 7, done: 12 },
    );
    expect(viewCounts(data, { ...query, status: 'done' }, matchCtx)).toEqual({
      open: 7,
      done: 12,
    });
  });

  test('changes since the fetch move them: completed, untagged, deleted, created', () => {
    const base = fetched(
      [task('a'), task('b', { completedAt: 3 }), task('c', { completedAt: 3 })],
      {
        open: 4,
        done: 9,
      },
    );
    const items = [
      task('a', { completedAt: 5 }),
      // Untagged while done, and `c` deleted: two fewer done.
      task('b', { completedAt: 3, tagIds: [] }),
      task('new'),
    ];
    expect(viewCounts({ ...base, items }, query, matchCtx)).toEqual({ open: 4, done: 8 });
  });
});
