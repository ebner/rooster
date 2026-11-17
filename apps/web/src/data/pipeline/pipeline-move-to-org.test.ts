import {
  childrenOf,
  inverseOfSequence,
  type ListOpSpec,
  type ListState,
  listOps,
  tasksInGroup,
} from '@rooster/core/reducers';
import type { MyList, Task, TaskDetail } from '@rooster/core/schemas';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { createFixtureTransport } from './fixture-transport';
import { everyoneRootKey, ListPipeline, myListKey, tagsKey, taskDetailKey } from './pipeline';
import type { ListTransport } from './transport';

/** ADR 0072 §20: the `task.moveToOrg` op in the pipeline. */

const userId = '01900000-0000-7000-8000-000000000001';
const src = '01900000-0000-7000-8000-0000000000aa';
const dst = '01900000-0000-7000-8000-0000000000bb';
const ctx = { userId };

function server() {
  return createFixtureTransport({
    userId,
    tags: [{ name: 'home' }],
    tasks: { 1: ['A', { title: 'P', subtasks: ['S1', 'S2'], tags: ['home'] }, 'B'] },
  });
}

async function setup(transport: ListTransport = server()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pipeline = new ListPipeline({
    transport,
    queryClient,
    clientId: 'client-1',
    backoffMs: () => 0,
  });
  // Both lists are on screen (active queries refetch when invalidated).
  for (const org of [src, dst]) {
    const observer = new QueryObserver(queryClient, {
      queryKey: myListKey(org),
      queryFn: () => pipeline.fetch(org),
      staleTime: 30_000,
    });
    observer.subscribe(() => {});
    await vi.waitFor(() => expect(pipeline.view(org)).toBeDefined());
  }
  const view = (org: string) => pipeline.view(org) as ListState;
  const byTitle = (org: string, title: string) =>
    Object.values(view(org).tasks).find((t) => t.title === title) as Task;
  const today = (org: string) =>
    Object.values(view(org).groups).find((g) => g.name === 'Today')?.id as string;
  const titles = (org: string) => tasksInGroup(view(org), today(org)).map((t) => t.title);
  return { queryClient, pipeline, view, byTitle, today, titles };
}

/** One user operation as the list controller runs it: the inverse first, then the enqueue. */
function run(pipeline: ListPipeline, specs: ListOpSpec[]) {
  const before = pipeline.view(src) as ListState;
  const inverse = inverseOfSequence(specs, before, { ...ctx, now: Date.now() });
  pipeline.enqueue(src, specs, ctx);
  return inverse;
}

describe('ListPipeline: moving tasks to another org', () => {
  test('queues under the source org, leaves its list at once, and refetches the target', async () => {
    const transport = server();
    const { pipeline, byTitle, titles, today, queryClient } = await setup(transport);
    const p = byTitle(src, 'P');
    const s1 = byTitle(src, 'S1');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    pipeline.enqueue(
      dst, // whichever list runs it: a move is queued under its source org (`entityId`)
      [listOps.moveTasksToOrg(src, { ids: [p.id], orgId: dst, groupId: today(dst) })],
      ctx,
    );
    expect(titles(src)).toEqual(['A', 'B']);
    expect(pipeline.pendingOps(src).map((op) => op.kind)).toEqual(['task.moveToOrg']);
    expect(titles(dst)).toEqual(['A', 'P', 'B']); // the target learns it from the server
    await pipeline.idle();
    await vi.waitFor(() => expect(titles(dst)).toEqual(['P', 'A', 'P', 'B']));
    expect(titles(src)).toEqual(['A', 'B']);
    const moved = (pipeline.view(dst) as ListState).tasks[p.id];
    expect(moved?.orgId).toBe(dst);
    expect(moved?.placement?.groupId).toBe(today(dst));
    expect(childrenOf(pipeline.view(dst) as ListState, p.id).map((t) => t.title)).toEqual([
      'S1',
      'S2',
    ]);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(everyoneRootKey(dst));
    expect(keys).toContainEqual(tagsKey(dst));
    expect(keys).toContainEqual(taskDetailKey(p.id));
    expect(keys).toContainEqual(taskDetailKey(s1.id));
  });

  test('undo queues the move back under the target org and shows the tasks at once', async () => {
    const transport = server();
    const { pipeline, byTitle, titles, today } = await setup(transport);
    const p = byTitle(src, 'P');
    const s1 = byTitle(src, 'S1');
    const inverse = run(pipeline, [
      listOps.moveTasksToOrg(src, { ids: [p.id], orgId: dst, groupId: today(dst) }),
    ]);
    await pipeline.idle();
    await vi.waitFor(() => expect(titles(dst)).toEqual(['P', 'A', 'P', 'B']));

    pipeline.enqueue(src, inverse, ctx);
    expect(pipeline.pendingOps(dst).map((op) => op.kind)).toEqual(['task.moveToOrg']);
    // Optimistic in both lists before the server answers.
    expect(titles(src)).toEqual(['A', 'P', 'B']);
    expect(titles(dst)).toEqual(['A', 'P', 'B']);
    expect(byTitle(src, 'S1')).toEqual(s1);
    await pipeline.idle();
    await vi.waitFor(() => expect(byTitle(src, 'P')?.seq).toBe(p.seq));
    expect(titles(src)).toEqual(['A', 'P', 'B']);
    expect(titles(dst)).toEqual(['A', 'P', 'B']);
    // The server agrees: the same position, the old numbers back (§7).
    const serverSrc = transport.state(src);
    expect(tasksInGroup(serverSrc, today(src)).map((t) => t.title)).toEqual(['A', 'P', 'B']);
    expect(serverSrc.tasks[s1.id]?.seq).toBe(s1.seq);
  });

  test('undoing a detached subtask re-parents it in the source org, at its slot', async () => {
    const transport = server();
    const { pipeline, byTitle, titles, today } = await setup(transport);
    const p = byTitle(src, 'P');
    const s1 = byTitle(src, 'S1');
    const inverse = run(pipeline, [
      listOps.moveTasksToOrg(src, { ids: [s1.id], orgId: dst, groupId: today(dst) }),
    ]);
    expect(byTitle(src, 'P').counts.subtasks).toBe(1);
    await pipeline.idle();
    await vi.waitFor(() => expect(titles(dst)).toEqual(['S1', 'A', 'P', 'B']));

    pipeline.enqueue(src, inverse, ctx);
    expect(pipeline.pendingOps(dst).map((op) => op.kind)).toEqual(['task.moveToOrg']);
    // The source org's pending ops include the move arriving in it.
    expect(pipeline.pendingOps(src).map((op) => op.kind)).toEqual([
      'task.moveToOrg',
      'task.patch',
      'task.reorder',
    ]);
    expect(childrenOf(pipeline.view(src) as ListState, p.id).map((t) => t.title)).toEqual([
      'S1',
      'S2',
    ]);
    await pipeline.idle();
    const serverSrc = transport.state(src);
    expect(childrenOf(serverSrc, p.id).map((t) => t.title)).toEqual(['S1', 'S2']);
    expect(serverSrc.tasks[s1.id]?.placement).toBeNull();
    expect(serverSrc.tasks[p.id]?.counts.subtasks).toBe(2);
  });

  test('a refused move is reverted in the source org', async () => {
    const transport = server();
    const { pipeline, byTitle, titles } = await setup(transport);
    const dropped: string[] = [];
    pipeline.onDropped(({ error }) => dropped.push(error.code));
    transport.failNext(422, 'same_org');
    pipeline.enqueue(
      src,
      [listOps.moveTasksToOrg(src, { ids: [byTitle(src, 'P').id], orgId: dst })],
      ctx,
    );
    expect(titles(src)).toEqual(['A', 'B']);
    await pipeline.idle();
    expect(titles(src)).toEqual(['A', 'P', 'B']);
    expect(dropped).toEqual(['same_org']);
  });

  test("a snapshot fetched before the move can't bring the moved tasks back", async () => {
    const transport = server();
    let hold = false;
    let release: (list: MyList) => void = () => {};
    const slow: ListTransport = {
      ...transport,
      fetchMyList: (org) => {
        if (!hold) return transport.fetchMyList(org);
        hold = false;
        return new Promise<MyList>((resolve) => {
          release = resolve;
        });
      },
    };
    const { pipeline, byTitle, titles } = await setup(slow);
    const old = await transport.fetchMyList(src);
    hold = true;
    const reading = pipeline.fetch(src); // in flight while the move is confirmed
    pipeline.enqueue(
      src,
      [listOps.moveTasksToOrg(src, { ids: [byTitle(src, 'P').id], orgId: dst })],
      ctx,
    );
    await pipeline.idle();
    release(old);
    const state = await reading;
    expect(Object.values(state.tasks).map((t) => t.title)).not.toContain('P');
    expect(titles(src)).toEqual(['A', 'B']);
  });

  test('later ops on a moved task still go out (by id)', async () => {
    const transport = server();
    const sent: string[] = [];
    const spy: ListTransport = {
      ...transport,
      send: (op, org) => {
        sent.push(`${op.kind}@${org === src ? 'src' : 'dst'}`);
        return transport.send(op, org);
      },
    };
    const { pipeline, byTitle } = await setup(spy);
    const p = byTitle(src, 'P');
    pipeline.enqueue(src, [listOps.moveTasksToOrg(src, { ids: [p.id], orgId: dst })], ctx);
    pipeline.enqueue(src, [listOps.patchTask(p.id, { title: 'P2' })], ctx);
    expect(pipeline.hasPending(p.id)).toBe(true);
    await pipeline.idle();
    expect(sent).toEqual(['task.moveToOrg@src', 'task.patch@src']);
  });

  test("a moved task's detail cache is refetched", async () => {
    const { pipeline, byTitle, queryClient } = await setup();
    const p = byTitle(src, 'P');
    const detail = { ...p, description: '', subtasks: [], parentChain: [], followers: [] };
    queryClient.setQueryData<TaskDetail>(taskDetailKey(p.id), detail);
    pipeline.enqueue(src, [listOps.moveTasksToOrg(src, { ids: [p.id], orgId: dst })], ctx);
    await pipeline.idle();
    expect(queryClient.getQueryState(taskDetailKey(p.id))?.isInvalidated).toBe(true);
  });

  test('knows which tasks the server has not created yet', async () => {
    const { pipeline, byTitle } = await setup();
    const p = byTitle(src, 'P');
    pipeline.enqueue(
      src,
      [
        listOps.createTask({ id: 'new-1', title: 'New' }),
        listOps.duplicateTask(p.id, 'copy-1'),
        listOps.completeTask(p.id, true, 'next-1'),
      ],
      ctx,
    );
    expect(pipeline.createsPending('new-1')).toBe(true);
    expect(pipeline.createsPending('copy-1')).toBe(true);
    expect(pipeline.createsPending('next-1')).toBe(true);
    expect(pipeline.createsPending(p.id)).toBe(false);
    await pipeline.idle();
    expect(pipeline.createsPending('new-1')).toBe(false);
  });
});
