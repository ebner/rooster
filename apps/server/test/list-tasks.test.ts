import type {
  BulkResult,
  MyList,
  Task,
  TaskCompleteResult,
  TaskMoveResult,
  TaskPage,
  TaskPatchResult,
  TrashPage,
} from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import {
  createTask,
  groupNamed,
  inboxOf,
  listCtx,
  myList,
  sharedOrg,
  titlesIn,
} from './list-helpers.ts';

const DAY = 86_400_000;

describe('task create', () => {
  it('defaults: top of the Inbox; end of a named group; the intent when given', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const inbox = await inboxOf(a);
    const prio = await groupNamed(a, 'Prio');
    await createTask(a, { title: 'i1' });
    await createTask(a, { title: 'i2' });
    expect(await titlesIn(a, inbox.id)).toEqual(['i2', 'i1']);

    const p1 = await createTask(a, { title: 'p1', groupId: prio.id });
    const p2 = await createTask(a, { title: 'p2', groupId: prio.id });
    await createTask(a, { title: 'p0', groupId: prio.id, beforeId: p1.id });
    await createTask(a, { title: 'p1.5', groupId: prio.id, afterId: p1.id, beforeId: p2.id });
    // Explicit nulls mean "end", even in the Inbox (06 §1).
    await createTask(a, { title: 'i3', afterId: null, beforeId: null });
    expect(await titlesIn(a, prio.id)).toEqual(['p0', 'p1', 'p1.5', 'p2']);
    expect(await titlesIn(a, inbox.id)).toEqual(['i2', 'i1', 'i3']);
  });

  it('assigns org-scoped sequence numbers and makes the creator the assignee', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const t1 = await createTask(a, { title: 'one' }, org.id);
    const t2 = await createTask(b, { title: 'two' }, org.id);
    const own = await createTask(a, { title: 'personal' });
    expect([t1.seq, t2.seq, own.seq]).toEqual([1, 2, 1]);
    expect(t2).toMatchObject({ assigneeId: b.userId, createdBy: b.userId, completedAt: null });
    expect(t2.placement?.groupId).toBe((await inboxOf(b, org.id)).id);
  });

  it('a repeated create with the same id returns the task; other content is 409', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const id = '019a0000-0000-7000-8000-0000000000aa';
    const first = await createTask(a, { id, title: 'Same', dueDate: '2026-10-10' });
    const again = await createTask(a, { id, title: 'Same', dueDate: '2026-10-10' });
    expect(again).toEqual(first);
    const res = await a.call('POST', '/api/v1/orgs/personal/tasks', { id, title: 'Different' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'id_conflict' });
    expect((await myList(a)).tasks).toHaveLength(1);
  });

  it('validates the due unit', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const bad = await a.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'x',
      dueDate: '2026-10-10',
      dueTime: '10:00',
      dueTz: 'Mars/Olympus',
    });
    expect(bad.status).toBe(422);
    const t = await createTask(a, { title: 'x', dueDate: '2026-10-10', dueTz: 'Europe/Stockholm' });
    // A timezone without a time is dropped.
    expect(t).toMatchObject({ dueDate: '2026-10-10', dueTime: null, dueTz: null });
  });

  it('parse: true reads a trailing >Group and a date phrase in my timezone', async () => {
    const now = Date.UTC(2026, 9, 5, 23, 30); // Mon 5 Oct 23:30 UTC = Tue 6 Oct in Stockholm
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    await a.ok('PATCH', '/api/v1/me', { timezone: 'Europe/Stockholm' });
    const prio = await groupNamed(a, 'Prio');
    const t = await createTask(a, { title: 'Call Bob >pri tomorrow', parse: true });
    expect(t).toMatchObject({ title: 'Call Bob', dueDate: '2026-10-07', dueTime: null });
    expect(t.placement?.groupId).toBe(prio.id);
    const plain = await createTask(a, { title: 'Read `next week` notes >Nope', parse: true });
    expect(plain.title).toBe('Read next week notes >Nope');
    expect(plain.dueDate).toBeNull();
  });
});

describe('task patch (per-field LWW)', () => {
  it('applies newer fields, skips older ones and reports them in ignoredFields', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'Original' });
    const now = Date.now();
    const edit = (body: object, at: number) =>
      a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, body, 200, {
        'X-Rooster-Edit-Time': String(at),
      });
    expect((await edit({ title: 'Second' }, now)).ignoredFields).toEqual([]);
    const stale = await edit({ title: 'Stale', description: 'Fresh' }, now - 5000);
    expect(stale.ignoredFields).toEqual(['title']);
    expect(stale.task).toMatchObject({ title: 'Second', description: 'Fresh' });

    // The due unit is one field: a newer date edit replaces date, time and zone together.
    await edit({ dueDate: '2026-10-10', dueTime: '09:00', dueTz: 'Europe/Stockholm' }, now);
    const older = await edit({ dueDate: '2026-12-24' }, now - 1);
    expect(older.ignoredFields).toEqual(['dueDate']);
    const cleared = await edit({ dueDate: '2026-11-01' }, now + 1);
    expect(cleared.task).toMatchObject({ dueDate: '2026-11-01', dueTime: null, dueTz: null });
    const none = await edit({ dueDate: null }, now + 2);
    expect(none.task.dueDate).toBeNull();
  });

  it('clamps edit times from the future to now + 5 s', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'x' });
    await a.ok('PATCH', `/api/v1/tasks/${t.id}`, { title: 'far future' }, 200, {
      'X-Rooster-Edit-Time': String(Date.now() + 365 * DAY),
    });
    // Ten seconds later a normal edit wins: the future one was clamped.
    const later = await a.ok<TaskPatchResult>(
      'PATCH',
      `/api/v1/tasks/${t.id}`,
      { title: 'now' },
      200,
      {
        'X-Rooster-Edit-Time': String(Date.now() + 10_000),
      },
    );
    expect(later.task.title).toBe('now');
  });

  it('a patch to a deleted task is 410 conflict_deleted', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'x' });
    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    const res = await a.call('PATCH', `/api/v1/tasks/${t.id}`, { title: 'y' });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'conflict_deleted' });
  });

  it('any org member may edit a task; outsiders get 404', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const c = ctx.user('c@example.com');
    const org = await sharedOrg(a, [b]);
    const t = await createTask(a, { title: 'shared' }, org.id);
    const patched = await b.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, {
      title: 'by b',
    });
    // b sees the task but it is not in b's list.
    expect(patched.task).toMatchObject({ title: 'by b', placement: null });
    expect((await c.call('PATCH', `/api/v1/tasks/${t.id}`, { title: 'c' })).status).toBe(404);
  });
});

describe('complete, delete, restore', () => {
  it('AC-2.5 completing keeps the placement; undo restores the same position', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const [t1, t2, t3] = [
      await createTask(a, { title: 't1', groupId: prio.id }),
      await createTask(a, { title: 't2', groupId: prio.id }),
      await createTask(a, { title: 't3', groupId: prio.id }),
    ];
    const done = await a.ok<TaskCompleteResult>('POST', `/api/v1/tasks/${t2.id}/complete`, {
      completed: true,
    });
    expect(done.task.completedAt).toEqual(expect.any(Number));
    expect(done.task.placement).toEqual(t2.placement);
    // Others keep moving around meanwhile.
    await a.ok('POST', `/api/v1/tasks/${t3.id}/move`, { groupId: prio.id, beforeId: t1.id });
    const undone = await a.ok<TaskCompleteResult>('POST', `/api/v1/tasks/${t2.id}/complete`, {
      completed: false,
    });
    expect(undone.task).toMatchObject({ completedAt: null, placement: t2.placement });
    expect(await titlesIn(a, prio.id)).toEqual(['t3', 't1', 't2']);
  });

  it('an older completion loses against a newer reopen', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'x' });
    const now = Date.now();
    await a.ok('POST', `/api/v1/tasks/${t.id}/complete`, { completed: false }, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    const stale = await a.ok<TaskCompleteResult>(
      'POST',
      `/api/v1/tasks/${t.id}/complete`,
      { completed: true },
      200,
      { 'X-Rooster-Edit-Time': String(now - 1000) },
    );
    expect(stale.task.completedAt).toBeNull();
  });

  it('delete keeps the placement; restore returns the task to its exact slot', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const tasks = [];
    for (const title of ['a', 'b', 'c'])
      tasks.push(await createTask(a, { title, groupId: prio.id }));
    await a.ok('DELETE', `/api/v1/tasks/${tasks[1]?.id}`, undefined, 204);
    await a.ok('DELETE', `/api/v1/tasks/${tasks[1]?.id}`, undefined, 204); // idempotent
    expect(await titlesIn(a, prio.id)).toEqual(['a', 'c']);
    const restored = await a.ok<Task>('POST', `/api/v1/tasks/${tasks[1]?.id}/restore`);
    expect(restored.placement).toEqual(tasks[1]?.placement);
    expect(await titlesIn(a, prio.id)).toEqual(['a', 'b', 'c']);
  });

  it('restoring a task whose group was deleted puts it at the top of the Inbox', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    await createTask(a, { title: 'inbox task' });
    const t = await createTask(a, { title: 'orphan', groupId: prio.id });
    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    await a.ok('DELETE', `/api/v1/groups/${prio.id}`, {}, 204);
    const restored = await a.ok<Task>('POST', `/api/v1/tasks/${t.id}/restore`);
    const inbox = await inboxOf(a);
    expect(restored.placement?.groupId).toBe(inbox.id);
    expect(await titlesIn(a, inbox.id)).toEqual(['orphan', 'inbox task']);
  });

  it('permanent delete only works from Trash', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'x' });
    const live = await a.call('DELETE', `/api/v1/tasks/${t.id}/permanent`);
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: 'not_in_trash' });
    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    await a.ok('DELETE', `/api/v1/tasks/${t.id}/permanent`, undefined, 204);
    expect((await a.call('POST', `/api/v1/tasks/${t.id}/restore`)).status).toBe(404);
  });
});

describe('move', () => {
  it('AC-2.2 reorders within and across groups; the order persists', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const upcoming = await groupNamed(a, 'Upcoming');
    const [x, y, z] = [
      await createTask(a, { title: 'x', groupId: prio.id }),
      await createTask(a, { title: 'y', groupId: prio.id }),
      await createTask(a, { title: 'z', groupId: prio.id }),
    ];
    // Ctrl+↑ on z: between x and y.
    await a.ok('POST', `/api/v1/tasks/${z.id}/move`, {
      groupId: prio.id,
      afterId: x.id,
      beforeId: y.id,
    });
    // Ctrl+Shift+↓ on x: start of the next group.
    const moved = await a.ok<TaskMoveResult>('POST', `/api/v1/tasks/${x.id}/move`, {
      groupId: upcoming.id,
      afterId: null,
    });
    expect(moved.placement.groupId).toBe(upcoming.id);
    expect(await titlesIn(a, prio.id)).toEqual(['z', 'y']);
    expect(await titlesIn(a, upcoming.id)).toEqual(['x']);
  });

  it('404 when the task is not in my list; an older move loses', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const t = await createTask(a, { title: 'x' }, org.id);
    const bPrio = await groupNamed(b, 'Prio', org.id);
    expect((await b.call('POST', `/api/v1/tasks/${t.id}/move`, { groupId: bPrio.id })).status).toBe(
      404,
    );

    const aPrio = await groupNamed(a, 'Prio', org.id);
    const now = Date.now();
    await a.ok('POST', `/api/v1/tasks/${t.id}/move`, { groupId: aPrio.id }, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    const stale = await a.ok<TaskMoveResult>(
      'POST',
      `/api/v1/tasks/${t.id}/move`,
      { groupId: (await inboxOf(a, org.id)).id },
      200,
      { 'X-Rooster-Edit-Time': String(now - 1) },
    );
    expect(stale.placement.groupId).toBe(aPrio.id);
  });
});

describe('bulk', () => {
  it('move keeps the given order and places the tasks consecutively', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const today = await groupNamed(a, 'Today');
    const t = [];
    for (const title of ['a', 'b', 'c', 'd'])
      t.push(await createTask(a, { title, groupId: prio.id }));
    const anchor = await createTask(a, { title: 'anchor', groupId: today.id });
    const tail = await createTask(a, { title: 'tail', groupId: today.id });
    const result = await a.ok<BulkResult>('POST', '/api/v1/tasks/bulk', {
      op: 'move',
      ids: [t[3]?.id, t[0]?.id, t[2]?.id, '019a0000-0000-7000-8000-00000000dead'],
      args: { groupId: today.id, afterId: anchor.id, beforeId: tail.id },
    });
    expect(result.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(result.results[3]?.code).toBe('not_found');
    expect(await titlesIn(a, today.id)).toEqual(['anchor', 'd', 'a', 'c', 'tail']);
    expect(await titlesIn(a, prio.id)).toEqual(['b']);
  });

  it('complete, setDue, delete and restore apply per task', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t1 = await createTask(a, { title: 'one' });
    const t2 = await createTask(a, { title: 'two' });
    const ids = [t1.id, t2.id];
    await a.ok('POST', '/api/v1/tasks/bulk', {
      op: 'setDue',
      ids,
      args: { dueDate: '2026-10-09', dueTime: '08:30', dueTz: 'UTC' },
    });
    await a.ok('POST', '/api/v1/tasks/bulk', { op: 'complete', ids });
    let list = await myList(a);
    expect(list.tasks.every((t) => t.completedAt !== null && t.dueTime === '08:30')).toBe(true);
    await a.ok('POST', '/api/v1/tasks/bulk', { op: 'uncomplete', ids: [t1.id] });
    await a.ok('POST', '/api/v1/tasks/bulk', { op: 'delete', ids });
    expect((await myList(a)).tasks).toEqual([]);
    const restore = await a.ok<BulkResult>('POST', '/api/v1/tasks/bulk', { op: 'restore', ids });
    expect(restore.results.every((r) => r.ok)).toBe(true);
    list = await myList(a);
    expect(list.tasks.find((t) => t.id === t1.id)?.completedAt).toBeNull();
  });
});

describe('reads', () => {
  it('my-list includes open tasks and completions within the window (default 14 days)', async () => {
    let now = Date.UTC(2026, 9, 1, 12);
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    const old = await createTask(a, { title: 'old' });
    const recent = await createTask(a, { title: 'recent' });
    await createTask(a, { title: 'open' });
    await a.ok('POST', `/api/v1/tasks/${old.id}/complete`, { completed: true }, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    now += 10 * DAY;
    await a.ok('POST', `/api/v1/tasks/${recent.id}/complete`, { completed: true }, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    now += 5 * DAY;
    const list = await myList(a);
    expect(list.tasks.map((t) => t.title).sort()).toEqual(['open', 'recent']);
    expect(list.serverTime).toBe(now);
    expect(list.expandedTaskIds).toEqual([]);
    expect(list.tasks[0]?.counts).toEqual({
      subtasks: 0,
      subtasksDone: 0,
      comments: 0,
      attachments: 0,
    });
    const all = await myList(a, 'personal', '?completedSince=0');
    expect(all.tasks).toHaveLength(3);
  });

  it('Trash is paged by cursor, newest deletion first, with deletedAt and deletedBy', async () => {
    let now = Date.UTC(2026, 9, 1);
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTask(a, { title: `t${i}` });
      now += 1000;
      await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
      ids.push(t.id);
    }
    const seen: TrashPage['items'] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page: TrashPage = await a.ok<TrashPage>('GET', `/api/v1/orgs/personal/trash${query}`);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.map((t) => t.id)).toEqual([...ids].reverse());
    expect(seen[0]).toMatchObject({ deletedBy: a.userId, deletedAt: expect.any(Number) });
    const bad = await a.call('GET', '/api/v1/orgs/personal/trash?cursor=nonsense');
    expect(bad.status).toBe(422);
  });

  it('views today/week/overdue/nodate follow my timezone', async () => {
    // 2026-10-05 22:30 UTC is already Tuesday 6 Oct in Stockholm (UTC+2).
    const now = Date.UTC(2026, 9, 5, 22, 30);
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    await a.ok('PATCH', '/api/v1/me', { timezone: 'Europe/Stockholm' });
    const mk = (title: string, due: Record<string, string> = {}) =>
      createTask(a, { title, ...due });
    await mk('yesterday', { dueDate: '2026-10-05' });
    await mk('today', { dueDate: '2026-10-06' });
    await mk('today passed', {
      dueDate: '2026-10-06',
      dueTime: '00:15',
      dueTz: 'Europe/Stockholm',
    });
    await mk('today later', { dueDate: '2026-10-06', dueTime: '18:00', dueTz: 'Europe/Stockholm' });
    await mk('in six days', { dueDate: '2026-10-12' });
    await mk('in seven days', { dueDate: '2026-10-13' });
    await mk('none');
    const done = await mk('done today', { dueDate: '2026-10-06' });
    await a.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });

    const view = async (q: string) =>
      (await a.ok<TaskPage>('GET', `/api/v1/orgs/personal/tasks?${q}`)).items.map((t) => t.title);
    // The shared selector (ADR 0012): Overdue first by due date, then each section in My
    // tasks order (new tasks go to the top of the Inbox, so the newest comes first).
    expect(await view('view=today')).toEqual(['yesterday', 'today passed', 'today later', 'today']);
    expect(await view('view=overdue')).toEqual(['yesterday', 'today passed']);
    expect(await view('view=week')).toEqual([
      'today later',
      'today passed',
      'today',
      'in six days',
    ]);
    expect(await view('view=nodate')).toEqual(['none']);
    expect(await view('view=today&completed=true')).toEqual(['done today']);
    expect(await view('view=week&dueFrom=2026-10-07&dueTo=2026-10-31')).toEqual(['in six days']);
  });

  it('view=my lists my list in order and pages through it; groupId filters', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    await createTask(a, { title: 'p1', groupId: prio.id });
    await createTask(a, { title: 'p2', groupId: prio.id });
    await createTask(a, { title: 'inbox' });
    const first = await a.ok<TaskPage>('GET', '/api/v1/orgs/personal/tasks?limit=2');
    expect(first.items.map((t) => t.title)).toEqual(['inbox', 'p1']);
    const second = await a.ok<TaskPage>(
      'GET',
      `/api/v1/orgs/personal/tasks?limit=2&cursor=${first.nextCursor}`,
    );
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map((t) => t.title)).toEqual(['p2']);
    const inPrio = await a.ok<TaskPage>('GET', `/api/v1/orgs/personal/tasks?groupId=${prio.id}`);
    expect(inPrio.items.map((t) => t.title)).toEqual(['p1', 'p2']);
  });

  it('my-list of an org I do not belong to is 404', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, []);
    expect((await b.call('GET', `/api/v1/orgs/${org.id}/my-list`)).status).toBe(404);
    const list = await a.ok<MyList>('GET', `/api/v1/orgs/${org.slug}/my-list`);
    expect(list.groups.map((g) => g.name)).toEqual(['Inbox', 'Today', 'Prio', 'Upcoming']);
  });
});
