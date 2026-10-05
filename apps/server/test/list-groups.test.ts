import type { Group, GroupCreateResult, Task, TrashPage } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import {
  createTask,
  groupNamed,
  groupsOf,
  inboxOf,
  listCtx,
  myList,
  sharedOrg,
  titlesIn,
} from './list-helpers.ts';

const names = (groups: Group[]) => groups.map((g) => g.name);

describe('groups', () => {
  it('lists the Inbox first, then the default groups in order', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const groups = await groupsOf(a);
    expect(names(groups)).toEqual(['Inbox', 'Today', 'Prio', 'Upcoming']);
    expect(groups[0]?.kind).toBe('inbox');
  });

  it('creates groups at the end by default and at the intent otherwise', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const today = await groupNamed(a, 'Today');
    await a.ok('POST', '/api/v1/orgs/personal/groups', { name: 'Last' }, 201);
    await a.ok('POST', '/api/v1/orgs/personal/groups', { name: 'First', beforeId: today.id }, 201);
    await a.ok(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'Middle', afterId: today.id, beforeId: prio.id },
      201,
    );
    expect(names(await groupsOf(a))).toEqual([
      'Inbox',
      'First',
      'Today',
      'Middle',
      'Prio',
      'Upcoming',
      'Last',
    ]);
  });

  it('a stale intent falls back to the end and reports the actual position', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const foreign = await groupNamed(b, 'Prio');
    const created = await a.ok<GroupCreateResult>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'X', afterId: foreign.id },
      201,
    );
    const groups = await groupsOf(a);
    expect(groups.at(-1)).toEqual(created.group);
  });

  it('repeats a create with the same client id; other content is 409 id_conflict', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const id = '019a0000-0000-7000-8000-000000000001';
    const first = await a.ok<GroupCreateResult>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { id, name: 'G' },
      201,
    );
    const again = await a.ok<GroupCreateResult>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { id, name: 'G' },
      201,
    );
    expect(again.group).toEqual(first.group);
    const res = await a.call('POST', '/api/v1/orgs/personal/groups', { id, name: 'Other' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'id_conflict' });
  });

  it('renames and collapses with per-field LWW; the Inbox cannot be renamed', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const now = Date.now();
    await a.ok('PATCH', `/api/v1/groups/${prio.id}`, { name: 'Newer' }, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    // An older edit loses for `name` but `collapsed` has no clock yet, so it applies.
    const after = await a.ok<Group>(
      'PATCH',
      `/api/v1/groups/${prio.id}`,
      { name: 'Older', collapsed: true },
      200,
      { 'X-Rooster-Edit-Time': String(now - 1000) },
    );
    expect(after).toMatchObject({ name: 'Newer', collapsed: true });

    const inbox = await inboxOf(a);
    const res = await a.call('PATCH', `/api/v1/groups/${inbox.id}`, { name: 'Nope' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'inbox_immutable' });
    await a.ok('PATCH', `/api/v1/groups/${inbox.id}`, { collapsed: true });
  });

  it("AC-2.4 reorders groups; the order persists; the Inbox can't move", async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const [today, prio, upcoming] = await Promise.all(
      ['Today', 'Prio', 'Upcoming'].map((n) => groupNamed(a, n)),
    );
    if (!today || !prio || !upcoming) throw new Error('groups');
    const moved = await a.ok<{ position: string }>('POST', `/api/v1/groups/${upcoming.id}/move`, {
      afterId: null,
      beforeId: today.id,
    });
    expect(moved.position < today.position).toBe(true);
    await a.ok('POST', `/api/v1/groups/${today.id}/move`, { afterId: prio.id, beforeId: null });
    expect(names(await groupsOf(a))).toEqual(['Inbox', 'Upcoming', 'Prio', 'Today']);

    const inbox = await inboxOf(a);
    const res = await a.call('POST', `/api/v1/groups/${inbox.id}/move`, { afterId: today.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'inbox_immutable' });
  });

  it('groups are personal: another member of the org gets 404', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const aGroup = await groupNamed(a, 'Prio', org.id);
    for (const [method, path, body] of [
      ['PATCH', `/api/v1/groups/${aGroup.id}`, { name: 'x' }],
      ['POST', `/api/v1/groups/${aGroup.id}/move`, {}],
      ['DELETE', `/api/v1/groups/${aGroup.id}`, {}],
      ['POST', `/api/v1/groups/${aGroup.id}/restore`, undefined],
    ] as const) {
      expect((await b.call(method, path, body)).status).toBe(404);
    }
    // Nor can b place a task in a's group.
    const res = await b.call('POST', `/api/v1/orgs/${org.id}/tasks`, {
      title: 'x',
      groupId: aGroup.id,
    });
    expect(res.status).toBe(404);
  });
});

describe('AC-2.8 split a group after a task (Tab+N)', () => {
  it('moves the tasks below into a new group after the source, keeping their order', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const tasks: Task[] = [];
    for (const title of ['t1', 't2', 't3', 't4']) {
      tasks.push(await createTask(a, { title, groupId: prio.id }));
    }
    // A completed task below the cursor moves too (it is part of the group's text).
    await a.ok('POST', `/api/v1/tasks/${tasks[3]?.id}/complete`, { completed: true });
    const result = await a.ok<GroupCreateResult>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'Later', splitAfterTaskId: tasks[1]?.id, afterId: null },
      201,
    );
    expect(result.moved.map((m) => m.taskId)).toEqual([tasks[2]?.id, tasks[3]?.id]);
    expect(names(await groupsOf(a))).toEqual(['Inbox', 'Today', 'Prio', 'Later', 'Upcoming']);
    expect(await titlesIn(a, prio.id)).toEqual(['t1', 't2']);
    expect(await titlesIn(a, result.group.id)).toEqual(['t3', 't4']);

    // Undo = delete the new group moving its tasks back to the end of the source.
    await a.ok('DELETE', `/api/v1/groups/${result.group.id}`, { moveTasksTo: prio.id }, 204);
    expect(await titlesIn(a, prio.id)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('splitting in the Inbox puts the new group first among the normal groups', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const first = await createTask(a, { title: 'b' });
    await createTask(a, { title: 'a' });
    // Inbox arrivals go to the top: order is a, b. Split after a.
    const inbox = await inboxOf(a);
    expect(await titlesIn(a, inbox.id)).toEqual(['a', 'b']);
    const second = (await myList(a)).tasks.find((t) => t.title === 'a');
    const result = await a.ok<GroupCreateResult>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'Triaged', splitAfterTaskId: second?.id },
      201,
    );
    expect(result.moved).toEqual([
      { taskId: first.id, groupId: result.group.id, position: expect.any(String) },
    ]);
    expect(names(await groupsOf(a))).toEqual(['Inbox', 'Triaged', 'Today', 'Prio', 'Upcoming']);
  });

  it('rejects a split after a task that is not in my list', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const task = await createTask(a, { title: 'mine' }, org.id);
    const res = await b.call('POST', `/api/v1/orgs/${org.id}/groups`, {
      name: 'x',
      splitAfterTaskId: task.id,
    });
    expect(res.status).toBe(404);
  });
});

describe('AC-2.9 delete a group', () => {
  it('"Move to Prio" appends its tasks (deleted ones too) to Prio in their order', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const upcoming = await groupNamed(a, 'Upcoming');
    await createTask(a, { title: 'p1', groupId: prio.id });
    const u = [];
    for (const title of ['u1', 'u2', 'u3']) {
      u.push(await createTask(a, { title, groupId: upcoming.id }));
    }
    await a.ok('DELETE', `/api/v1/tasks/${u[1]?.id}`, undefined, 204);
    await a.ok('DELETE', `/api/v1/groups/${upcoming.id}`, { moveTasksTo: prio.id }, 204);
    expect(names(await groupsOf(a))).toEqual(['Inbox', 'Today', 'Prio']);
    expect(await titlesIn(a, prio.id)).toEqual(['p1', 'u1', 'u3']);
    // The deleted task's placement moved with them: restoring it lands between u1 and u3.
    await a.ok('POST', `/api/v1/tasks/${u[1]?.id}/restore`);
    expect(await titlesIn(a, prio.id)).toEqual(['p1', 'u1', 'u2', 'u3']);
  });

  it('"Delete tasks too" trashes them; restore brings back the group and the tasks', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const upcoming = await groupNamed(a, 'Upcoming');
    const earlier = await createTask(a, { title: 'deleted before', groupId: upcoming.id });
    await a.ok('DELETE', `/api/v1/tasks/${earlier.id}`, undefined, 204);
    await createTask(a, { title: 'x1', groupId: upcoming.id });
    await createTask(a, { title: 'x2', groupId: upcoming.id });
    await a.ok('DELETE', `/api/v1/groups/${upcoming.id}`, { deleteTasks: true }, 204);
    expect(names(await groupsOf(a))).toEqual(['Inbox', 'Today', 'Prio']);
    const trash = await a.ok<TrashPage>('GET', '/api/v1/orgs/personal/trash');
    expect(trash.items.map((t) => t.title).sort()).toEqual(['deleted before', 'x1', 'x2']);

    const restored = await a.ok<Group>('POST', `/api/v1/groups/${upcoming.id}/restore`);
    expect(restored).toEqual(upcoming);
    expect(names(await groupsOf(a))).toEqual(['Inbox', 'Today', 'Prio', 'Upcoming']);
    // Only the tasks deleted with the group come back.
    expect(await titlesIn(a, upcoming.id)).toEqual(['x1', 'x2']);
  });

  it('an empty group is deleted without options; completed leftovers go to the Inbox', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const today = await groupNamed(a, 'Today');
    const prio = await groupNamed(a, 'Prio');
    await a.ok('DELETE', `/api/v1/groups/${today.id}`, undefined, 204);
    const done = await createTask(a, { title: 'done', groupId: prio.id });
    await a.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    const open = await createTask(a, { title: 'open', groupId: prio.id });

    const blocked = await a.call('DELETE', `/api/v1/groups/${prio.id}`, {});
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'group_not_empty' });

    await a.ok('POST', `/api/v1/tasks/${open.id}/complete`, { completed: true });
    await a.ok('DELETE', `/api/v1/groups/${prio.id}`, {}, 204);
    const inbox = await inboxOf(a);
    expect(await titlesIn(a, inbox.id)).toEqual(['done', 'open']);
  });

  it('keeps the last normal group (409 last_group) and the Inbox (409 inbox_immutable)', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    for (const name of ['Today', 'Prio']) {
      await a.ok('DELETE', `/api/v1/groups/${(await groupNamed(a, name)).id}`, {}, 204);
    }
    const upcoming = await groupNamed(a, 'Upcoming');
    const last = await a.call('DELETE', `/api/v1/groups/${upcoming.id}`, {});
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({ code: 'last_group' });
    const inbox = await inboxOf(a);
    const res = await a.call('DELETE', `/api/v1/groups/${inbox.id}`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'inbox_immutable' });
  });

  it('rejects both options at once, and moving into itself or a foreign group', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const prio = await groupNamed(a, 'Prio');
    const today = await groupNamed(a, 'Today');
    const both = await a.call('DELETE', `/api/v1/groups/${prio.id}`, {
      moveTasksTo: today.id,
      deleteTasks: true,
    });
    expect(both.status).toBe(422);
    const self = await a.call('DELETE', `/api/v1/groups/${prio.id}`, { moveTasksTo: prio.id });
    expect(self.status).toBe(422);
    const foreign = await a.call('DELETE', `/api/v1/groups/${prio.id}`, {
      moveTasksTo: (await groupNamed(b, 'Prio')).id,
    });
    expect(foreign.status).toBe(404);
  });

  it('restoring a live group is a no-op', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    expect(await a.ok<Group>('POST', `/api/v1/groups/${prio.id}/restore`)).toEqual(prio);
  });
});
