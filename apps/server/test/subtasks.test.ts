import type {
  MyList,
  SubtaskReorderResult,
  Task,
  TaskCompleteResult,
  TaskDetail,
  TaskPatch,
  TaskPatchResult,
} from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { placement, task, taskExpansion } from '../src/db/schema/index.ts';
import { AppError } from '../src/lib/errors.ts';
import { immediate } from '../src/services/context.ts';
import {
  type Caller,
  createTask,
  inboxOf,
  type ListCtx,
  listCtx,
  meta,
  myList,
  sharedOrg,
  titlesIn,
} from './list-helpers.ts';

const sub = (c: Caller, parentId: string, title: string, extra: object = {}, org = 'personal') =>
  createTask(c, { title, parentId, ...extra }, org);

const detail = (c: Caller, id: string) => c.ok<TaskDetail>('GET', `/api/v1/tasks/${id}`);

const byId = (list: MyList, id: string) => list.tasks.find((t) => t.id === id);

/** Titles of a parent's subtasks in sibling order, from the detail endpoint. */
async function subtaskTitles(c: Caller, parentId: string): Promise<string[]> {
  return (await detail(c, parentId)).subtasks.map((t) => t.title);
}

/** Builds a chain root → … of `levels` subtasks below the root; returns all IDs, root first. */
async function chain(c: Caller, levels: number, org = 'personal'): Promise<string[]> {
  const root = await createTask(c, { title: 'L0' }, org);
  const ids = [root.id];
  for (let i = 1; i <= levels; i++) {
    ids.push((await sub(c, ids[i - 1] as string, `L${i}`, {}, org)).id);
  }
  return ids;
}

/** Reassigns a task directly (assignment is exposed in P6) and reconciles placements. */
function assign(ctx: ListCtx, taskId: string, userId: string | null): void {
  immediate(ctx.db, (tx) => {
    tx.update(task).set({ assigneeId: userId }).where(eq(task.id, taskId)).run();
    ctx.app.services.placements.reconcilePlacements(tx, [taskId]);
  });
}

describe('subtask create', () => {
  it('goes to the end of its siblings (or the intent), unplaced, with the parent’s assignee', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const parent = await createTask(a, { title: 'Parent' });
    const s1 = await sub(a, parent.id, 's1');
    const s2 = await sub(a, parent.id, 's2', { groupId: (await inboxOf(a)).id });
    await sub(a, parent.id, 's0', { beforeId: s1.id });
    await sub(a, parent.id, 's1.5', { afterId: s1.id, beforeId: s2.id });
    expect(s1).toMatchObject({
      parentId: parent.id,
      assigneeId: a.userId,
      placement: null,
      subtaskPosition: expect.any(String),
    });
    expect(s1.seq).toBe((parent.seq ?? 0) + 1);
    expect(await subtaskTitles(a, parent.id)).toEqual(['s0', 's1', 's1.5', 's2']);
    // Subtasks are not rows of their own in the list.
    expect(await titlesIn(a, (await inboxOf(a)).id)).toEqual(['Parent']);
  });

  it('a subtask created by another member belongs to the parent’s assignee', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const parent = await createTask(a, { title: 'A’s task' }, org.id);
    const s = await sub(b, parent.id, 'by b', {}, org.id);
    expect(s).toMatchObject({ assigneeId: a.userId, createdBy: b.userId, placement: null });
    expect((await myList(b, org.id)).tasks).toEqual([]);
    expect(byId(await myList(a, org.id), s.id)?.placement).toBeNull();
  });

  it('rejects unknown, foreign-org and deleted parents', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const shared = await createTask(a, { title: 'shared' }, org.id);
    const mine = await createTask(a, { title: 'mine' });
    const post = (c: Caller, parentId: string, orgRef = 'personal') =>
      c.call('POST', `/api/v1/orgs/${orgRef}/tasks`, { title: 'x', parentId });

    const foreign = await post(a, shared.id);
    expect(foreign.status).toBe(422);
    expect(await foreign.json()).toMatchObject({ code: 'invalid_parent' });
    // Not visible to b: same answer as a missing task, so existence does not leak.
    const invisible = await post(b, mine.id, org.id);
    expect(invisible.status).toBe(422);
    expect(await invisible.json()).toMatchObject({ code: 'invalid_parent' });
    await a.ok('DELETE', `/api/v1/tasks/${mine.id}`, undefined, 204);
    expect((await post(a, mine.id)).status).toBe(410);
  });
});

describe('AC-3.5 cycles and depth', () => {
  it('AC-3.5 setting parent_id to a descendant (or itself) is 422', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const [root, child, grandchild] = await chain(a, 2);
    for (const target of [child, grandchild, root]) {
      const res = await a.call('PATCH', `/api/v1/tasks/${root}`, { parentId: target });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'subtask_cycle' });
    }
    expect((await detail(a, root as string)).parentId).toBeNull();
  });

  it('AC-3.5 a depth over 5 is 422, for creates and for moved subtrees', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const ids = await chain(a, 5);
    const deepest = ids[5] as string;
    const tooDeep = await a.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'L6',
      parentId: deepest,
    });
    expect(tooDeep.status).toBe(422);
    expect(await tooDeep.json()).toMatchObject({ code: 'subtask_depth' });

    // A two-level subtree fits under L3 (→ depth 5) but not under L4 (→ depth 6).
    const [other, otherChild] = await chain(a, 1);
    const ok = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${other}`, {
      parentId: ids[3],
    });
    expect(ok.task.parentId).toBe(ids[3]);
    const res = await a.call('PATCH', `/api/v1/tasks/${other}`, { parentId: ids[4] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'subtask_depth' });
    expect((await detail(a, otherChild as string)).parentChain.map((p) => p.title)).toEqual([
      'L0',
      'L1',
      'L2',
      'L3',
      'L0',
    ]);
  });
});

describe('re-parenting (PATCH parentId)', () => {
  it('makes a top-level task a subtask and back; null goes to the top of the Inbox', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const inbox = await inboxOf(a);
    const parent = await createTask(a, { title: 'Parent' });
    const existing = await sub(a, parent.id, 'existing');
    const t = await createTask(a, { title: 'Loose' });
    await createTask(a, { title: 'Newest' });

    const moved = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, {
      parentId: parent.id,
    });
    expect(moved.task).toMatchObject({ parentId: parent.id, placement: null });
    expect(await subtaskTitles(a, parent.id)).toEqual(['existing', 'Loose']);
    expect(await titlesIn(a, inbox.id)).toEqual(['Newest', 'Parent']);

    const back = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${existing.id}`, {
      parentId: null,
    });
    expect(back.task).toMatchObject({
      parentId: null,
      subtaskPosition: null,
      placement: { groupId: inbox.id },
    });
    expect(await titlesIn(a, inbox.id)).toEqual(['existing', 'Newest', 'Parent']);
  });

  it('the parent clock is last-write-wins', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const p1 = await createTask(a, { title: 'p1' });
    const p2 = await createTask(a, { title: 'p2' });
    const t = await sub(a, p1.id, 't');
    const now = Date.now();
    const edit = (body: TaskPatch, at: number) =>
      a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, body, 200, {
        'X-Rooster-Edit-Time': String(at),
      });
    await edit({ parentId: p2.id }, now);
    const stale = await edit({ parentId: null, title: 'renamed' }, now - 1000);
    expect(stale.ignoredFields).toEqual(['parentId']);
    expect(stale.task).toMatchObject({ parentId: p2.id, title: 'renamed', placement: null });
    // A stale reorder keeps the position too.
    const kept = await a.ok<SubtaskReorderResult>(
      'POST',
      `/api/v1/tasks/${t.id}/reorder`,
      { afterId: null },
      200,
      { 'X-Rooster-Edit-Time': String(now - 1000) },
    );
    expect(kept.subtaskPosition).toBe(stale.task.subtaskPosition);
  });
});

describe('subtask reorder', () => {
  it('moves among siblings; a top-level task is 409', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const parent = await createTask(a, { title: 'P' });
    const [x, y, z] = [
      await sub(a, parent.id, 'x'),
      await sub(a, parent.id, 'y'),
      await sub(a, parent.id, 'z'),
    ];
    await a.ok('POST', `/api/v1/tasks/${z.id}/reorder`, { beforeId: x.id });
    await a.ok('POST', `/api/v1/tasks/${x.id}/reorder`, { afterId: y.id });
    expect(await subtaskTitles(a, parent.id)).toEqual(['z', 'y', 'x']);
    await a.ok('POST', `/api/v1/tasks/${z.id}/reorder`, {});
    expect(await subtaskTitles(a, parent.id)).toEqual(['y', 'x', 'z']);
    const res = await a.call('POST', `/api/v1/tasks/${parent.id}/reorder`, { afterId: null });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_subtask' });
  });
});

describe('counts', () => {
  it('counts live direct subtasks; completing the parent leaves them open', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const parent = await createTask(a, { title: 'P' });
    const kids = [];
    for (const title of ['a', 'b', 'c', 'd', 'e']) kids.push(await sub(a, parent.id, title));
    await sub(a, kids[0]?.id as string, 'grandchild');
    await a.ok('POST', `/api/v1/tasks/${kids[1]?.id}/complete`, { completed: true });
    await a.ok('POST', `/api/v1/tasks/${kids[2]?.id}/complete`, { completed: true });
    await a.ok('DELETE', `/api/v1/tasks/${kids[4]?.id}`, undefined, 204);
    const counts = byId(await myList(a), parent.id)?.counts;
    expect(counts).toMatchObject({ subtasks: 4, subtasksDone: 2 });
    expect(byId(await myList(a), kids[0]?.id as string)?.counts.subtasks).toBe(1);

    const done = await a.ok<TaskCompleteResult>('POST', `/api/v1/tasks/${parent.id}/complete`, {
      completed: true,
    });
    expect(done.task.counts).toMatchObject({ subtasks: 4, subtasksDone: 2 });
    const d = await detail(a, parent.id);
    expect(d.subtasks.map((s) => s.completedAt === null)).toEqual([true, false, false, true]);
  });
});

describe('cascading delete and restore', () => {
  it('deletes all descendants with one deleted_at; restore brings back exactly those', async () => {
    let now = Date.now();
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    const [root, child, grandchild] = await chain(a, 2);
    const early = await sub(a, root as string, 'deleted earlier');
    await a.ok('DELETE', `/api/v1/tasks/${early.id}`, undefined, 204);
    now += 1000;
    await a.ok('DELETE', `/api/v1/tasks/${root}`, undefined, 204);
    const rows = ctx.db.orm.select().from(task).all();
    const deletedAt = (id: string) => rows.find((r) => r.id === id)?.deletedAt;
    expect(deletedAt(child as string)).toBe(now);
    expect(deletedAt(grandchild as string)).toBe(now);
    expect(deletedAt(early.id)).toBe(now - 1000);
    expect((await myList(a)).tasks).toEqual([]);

    now += 1000;
    await a.ok('POST', `/api/v1/tasks/${root}/restore`);
    const list = await myList(a);
    expect(list.tasks.map((t) => t.title).sort()).toEqual(['L0', 'L1', 'L2']);
    expect(byId(list, root as string)?.counts.subtasks).toBe(1);
  });

  it('restoring a subtask whose parent is in Trash brings it back top-level', async () => {
    let now = Date.now();
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    const parent = await createTask(a, { title: 'P' });
    const s = await sub(a, parent.id, 's');
    await a.ok('DELETE', `/api/v1/tasks/${s.id}`, undefined, 204);
    now += 1000;
    await a.ok('DELETE', `/api/v1/tasks/${parent.id}`, undefined, 204);
    const restored = await a.ok<Task>('POST', `/api/v1/tasks/${s.id}/restore`);
    expect(restored).toMatchObject({
      parentId: null,
      subtaskPosition: null,
      placement: { groupId: (await inboxOf(a)).id },
    });
  });
});

describe('my-list payload', () => {
  it('carries every live subtask of placed tasks, at any depth, with placement null', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const [root, l1, l2, l3] = await chain(a, 3);
    const doneSub = await sub(a, root as string, 'done');
    await a.ok('POST', `/api/v1/tasks/${doneSub.id}/complete`, { completed: true });
    const gone = await sub(a, root as string, 'gone');
    await a.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    const list = await myList(a);
    expect(list.tasks[0]?.id).toBe(root);
    expect(list.tasks.map((t) => t.id).sort()).toEqual([root, l1, l2, l3, doneSub.id].sort());
    for (const id of [l1, l2, l3]) expect(byId(list, id as string)?.placement).toBeNull();
    expect(byId(list, root as string)?.placement).not.toBeNull();
  });

  it('orphan subtasks: own row for the assignee, with the parent chain as placement-null tasks', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const [root, mid, leaf] = await chain(a, 2, org.id);
    // P6 exposes assignment; until then it is set directly and reconciled.
    assign(ctx, leaf as string, b.userId);

    const bList = await myList(b, org.id);
    expect(byId(bList, leaf as string)?.placement?.groupId).toBe((await inboxOf(b, org.id)).id);
    expect(byId(bList, mid as string)?.placement).toBeNull();
    expect(byId(bList, root as string)?.placement).toBeNull();
    expect(bList.tasks).toHaveLength(3);

    // a still sees it nested under the parent, without a placement.
    const aList = await myList(a, org.id);
    expect(byId(aList, leaf as string)).toMatchObject({ assigneeId: b.userId, placement: null });

    // Handing the parent to b turns the leaf back into a plain subtask (05 §4.1).
    assign(ctx, mid as string, b.userId);
    const placements = ctx.db.orm.select().from(placement).all();
    expect(placements.find((p) => p.taskId === leaf)).toBeUndefined();
    expect(placements.find((p) => p.taskId === mid)?.userId).toBe(b.userId);
    const again = await myList(b, org.id);
    expect(byId(again, leaf as string)?.placement).toBeNull();
    expect(byId(again, mid as string)?.placement).not.toBeNull();

    // Handing the parent back to a makes the leaf b's orphan row again.
    assign(ctx, mid as string, a.userId);
    expect(byId(await myList(b, org.id), leaf as string)?.placement).not.toBeNull();
  });
});

describe('expansion', () => {
  it('PUT/DELETE persist my expansion idempotently; my-list reports it', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const t = await createTask(a, { title: 'P' }, org.id);
    await a.ok('PUT', `/api/v1/tasks/${t.id}/expanded`, undefined, 204);
    await a.ok('PUT', `/api/v1/tasks/${t.id}/expanded`, undefined, 204);
    expect((await myList(a, org.id)).expandedTaskIds).toEqual([t.id]);
    // Per user: b's expansion is b's own.
    expect((await myList(b, org.id)).expandedTaskIds).toEqual([]);
    await b.ok('PUT', `/api/v1/tasks/${t.id}/expanded`, undefined, 204);

    await a.ok('DELETE', `/api/v1/tasks/${t.id}/expanded`, undefined, 204);
    await a.ok('DELETE', `/api/v1/tasks/${t.id}/expanded`, undefined, 204);
    expect((await myList(a, org.id)).expandedTaskIds).toEqual([]);

    await a.ok('PUT', `/api/v1/tasks/${t.id}/expanded`, undefined, 204);
    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    expect((await myList(a, org.id)).expandedTaskIds).toEqual([]);
    expect((await a.call('PUT', `/api/v1/tasks/${t.id}/expanded`)).status).toBe(410);

    // Removing b from the org drops b's expansions there (05 §4.2).
    await a.ok('DELETE', `/api/v1/orgs/${org.id}/members/${b.userId}`, undefined, 204);
    const rows = ctx.db.orm.select().from(taskExpansion).all();
    expect(rows.filter((r) => r.userId === b.userId)).toEqual([]);
  });
});

describe('task detail', () => {
  it('returns description, ordered direct subtasks and the parent chain root first', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const outsider = ctx.user('c@example.com');
    const [root, mid, leaf] = await chain(a, 2);
    await a.ok('PATCH', `/api/v1/tasks/${mid}`, { description: '# Notes' });
    await sub(a, mid as string, 'second');
    const d = await detail(a, mid as string);
    expect(d).toMatchObject({ id: mid, description: '# Notes', placement: null });
    expect(d.subtasks.map((s) => s.id)).toEqual([leaf, expect.any(String)]);
    expect(d.subtasks[0]?.description).toBeUndefined();
    expect(d.parentChain).toEqual([{ id: root, title: 'L0' }]);
    expect((await detail(a, leaf as string)).parentChain.map((p) => p.id)).toEqual([root, mid]);
    expect((await detail(a, root as string)).parentChain).toEqual([]);
    expect((await outsider.call('GET', `/api/v1/tasks/${root}`)).status).toBe(404);

    await a.ok('DELETE', `/api/v1/tasks/${root}`, undefined, 204);
    expect((await detail(a, root as string)).deletedAt).toEqual(expect.any(Number));
  });
});

describe('start date (FR-DATE-2)', () => {
  it('is part of the due unit and must be ≤ the due date', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, {
      title: 'Range',
      dueDate: '2026-10-12',
      startDate: '2026-10-10',
    });
    expect(t).toMatchObject({ startDate: '2026-10-10', dueDate: '2026-10-12' });
    const bad = [{ startDate: '2026-10-13', dueDate: '2026-10-12' }, { startDate: '2026-10-10' }];
    for (const body of bad) {
      expect(
        (await a.call('POST', '/api/v1/orgs/personal/tasks', { title: 'x', ...body })).status,
      ).toBe(422);
      expect((await a.call('PATCH', `/api/v1/tasks/${t.id}`, body)).status).toBe(422);
    }
    // The unit is replaced as a whole: a new due date without a start clears the start.
    const moved = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, {
      dueDate: '2026-10-20',
    });
    expect(moved.task).toMatchObject({ dueDate: '2026-10-20', startDate: null });
  });

  it('the service validates the merged unit itself: 422, never a CHECK failure', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'x', dueDate: '2026-10-12' });
    const tasks = ctx.app.services.tasks;
    // Bypasses the route schema, as bulk setDue, parse: true and the CLI paths do.
    const invalid = { dueDate: '2026-10-01', startDate: '2026-10-05' } as TaskPatch;
    expect(() => tasks.patch(a.actor, t.id, invalid, meta())).toThrow(AppError);
    try {
      tasks.patch(a.actor, t.id, { startDate: '2026-10-05' } as TaskPatch, meta());
    } catch (err) {
      expect(err).toMatchObject({ status: 422, code: 'validation_failed' });
    }
    const bulk = tasks.bulk(
      a.actor,
      { op: 'setDue', ids: [t.id], args: { dueDate: '2026-10-01', startDate: '2026-10-05' } },
      meta(),
    );
    expect(bulk.results).toEqual([{ id: t.id, ok: false, code: 'validation_failed' }]);
    // A stale due edit is skipped as a whole, start date included.
    const now = Date.now();
    await a.ok('PATCH', `/api/v1/tasks/${t.id}`, { dueDate: '2026-10-12' }, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    const stale = await a.ok<TaskPatchResult>(
      'PATCH',
      `/api/v1/tasks/${t.id}`,
      { dueDate: '2026-11-02', startDate: '2026-11-01' },
      200,
      { 'X-Rooster-Edit-Time': String(now - 1000) },
    );
    expect(stale.ignoredFields).toEqual(['dueDate', 'startDate']);
    expect(stale.task).toMatchObject({ dueDate: '2026-10-12', startDate: null });
  });
});

describe('duplicate (FR-TASK-13)', () => {
  it('deep-copies fields, tags and subtasks (reopened) directly below the original', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const inbox = await inboxOf(a);
    await createTask(a, { title: 'below' });
    const original = await createTask(a, {
      title: 'Original',
      description: 'Body',
      dueDate: '2026-10-12',
      startDate: '2026-10-10',
      tagNames: ['b-tag', 'a-tag'],
    });
    expect(await titlesIn(a, inbox.id)).toEqual(['Original', 'below']);
    const s1 = await sub(a, original.id, 's1');
    await sub(a, original.id, 's2');
    await sub(a, s1.id, 's1.1');
    await a.ok('POST', `/api/v1/tasks/${s1.id}/complete`, { completed: true });
    const gone = await sub(a, original.id, 'gone');
    await a.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    await a.ok('POST', `/api/v1/tasks/${original.id}/complete`, { completed: true });

    const id = '019a0000-0000-7000-8000-0000000000d1';
    const copy = await a.ok<Task>('POST', `/api/v1/tasks/${original.id}/duplicate`, { id }, 201);
    expect(copy).toMatchObject({
      id,
      title: 'Original',
      description: 'Body',
      dueDate: '2026-10-12',
      startDate: '2026-10-10',
      tagIds: original.tagIds,
      completedAt: null,
      parentId: null,
      assigneeId: a.userId,
      counts: { subtasks: 2, subtasksDone: 0 },
      placement: { groupId: inbox.id },
    });
    expect(copy.seq).toBeGreaterThan(gone.seq ?? 0);
    expect(await titlesIn(a, inbox.id)).toEqual(['Original', 'Original', 'below']);
    const list = await myList(a);
    const [first, second] = list.tasks.filter((t) => t.title === 'Original');
    expect([first?.id, second?.id]).toEqual([original.id, copy.id]);

    const d = await detail(a, copy.id);
    expect(d.subtasks.map((s) => [s.title, s.completedAt])).toEqual([
      ['s1', null],
      ['s2', null],
    ]);
    const nested = await detail(a, d.subtasks[0]?.id as string);
    expect(nested.subtasks.map((s) => s.title)).toEqual(['s1.1']);
    expect(nested.subtasks[0]?.id).not.toBe(s1.id);

    // Same id again: the same copy.
    const again = await a.ok<Task>('POST', `/api/v1/tasks/${original.id}/duplicate`, { id }, 201);
    expect(again.id).toBe(id);
    expect((await myList(a)).tasks.filter((t) => t.title === 'Original')).toHaveLength(2);
  });

  it('a subtask copy goes right after the original among its siblings; subtasks optional', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const parent = await createTask(a, { title: 'P' });
    const x = await sub(a, parent.id, 'x');
    await sub(a, parent.id, 'y');
    await sub(a, x.id, 'x.1');
    const copy = await a.ok<Task>(
      'POST',
      `/api/v1/tasks/${x.id}/duplicate`,
      { includeSubtasks: false },
      201,
    );
    expect(copy).toMatchObject({ parentId: parent.id, placement: null, counts: { subtasks: 0 } });
    expect(await subtaskTitles(a, parent.id)).toEqual(['x', 'x', 'y']);
    // No body: subtasks included by default.
    const withKids = await a.ok<Task>('POST', `/api/v1/tasks/${x.id}/duplicate`, undefined, 201);
    expect(withKids.counts.subtasks).toBe(1);
  });

  it('copying someone else’s task puts my copy at the top of my Inbox', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const t = await createTask(a, { title: 'A’s' }, org.id);
    await createTask(b, { title: 'B’s' }, org.id);
    const copy = await b.ok<Task>('POST', `/api/v1/tasks/${t.id}/duplicate`, {}, 201);
    expect(copy.assigneeId).toBe(b.userId);
    expect(await titlesIn(b, (await inboxOf(b, org.id)).id, org.id)).toEqual(['A’s', 'B’s']);
  });
});
