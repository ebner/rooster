// Phase 10 (WP 10.1, ADR 0049 §1): recurring tasks through the API. The rule itself (parsing,
// normalising, the next date) is tested in packages/core; here: storage, the next instance
// in the completion's transaction, skip, the one-open-instance rule and SSE-free invariants.

import type {
  ActivityPage,
  Task,
  TaskCompleteResult,
  TaskDetail,
  TaskPatchResult,
  TaskSkipResult,
} from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { ALL, bearer, pat } from './grant-helpers.ts';
import {
  type Caller,
  createTask,
  groupNamed,
  type ListCtx,
  listCtx,
  myList,
  sharedOrg,
} from './list-helpers.ts';

const STOCKHOLM = 'Europe/Stockholm';

/** A clock the test moves by hand; every read ticks 1 ms so LWW stamps stay ordered. */
function manualClock(start: number) {
  let now = start;
  return {
    clock: () => now++,
    set: (at: number) => {
      now = at;
    },
  };
}

/** 2026-10-05 is a Monday. */
const MON_OCT_5 = Date.UTC(2026, 9, 5, 8, 0);

async function setup(start = MON_OCT_5) {
  const time = manualClock(start);
  const ctx = listCtx({ clock: time.clock });
  const a = ctx.user('ann@example.com', 'Ann');
  await a.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM });
  return { ctx, time, a };
}

const complete = (c: Caller, id: string, body: Record<string, unknown> = {}) =>
  c.ok<TaskCompleteResult>('POST', `/api/v1/tasks/${id}/complete`, { completed: true, ...body });

const detail = (c: Caller, id: string) => c.ok<TaskDetail>('GET', `/api/v1/tasks/${id}`);

/** Titles (and due dates) of the live tasks in a group, in list order. */
async function rows(c: Caller, groupId: string, org = 'personal') {
  const list = await myList(c, org);
  return list.tasks
    .filter((t) => t.placement?.groupId === groupId)
    .sort((x, y) => {
      const px = x.placement?.position ?? '';
      const py = y.placement?.position ?? '';
      return px < py ? -1 : px > py ? 1 : x.id < y.id ? -1 : 1;
    })
    .map((t) => `${t.title} ${t.dueDate ?? '-'}${t.completedAt === null ? '' : ' ✓'}`);
}

describe('AC-10.1 recurring tasks', () => {
  it('AC-10.1 "Water plants every mon" completed on Monday 2026-10-05 → next due 2026-10-12, directly below', async () => {
    const { a } = await setup();
    const prio = await groupNamed(a, 'Prio');
    await createTask(a, { title: 'Above', groupId: prio.id });
    const water = await createTask(a, {
      title: 'Water plants every mon',
      groupId: prio.id,
      parse: true,
    });
    await createTask(a, { title: 'Below', groupId: prio.id, afterId: water.id });
    expect(water).toMatchObject({
      title: 'Water plants',
      dueDate: '2026-10-05',
      recurrenceBasis: 'due',
      nextReminderAt: null,
    });
    expect(water.recurrence).toMatch(/^FREQ=WEEKLY;BYDAY=MO/);

    const { task, next } = await complete(a, water.id);
    expect(task.completedAt).not.toBeNull();
    expect(next).toMatchObject({
      title: 'Water plants',
      dueDate: '2026-10-12',
      recurrence: water.recurrence,
      recurrenceBasis: 'due',
      completedAt: null,
      placement: { groupId: prio.id },
    });
    expect(await rows(a, prio.id)).toEqual([
      'Above -',
      'Water plants 2026-10-05 ✓',
      'Water plants 2026-10-12',
      'Below -',
    ]);
  });

  it('AC-10.1 "every 3 days after done" completed on Oct 7 → Oct 10', async () => {
    const { a, time } = await setup();
    const t = await createTask(a, { title: 'Stretch every 3 days after done', parse: true });
    expect(t).toMatchObject({ title: 'Stretch', recurrenceBasis: 'completion' });
    time.set(Date.UTC(2026, 9, 7, 10, 0));
    const { next } = await complete(a, t.id);
    expect(next?.dueDate).toBe('2026-10-10');
  });

  it('the same with explicit fields: basis completion counts from the completion date', async () => {
    const { a, time } = await setup();
    const t = await createTask(a, {
      title: 'Stretch',
      dueDate: '2026-10-05',
      recurrence: 'FREQ=DAILY;INTERVAL=3',
      recurrenceBasis: 'completion',
    });
    time.set(Date.UTC(2026, 9, 7, 10, 0));
    expect((await complete(a, t.id)).next?.dueDate).toBe('2026-10-10');
  });
});

describe('recurrence: storage and edits (ADR 0049 §1.1, §1.8)', () => {
  it('stores the rule normalised against the due date, and needs a due date', async () => {
    const { a } = await setup();
    const t = await createTask(a, {
      title: 'Report',
      dueDate: '2026-10-07',
      recurrence: 'FREQ=WEEKLY',
    });
    expect(t.recurrence).toBe('FREQ=WEEKLY;BYDAY=WE');
    const res = await a.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'No date',
      recurrence: 'FREQ=DAILY',
    });
    expect(res.status).toBe(422);
  });

  it('keeps the rule when only the dates change, and clears it with the due date', async () => {
    const { a } = await setup();
    const t = await createTask(a, {
      title: 'Report',
      dueDate: '2026-10-07',
      recurrence: 'FREQ=WEEKLY',
    });
    const moved = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, {
      dueDate: '2026-10-08',
    });
    expect(moved.task).toMatchObject({ dueDate: '2026-10-08', recurrence: 'FREQ=WEEKLY;BYDAY=WE' });
    const cleared = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, {
      dueDate: null,
    });
    expect(cleared.task).toMatchObject({ dueDate: null, recurrence: null, recurrenceBasis: null });
    // Completing it now creates nothing.
    expect((await complete(a, t.id)).next).toBeUndefined();
  });

  it('a rule-only patch keeps the dates; recurrence: null stops the series', async () => {
    const { a } = await setup();
    const t = await createTask(a, { title: 'Pay rent', dueDate: '2026-10-31', dueTime: null });
    const ruled = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, {
      recurrence: 'FREQ=MONTHLY',
    });
    expect(ruled.task).toMatchObject({
      dueDate: '2026-10-31',
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=31',
      recurrenceBasis: 'due',
    });
    const stopped = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${t.id}`, {
      recurrence: null,
    });
    expect(stopped.task).toMatchObject({ dueDate: '2026-10-31', recurrence: null });
  });

  it('rejects an unsupported rule and a basis without a rule', async () => {
    const { a } = await setup();
    const t = await createTask(a, { title: 'X', dueDate: '2026-10-07' });
    expect(
      (await a.call('PATCH', `/api/v1/tasks/${t.id}`, { recurrence: 'FREQ=HOURLY' })).status,
    ).toBe(422);
    expect(
      (await a.call('PATCH', `/api/v1/tasks/${t.id}`, { recurrenceBasis: 'completion' })).status,
    ).toBe(422);
  });
});

describe('the next instance (ADR 0049 §1.4–1.6)', () => {
  it('copies title, description, tags, followers, the start date shift and the subtasks; not comments', async () => {
    const time = manualClock(MON_OCT_5);
    const ctx: ListCtx = listCtx({ clock: time.clock });
    const a = ctx.user('ann@example.com', 'Ann');
    const b = ctx.user('bo@example.com', 'Bo');
    const org = await sharedOrg(a, [b]);
    await a.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM });
    const t = await createTask(
      a,
      {
        title: 'Weekly review',
        description: 'Look back',
        dueDate: '2026-10-09',
        dueTime: '14:00',
        dueTz: STOCKHOLM,
        startDate: '2026-10-07',
        recurrence: 'FREQ=WEEKLY',
        tagNames: ['work'],
      },
      org.id,
    );
    const sub = await createTask(
      a,
      { title: 'Collect notes', parentId: t.id, dueDate: '2026-10-08' },
      org.id,
    );
    await createTask(a, { title: 'Write summary', parentId: t.id }, org.id);
    await complete(a, sub.id);
    await b.ok('PUT', `/api/v1/tasks/${t.id}/followers/me`);
    await a.ok('POST', `/api/v1/tasks/${t.id}/comments`, { body: 'Not copied' }, 201);

    const nextId = '0199c5a1-4e5f-7d60-b172-8d9e0a1b2c99';
    const { next } = await complete(a, t.id, { nextId });
    expect(next).toMatchObject({
      id: nextId,
      title: 'Weekly review',
      description: 'Look back',
      dueDate: '2026-10-16',
      dueTime: '14:00',
      dueTz: STOCKHOLM,
      startDate: '2026-10-14',
      assigneeId: a.userId,
      tagIds: t.tagIds,
      counts: { subtasks: 2, subtasksDone: 0, comments: 0 },
    });
    const d = await detail(a, nextId);
    expect(d.followers).toEqual(expect.arrayContaining([a.userId, b.userId]));
    expect(d.subtasks.map((s) => [s.title, s.dueDate, s.completedAt, s.recurrence])).toEqual([
      ['Collect notes', '2026-10-15', null, null],
      ['Write summary', null, null, null],
    ]);
    const feed = await a.ok<ActivityPage>('GET', `/api/v1/tasks/${nextId}/activity`);
    expect(feed.items.map((e) => (e.kind === 'activity' ? e.activity.type : e.kind))).toEqual([
      'created',
    ]);
  });

  it('a subtask instance continues as the next sibling', async () => {
    const { a } = await setup();
    const parent = await createTask(a, { title: 'Chores' });
    const first = await createTask(a, {
      title: 'Bins',
      parentId: parent.id,
      dueDate: '2026-10-05',
      recurrence: 'FREQ=WEEKLY',
    });
    await createTask(a, { title: 'Dishes', parentId: parent.id });
    const { next } = await complete(a, first.id);
    expect(next?.parentId).toBe(parent.id);
    const titles = (await detail(a, parent.id)).subtasks.map(
      (s) => `${s.title} ${s.dueDate ?? '-'}`,
    );
    expect(titles).toEqual(['Bins 2026-10-05', 'Bins 2026-10-12', 'Dishes -']);
  });

  it('keeps at most one open instance: reopen and complete again creates nothing new', async () => {
    const { a } = await setup();
    const t = await createTask(a, {
      title: 'Gym',
      dueDate: '2026-10-05',
      recurrence: 'FREQ=DAILY',
    });
    const first = await complete(a, t.id);
    expect(first.next?.dueDate).toBe('2026-10-06');
    await a.ok('POST', `/api/v1/tasks/${t.id}/complete`, { completed: false });
    const again = await complete(a, t.id);
    expect(again.next).toBeUndefined();
    const open = (await myList(a)).tasks.filter((x) => x.title === 'Gym' && x.completedAt === null);
    expect(open).toHaveLength(1);
  });

  it('a late completion skips missed occurrences (basis due), and COUNT ends the series', async () => {
    const { a, time } = await setup();
    const t = await createTask(a, {
      title: 'Standup',
      dueDate: '2026-10-05',
      recurrence: 'FREQ=DAILY;COUNT=2',
    });
    time.set(Date.UTC(2026, 9, 8, 10, 0));
    const { next } = await complete(a, t.id);
    expect(next).toMatchObject({ dueDate: '2026-10-08', recurrence: 'FREQ=DAILY;COUNT=1' });
    expect((await complete(a, next?.id ?? '')).next).toBeUndefined();
  });

  it('the completion date follows the edit time (an offline completion counts when it happened)', async () => {
    const { a, time } = await setup();
    const t = await createTask(a, {
      title: 'Water',
      dueDate: '2026-10-05',
      recurrence: 'FREQ=DAILY;INTERVAL=2',
      recurrenceBasis: 'completion',
    });
    time.set(Date.UTC(2026, 9, 9, 10, 0));
    const editTime = String(Date.UTC(2026, 9, 6, 10, 0));
    const res = await a.ok<TaskCompleteResult>(
      'POST',
      `/api/v1/tasks/${t.id}/complete`,
      { completed: true },
      200,
      { 'x-rooster-edit-time': editTime },
    );
    expect(res.next?.dueDate).toBe('2026-10-08');
  });

  it('a taken nextId is 409 id_conflict and completes nothing', async () => {
    const { a } = await setup();
    const other = await createTask(a, { title: 'Other' });
    const t = await createTask(a, {
      title: 'Gym',
      dueDate: '2026-10-05',
      recurrence: 'FREQ=DAILY',
    });
    const res = await a.call('POST', `/api/v1/tasks/${t.id}/complete`, {
      completed: true,
      nextId: other.id,
    });
    expect(res.status).toBe(409);
    expect((await detail(a, t.id)).completedAt).toBeNull();
  });

  it('bulk complete continues every series', async () => {
    const { a } = await setup();
    const t = await createTask(a, {
      title: 'Gym',
      dueDate: '2026-10-05',
      recurrence: 'FREQ=DAILY',
    });
    await a.ok('POST', '/api/v1/tasks/bulk', { op: 'complete', ids: [t.id] });
    const open = (await myList(a)).tasks.filter((x) => x.title === 'Gym' && x.completedAt === null);
    expect(open.map((x) => x.dueDate)).toEqual(['2026-10-06']);
  });
});

describe('skip: "delete this occurrence" (FR-REC-4, ADR 0049 §1.7)', () => {
  it('moves the occurrence to Trash and continues the series', async () => {
    const { a } = await setup();
    const prio = await groupNamed(a, 'Prio');
    const t = await createTask(a, {
      title: 'Team lunch',
      groupId: prio.id,
      dueDate: '2026-10-05',
      recurrence: 'FREQ=WEEKLY',
    });
    const { next } = await a.ok<TaskSkipResult>('POST', `/api/v1/tasks/${t.id}/skip`, {});
    expect(next).toMatchObject({ dueDate: '2026-10-12', placement: { groupId: prio.id } });
    expect((await detail(a, t.id)).deletedAt).not.toBeNull();
    expect(await rows(a, prio.id)).toEqual(['Team lunch 2026-10-12']);
  });

  it('a plain DELETE ends the series; a task without a rule is 422 not_recurring', async () => {
    const { a } = await setup();
    const t = await createTask(a, { title: 'Once', dueDate: '2026-10-05' });
    const res = await a.call('POST', `/api/v1/tasks/${t.id}/skip`, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('not_recurring');
    const r = await createTask(a, {
      title: 'Weekly',
      dueDate: '2026-10-05',
      recurrence: 'FREQ=WEEKLY',
    });
    await a.ok('DELETE', `/api/v1/tasks/${r.id}`, undefined, 204);
    const open = (await myList(a)).tasks.filter((x: Task) => x.title === 'Weekly');
    expect(open).toEqual([]);
  });
});

describe('review fixes', () => {
  it('a grant cannot complete a recurring task whose subtree it cannot fully write (403 outside_grant)', async () => {
    const time = manualClock(MON_OCT_5);
    const ctx = listCtx({ clock: time.clock });
    const a = ctx.user('ann@example.com', 'Ann');
    const b = ctx.user('bo@example.com', 'Bo');
    const org = await sharedOrg(a, [b]);
    const prio = await groupNamed(a, 'Prio', org.id);
    const upcoming = await groupNamed(a, 'Upcoming', org.id);
    const inbox = (await myList(a, org.id)).groups.find((g) => g.kind === 'inbox');
    const parent = await createTask(
      a,
      { title: 'Weekly', groupId: prio.id, dueDate: '2026-10-05', recurrence: 'FREQ=WEEKLY' },
      org.id,
    );
    const child = await createTask(
      a,
      { title: 'Bo’s part', parentId: parent.id, assigneeId: b.userId },
      org.id,
    );
    // Ann's own grandchild under Bo's subtask has its own place in Ann's list: Upcoming.
    const secret = await createTask(
      a,
      { title: 'Secret', description: 'Hidden', parentId: child.id, assigneeId: a.userId },
      org.id,
    );
    await a.ok('POST', `/api/v1/tasks/${secret.id}/move`, { groupId: upcoming.id });
    const token = await pat(a, ALL, {
      orgs: [
        {
          orgId: org.id,
          read: { groups: [prio.id, inbox?.id ?? ''] },
          write: { groups: [prio.id, inbox?.id ?? ''] },
        },
      ],
    });
    const api = bearer(ctx, token.token);
    expect((await api.call('GET', `/api/v1/tasks/${secret.id}`)).status).toBe(404);

    const problem = await api.problem(
      'POST',
      `/api/v1/tasks/${parent.id}/complete`,
      { completed: true },
      403,
    );
    expect(problem.code).toBe('outside_grant');
    expect(problem.detail).not.toContain('Secret');
    // Nothing happened: no completion, no copy.
    expect((await detail(a, parent.id)).completedAt).toBeNull();
    const copies = (await myList(a, org.id)).tasks.filter((t) => t.title === 'Secret');
    expect(copies).toHaveLength(1);
    // The browser session completes it, subtree and all.
    expect((await complete(a, parent.id)).next).toBeDefined();
  });

  it('a stale recurrence edit is ignored, not a 422, and the rest of the patch applies', async () => {
    const { a } = await setup();
    const t = await createTask(a, { title: 'Report', dueDate: '2026-10-07' });
    const later = String(MON_OCT_5 + 60_000);
    await a.ok('PATCH', `/api/v1/tasks/${t.id}`, { dueDate: null }, 200, {
      'x-rooster-edit-time': later,
    });
    const res = await a.ok<TaskPatchResult>(
      'PATCH',
      `/api/v1/tasks/${t.id}`,
      { title: 'Weekly report', recurrence: 'FREQ=WEEKLY' },
      200,
      { 'x-rooster-edit-time': String(MON_OCT_5 - 60_000) },
    );
    expect(res.task).toMatchObject({ title: 'Weekly report', dueDate: null, recurrence: null });
    expect(res.ignoredFields).toEqual(['recurrence']);
  });

  it('copied subtasks keep their followers, explicit unfollows included', async () => {
    const time = manualClock(MON_OCT_5);
    const ctx = listCtx({ clock: time.clock });
    const a = ctx.user('ann@example.com', 'Ann');
    const b = ctx.user('bo@example.com', 'Bo');
    const org = await sharedOrg(a, [b]);
    const t = await createTask(
      a,
      { title: 'Weekly', dueDate: '2026-10-05', recurrence: 'FREQ=WEEKLY' },
      org.id,
    );
    const sub = await createTask(a, { title: 'Part', parentId: t.id }, org.id);
    await b.ok('PUT', `/api/v1/tasks/${sub.id}/followers/me`);
    await a.ok('DELETE', `/api/v1/tasks/${sub.id}/followers/me`);
    const { next } = await complete(a, t.id);
    const [copy] = (await detail(a, next?.id ?? '')).subtasks;
    expect((await detail(a, copy?.id ?? '')).followers).toEqual([b.userId]);
    // Ann's unfollow stuck: a comment of hers does not make her follow it again either.
    await a.ok('POST', `/api/v1/tasks/${copy?.id}/comments`, { body: 'Hi' }, 201);
    expect((await detail(a, copy?.id ?? '')).followers).toEqual([b.userId]);
  });
});
