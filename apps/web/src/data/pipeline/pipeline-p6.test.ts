import type { ActivityFeed } from '@rooster/core/activity';
import { feedItems, findComment, itemId } from '@rooster/core/activity';
import { uuidv7 } from '@rooster/core/ids';
import { inverseOf, type ListState, listOps, tasksInGroup } from '@rooster/core/reducers';
import type { Task, TaskDetail } from '@rooster/core/schemas';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { createFixtureTransport } from './fixture-transport';
import { activityKey, everyoneRootKey, ListPipeline, myListKey, taskDetailKey } from './pipeline';
import type { ListTransport } from './transport';

const userId = '01900000-0000-7000-8000-000000000001';
const bob = '01900000-0000-7000-8000-000000000002';
const orgId = '01900000-0000-7000-8000-0000000000aa';
const ctx = { userId };
const everyoneKey = [...everyoneRootKey(orgId), 'open'] as const;

function server() {
  return createFixtureTransport({
    userId,
    members: [{ userId: bob, name: 'Bob' }],
    tasks: {
      0: [
        { title: 'Mine', subtasks: ['Sub'] },
        { title: "Bob's", assignee: bob },
      ],
      1: [{ title: 'A', comments: ['First', 'Second'] }, 'B'],
    },
  });
}

/** A transport whose sends wait until `release()`. */
function gated(inner: ListTransport) {
  let open: () => void = () => {};
  let gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const transport: ListTransport = {
    ...inner,
    send: async (op, org) => {
      await gate;
      return inner.send(op, org);
    },
  };
  return {
    transport,
    release: () => {
      open();
      gate = Promise.resolve();
    },
  };
}

async function setup(transport: ListTransport) {
  const queryClient = new QueryClient();
  const pipeline = new ListPipeline({
    transport,
    queryClient,
    clientId: 'client-1',
    backoffMs: () => 0,
  });
  queryClient.setQueryData(myListKey(orgId), await pipeline.fetch(orgId));
  const state = pipeline.view(orgId) as ListState;
  const byTitle = (title: string) =>
    Object.values(state.tasks).find((t) => t.title === title) as Task;
  return { queryClient, pipeline, byTitle };
}

async function loadEveryone(pipeline: ListPipeline, queryClient: QueryClient) {
  const page = await pipeline.transport.fetchTasks(orgId, { view: 'everyone', limit: 200 });
  queryClient.setQueryData(everyoneKey, pipeline.withPendingTasks(orgId, page.items));
}

async function loadActivity(pipeline: ListPipeline, queryClient: QueryClient, taskId: string) {
  const page = await pipeline.transport.fetchActivity(taskId, {});
  const feed: ActivityFeed = {
    pages: [pipeline.withPendingActivity(taskId, page, true)],
    pageParams: [null],
  };
  queryClient.setQueryData(activityKey(taskId), feed);
}

const rows = (queryClient: QueryClient) => queryClient.getQueryData<Task[]>(everyoneKey) ?? [];
const feedOf = (queryClient: QueryClient, taskId: string) =>
  queryClient.getQueryData<ActivityFeed>(activityKey(taskId)) as ActivityFeed;

describe('assignment through the pipeline (P6)', () => {
  test('assigning away removes my row; the server agrees after the refetch', async () => {
    const fixture = server();
    const { pipeline, byTitle } = await setup(fixture);
    const b = byTitle('B');
    const groupId = b.placement?.groupId as string;
    pipeline.enqueue(orgId, [listOps.patchTask(b.id, { assigneeId: bob })], ctx);
    expect(tasksInGroup(pipeline.view(orgId) as ListState, groupId).map((t) => t.title)).toEqual([
      'A',
    ]);
    await pipeline.idle();
    expect(fixture.state(orgId).tasks[b.id]).toMatchObject({ assigneeId: bob, placement: null });
    const fresh = await pipeline.fetch(orgId);
    expect(fresh.tasks[b.id]).toBeUndefined();
  });

  test('AC-6.2: my parent assigned to Bob turns my subtask into an orphan row', async () => {
    const fixture = server();
    const { pipeline, byTitle } = await setup(fixture);
    const parent = byTitle('Mine');
    const sub = byTitle('Sub');
    pipeline.enqueue(orgId, [listOps.patchTask(parent.id, { assigneeId: bob })], ctx);
    const view = pipeline.view(orgId) as ListState;
    const inbox = parent.placement?.groupId as string;
    expect(tasksInGroup(view, inbox).map((t) => t.title)).toEqual(['Sub']);
    await pipeline.idle();
    const fresh = await pipeline.fetch(orgId);
    expect(fresh.tasks[sub.id]?.placement?.groupId).toBe(inbox);
    // Assigning the parent back to me: the orphan row goes, the subtask shows under it.
    pipeline.enqueue(orgId, [listOps.patchTask(parent.id, { assigneeId: userId })], ctx);
    expect(pipeline.view(orgId)?.tasks[sub.id]?.placement).toBeNull();
    await pipeline.idle();
    expect(fixture.state(orgId).tasks[sub.id]?.placement).toBeNull();
  });

  test('a non-member assignee is refused and reverted', async () => {
    const { pipeline, byTitle } = await setup(server());
    const b = byTitle('B');
    const dropped: string[] = [];
    pipeline.onDropped(({ error }) => dropped.push(error.code));
    pipeline.enqueue(orgId, [listOps.patchTask(b.id, { assigneeId: uuidv7() })], ctx);
    await pipeline.idle();
    expect(dropped).toEqual(['validation_failed']);
    expect(pipeline.view(orgId)?.tasks[b.id]?.assigneeId).toBe(userId);
  });
});

describe('the Everyone caches', () => {
  test('ops apply to every Everyone cache at once and the answers merge', async () => {
    const fixture = server();
    const { pipeline, queryClient, byTitle } = await setup(fixture);
    await loadEveryone(pipeline, queryClient);
    expect(rows(queryClient).map((t) => t.title)).toEqual(['Mine', "Bob's", 'A', 'B']);
    const a = byTitle('A');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    pipeline.enqueue(
      orgId,
      [
        listOps.patchTask(a.id, { title: 'A2', assigneeId: bob }),
        listOps.createTask({ id: uuidv7(), title: 'For Bob', assigneeId: bob }),
      ],
      ctx,
    );
    expect(rows(queryClient).find((t) => t.id === a.id)).toMatchObject({
      title: 'A2',
      assigneeId: bob,
    });
    const created = rows(queryClient).find((t) => t.title === 'For Bob');
    expect(created).toMatchObject({ assigneeId: bob, seq: null });
    await pipeline.idle();
    expect(rows(queryClient).find((t) => t.title === 'For Bob')?.seq).not.toBeNull();
    // The assignment asked for a refetch.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: everyoneRootKey(orgId) });
  });

  test('a refetch keeps queued ops; a later op on the same task keeps its answer out', async () => {
    const fixture = server();
    const { transport, release } = gated(fixture);
    const { pipeline, queryClient, byTitle } = await setup(transport);
    const a = byTitle('A');
    pipeline.enqueue(orgId, [listOps.patchTask(a.id, { title: 'One' })], ctx);
    pipeline.enqueue(orgId, [listOps.patchTask(a.id, { title: 'Two' })], ctx);
    await loadEveryone(pipeline, queryClient);
    expect(rows(queryClient).find((t) => t.id === a.id)?.title).toBe('Two');
    release();
    await pipeline.idle();
    expect(rows(queryClient).find((t) => t.id === a.id)?.title).toBe('Two');
  });

  test('a delete and its undo before the server answers', async () => {
    const fixture = server();
    const { transport, release } = gated(fixture);
    const { pipeline, queryClient, byTitle } = await setup(transport);
    await loadEveryone(pipeline, queryClient);
    const mine = byTitle('Mine');
    pipeline.enqueue(orgId, [listOps.deleteTask(mine.id)], ctx);
    expect(rows(queryClient).some((t) => t.id === mine.id)).toBe(false);
    pipeline.enqueue(orgId, [listOps.restoreTask(mine.id)], ctx);
    expect(rows(queryClient).some((t) => t.id === mine.id)).toBe(true);
    release();
    await pipeline.idle();
    expect(fixture.state(orgId).tasks[mine.id]).toBeDefined();
  });

  test('a dropped op refetches the Everyone caches', async () => {
    const fixture = server();
    const { pipeline, queryClient, byTitle } = await setup(fixture);
    await loadEveryone(pipeline, queryClient);
    fixture.failNext(410, 'conflict_deleted');
    pipeline.enqueue(orgId, [listOps.completeTask(byTitle('B').id, true)], ctx);
    await pipeline.idle();
    expect(queryClient.getQueryState(everyoneKey)?.isInvalidated).toBe(true);
  });

  test('fixture: view=everyone filters and pages', async () => {
    const fixture = server();
    const page = await fixture.fetchTasks(orgId, { view: 'everyone', assignee: bob });
    expect(page.items.map((t) => t.title)).toEqual(["Bob's"]);
    const first = await fixture.fetchTasks(orgId, { view: 'everyone', limit: 3 });
    expect(first.nextCursor).toBe('3');
    const rest = await fixture.fetchTasks(orgId, { view: 'everyone', cursor: '3', limit: 3 });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const none = await fixture.fetchTasks(orgId, { view: 'everyone', assignee: 'none' });
    expect(none.items).toEqual([]);
    const dated = await fixture.fetchTasks(orgId, {
      view: 'everyone',
      hasDue: 'true',
      tag: 'x',
      assignee: ['me', 'any'],
      completed: 'any',
    });
    expect(dated.items).toEqual([]);
    const mineOnly = await fixture.fetchTasks(orgId, { completed: 'true' });
    expect(mineOnly.items).toEqual([]);
  });
});

describe('comments and followers', () => {
  test('a comment shows at once, is pending until confirmed, then carries the server copy', async () => {
    const fixture = server();
    const { transport, release } = gated(fixture);
    const { pipeline, queryClient, byTitle } = await setup(transport);
    const a = byTitle('A');
    await loadActivity(pipeline, queryClient, a.id);
    queryClient.setQueryData(taskDetailKey(a.id), await fixture.fetchTask(a.id));
    const id = uuidv7();
    pipeline.enqueue(orgId, [listOps.createComment(a.id, { id, body: 'Hello' })], ctx);
    expect(feedItems(feedOf(queryClient, a.id)).map(itemId).at(-1)).toBe(id);
    expect(pipeline.hasPending(id)).toBe(true);
    expect(pipeline.view(orgId)?.tasks[a.id]?.counts.comments).toBe(3);
    // A refetch while it is queued keeps it.
    await loadActivity(pipeline, queryClient, a.id);
    expect(findComment(feedOf(queryClient, a.id), id)?.body).toBe('Hello');
    release();
    await pipeline.idle();
    expect(pipeline.hasPending(id)).toBe(false);
    expect(fixture.comments.get(id)?.body).toBe('Hello');
    expect(queryClient.getQueryData<TaskDetail>(taskDetailKey(a.id))?.counts.comments).toBe(3);
    expect(pipeline.view(orgId)?.tasks[a.id]?.counts.comments).toBe(3);
  });

  test('edit, delete and its undo (restore) of a comment', async () => {
    const fixture = server();
    const { pipeline, queryClient, byTitle } = await setup(fixture);
    const a = byTitle('A');
    await loadActivity(pipeline, queryClient, a.id);
    await loadEveryone(pipeline, queryClient);
    const [first] = [...fixture.comments.values()];
    if (!first) throw new Error('no comment');
    pipeline.enqueue(orgId, [listOps.patchComment(first.id, a.id, { body: 'Edited' })], ctx);
    expect(findComment(feedOf(queryClient, a.id), first.id)?.body).toBe('Edited');
    await pipeline.idle();
    expect(findComment(feedOf(queryClient, a.id), first.id)?.editedAt).not.toBeNull();
    const del = listOps.deleteComment(first.id, a.id);
    const undo = inverseOf(del, pipeline.view(orgId) as ListState, { userId, now: 0 });
    pipeline.enqueue(orgId, [del], ctx);
    expect(findComment(feedOf(queryClient, a.id), first.id)).toBeUndefined();
    expect(rows(queryClient).find((t) => t.id === a.id)?.counts.comments).toBe(1);
    pipeline.enqueue(orgId, undo, ctx);
    expect(findComment(feedOf(queryClient, a.id), first.id)?.body).toBe('Edited');
    expect(feedItems(feedOf(queryClient, a.id)).map(itemId).slice(1)).toEqual([
      ...fixture.comments.keys(),
    ]);
    await pipeline.idle();
    expect(fixture.comments.get(first.id)?.deleted).toBe(false);
    expect(fixture.state(orgId).tasks[a.id]?.counts.comments).toBe(2);
  });

  test("someone else's comment is refused; the feed is refetched", async () => {
    const fixture = server();
    const { pipeline, queryClient, byTitle } = await setup(fixture);
    const a = byTitle('A');
    await loadActivity(pipeline, queryClient, a.id);
    const [first] = [...fixture.comments.values()];
    if (!first) throw new Error('no comment');
    fixture.comments.set(first.id, { ...first, authorId: bob });
    const dropped: string[] = [];
    pipeline.onDropped(({ error }) => dropped.push(error.code));
    pipeline.enqueue(orgId, [listOps.deleteComment(first.id, a.id)], ctx);
    await pipeline.idle();
    expect(dropped).toEqual(['forbidden']);
    expect(queryClient.getQueryState(activityKey(a.id))?.isInvalidated).toBe(true);
  });

  test('follow and unfollow land in the task detail', async () => {
    const fixture = server();
    const { pipeline, queryClient, byTitle } = await setup(fixture);
    const a = byTitle('A');
    queryClient.setQueryData(taskDetailKey(a.id), await fixture.fetchTask(a.id));
    pipeline.enqueue(orgId, [listOps.setFollowing(a.id, true)], ctx);
    await pipeline.idle();
    expect(queryClient.getQueryData<TaskDetail>(taskDetailKey(a.id))?.followers).toEqual([userId]);
    pipeline.enqueue(orgId, [listOps.setFollowing(a.id, false)], ctx);
    await pipeline.idle();
    expect(queryClient.getQueryData<TaskDetail>(taskDetailKey(a.id))?.followers).toEqual([]);
    expect((await fixture.fetchTask(a.id)).followers).toEqual([]);
  });

  test('fixture: the feed pages back in time and filters comments', async () => {
    const fixture = server();
    const { byTitle } = await setup(fixture);
    const a = byTitle('A');
    const newest = await fixture.fetchActivity(a.id, { limit: 2 });
    expect(newest.items.map((i) => i.kind)).toEqual(['comment', 'comment']);
    expect(newest.nextCursor).toBe('2');
    const older = await fixture.fetchActivity(a.id, { limit: 2, cursor: '2' });
    expect(older.items.map((i) => i.kind)).toEqual(['activity']);
    expect(older.nextCursor).toBeNull();
    const comments = await fixture.fetchActivity(a.id, { filter: 'comments' });
    expect(comments.items).toHaveLength(2);
    await expect(fixture.fetchActivity(uuidv7(), {})).rejects.toMatchObject({ status: 404 });
  });

  test('withPendingActivity appends queued comments to the newest page only', async () => {
    const fixture = server();
    const { transport } = gated(fixture);
    const { pipeline, byTitle } = await setup(transport);
    const a = byTitle('A');
    const id = uuidv7();
    pipeline.enqueue(orgId, [listOps.createComment(a.id, { id, body: 'Queued' })], ctx);
    const page = await fixture.fetchActivity(a.id, {});
    expect(pipeline.withPendingActivity(a.id, page, true).items.map(itemId).at(-1)).toBe(id);
    expect(pipeline.withPendingActivity(a.id, page, false)).toEqual(page);
  });
});

describe('other tabs', () => {
  test("a follower tab mirrors another tab's ops into its P6 caches", async () => {
    const fixture = server();
    const queryClient = new QueryClient();
    const follower = new ListPipeline({
      transport: fixture,
      queryClient,
      clientId: 'client-2',
      isLeader: () => false,
    });
    queryClient.setQueryData(myListKey(orgId), await follower.fetch(orgId));
    await loadEveryone(follower, queryClient);
    const b = Object.values(follower.view(orgId)?.tasks ?? {}).find((t) => t.title === 'B') as Task;
    const op = {
      ...listOps.patchTask(b.id, { title: 'B!' }),
      opId: uuidv7(),
      editTime: 1,
      clientId: 'x',
    };
    follower.receive({ type: 'enqueued', records: [{ op, orgId, ctx }] });
    expect(rows(queryClient).find((t) => t.id === b.id)?.title).toBe('B!');
    follower.reset();
  });
});
