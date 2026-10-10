import { describe, expect, it } from 'vitest';
import { applyOpToTaskList, mergeTaskListResponse } from '../src/everyone.ts';
import { generateNKeysBetween } from '../src/ordering.ts';
import {
  type ApplyContext,
  applyOp,
  applyOps,
  applyOpToDetail,
  inverseOf,
  type ListOpSpec,
  type ListState,
  listOps,
  mergeDetailResponse,
  mergeResponse,
  normalizeMyList,
  opEntityIds,
  tasksInGroup,
  touchesRecurrence,
} from '../src/reducers.ts';
import type { Group, MyList, Task, TaskDetail } from '../src/schemas/list.ts';
import type { Reminder } from '../src/schemas/reminders.ts';

const ORG = 'org-1';
const ME = 'user-1';
const BOB = 'user-2';
const HOUR = 3_600_000;
const MIN = 60_000;
/** Wednesday 2026-10-07 10:00 UTC (12:00 in Stockholm). */
const NOW = Date.UTC(2026, 9, 7, 10);
const ctx: ApplyContext = { userId: ME, now: NOW, timezone: 'Europe/Stockholm' };

function group(id: string, position: string, kind: Group['kind'] = 'normal'): Group {
  return { id, orgId: ORG, kind, name: id, position, collapsed: false };
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    orgId: ORG,
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title: id.toUpperCase(),
    assigneeId: ME,
    createdBy: ME,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    recurrence: null,
    recurrenceBasis: null,
    nextReminderAt: null,
    completedAt: null,
    tagIds: [],
    hasDescription: false,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

const [k1, k2, k3] = generateNKeysBetween(null, null, 3) as [string, string, string];
const MONDAYS = 'FREQ=WEEKLY;BYDAY=MO';

/**
 * Today: w (every Monday, due Mon Oct 5, tagged), x, y. Inbox: i1. w has subtask ws (every
 * day, due Oct 7); p has a plain subtask.
 */
function fixture(): ListState {
  const list: MyList = {
    groups: [group('inbox', 'a0', 'inbox'), group('today', 'a0')],
    tasks: [
      task('i1', { placement: { groupId: 'inbox', position: k1 } }),
      task('w', {
        placement: { groupId: 'today', position: k1 },
        dueDate: '2026-10-05',
        recurrence: MONDAYS,
        recurrenceBasis: 'due',
        tagIds: ['t1'],
        hasDescription: true,
        counts: { subtasks: 1, subtasksDone: 0, comments: 3, attachments: 2 },
        nextReminderAt: NOW + HOUR,
      }),
      task('x', { placement: { groupId: 'today', position: k2 } }),
      task('y', { placement: { groupId: 'today', position: k3 } }),
      task('ws', {
        parentId: 'w',
        subtaskPosition: k1,
        dueDate: '2026-10-07',
        recurrence: 'FREQ=DAILY',
        recurrenceBasis: 'due',
      }),
    ],
    expandedTaskIds: [],
    serverTime: 0,
  };
  return normalizeMyList(ORG, list);
}

const order = (state: ListState, groupId: string) => tasksInGroup(state, groupId).map((t) => t.id);

describe('task.patch with recurrence fields (ADR 0049 §1.8)', () => {
  it('sets a rule normalised against the due date, basis due by default', () => {
    const s = applyOp(
      fixture(),
      listOps.patchTask('x', { dueDate: '2026-01-31', recurrence: 'FREQ=MONTHLY' }),
      ctx,
    );
    expect(s.tasks.x).toMatchObject({
      dueDate: '2026-01-31',
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=31',
      recurrenceBasis: 'due',
    });
    const after = applyOp(
      fixture(),
      listOps.patchTask('x', {
        dueDate: '2026-10-07',
        recurrence: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2',
        recurrenceBasis: 'completion',
      }),
      ctx,
    );
    expect(after.tasks.x).toMatchObject({
      recurrence: 'FREQ=WEEKLY;INTERVAL=2',
      recurrenceBasis: 'completion',
    });
  });

  it('keeps absent recurrence fields when the due unit is replaced', () => {
    const s = applyOp(
      fixture(),
      listOps.patchTask('w', { dueDate: '2026-10-12', dueTime: null }),
      ctx,
    );
    expect(s.tasks.w).toMatchObject({
      dueDate: '2026-10-12',
      recurrence: MONDAYS,
      recurrenceBasis: 'due',
    });
  });

  it('a cleared due date (or a due unit without one) clears the rule and the basis', () => {
    for (const patch of [{ dueDate: null }, { startDate: null }]) {
      const s = applyOp(fixture(), listOps.patchTask('w', patch), ctx);
      expect(s.tasks.w).toMatchObject({ dueDate: null, recurrence: null, recurrenceBasis: null });
    }
  });

  it('recurrence null stops the series and keeps the date', () => {
    const s = applyOp(fixture(), listOps.patchTask('w', { recurrence: null }), ctx);
    expect(s.tasks.w).toMatchObject({
      dueDate: '2026-10-05',
      recurrence: null,
      recurrenceBasis: null,
    });
  });

  it('a basis alone re-normalises the current rule', () => {
    const s = applyOp(fixture(), listOps.patchTask('w', { recurrenceBasis: 'completion' }), ctx);
    expect(s.tasks.w).toMatchObject({ recurrence: 'FREQ=WEEKLY', recurrenceBasis: 'completion' });
    const back = applyOp(s, listOps.patchTask('w', { recurrenceBasis: 'due' }), ctx);
    expect(back.tasks.w).toMatchObject({ recurrence: MONDAYS, recurrenceBasis: 'due' });
  });

  it('ignores a rule for a task without a due date, and no-op patches keep identity', () => {
    const state = fixture();
    expect(
      applyOp(state, listOps.patchTask('x', { recurrence: 'FREQ=DAILY' }), ctx).tasks.x,
    ).toMatchObject({ recurrence: null });
    expect(applyOp(state, listOps.patchTask('x', { recurrenceBasis: 'due' }), ctx).tasks.x).toEqual(
      {
        ...state.tasks.x,
        updatedAt: NOW,
      },
    );
    // A task from an older cache gains no fields it never had.
    const { recurrence: _r, recurrenceBasis: _b, ...old } = state.tasks.x as Task;
    const legacy = { ...state, tasks: { ...state.tasks, x: old } };
    const patched = applyOp(legacy, listOps.patchTask('x', { dueDate: '2026-10-09' }), ctx);
    expect(patched.tasks.x).not.toHaveProperty('recurrence');
  });

  it('touchesRecurrence', () => {
    expect(touchesRecurrence({ recurrence: null })).toBe(true);
    expect(touchesRecurrence({ recurrenceBasis: 'due' })).toBe(true);
    expect(touchesRecurrence({})).toBe(false);
  });

  it('inverse restores the rule with the due unit, or alone', () => {
    const state = fixture();
    const clear = listOps.patchTask('w', { dueDate: null });
    expect(inverseOf(clear, state, ctx)).toEqual([
      listOps.patchTask('w', {
        dueDate: '2026-10-05',
        dueTime: null,
        dueTz: null,
        startDate: null,
        recurrence: MONDAYS,
        recurrenceBasis: 'due',
      }),
    ]);
    const stop = listOps.patchTask('w', { recurrence: null });
    expect(inverseOf(stop, state, ctx)).toEqual([
      listOps.patchTask('w', { recurrence: MONDAYS, recurrenceBasis: 'due' }),
    ]);
    const set = listOps.patchTask('x', { dueDate: '2026-10-09', recurrence: 'FREQ=DAILY' });
    expect(inverseOf(set, state, ctx)).toEqual([
      listOps.patchTask('x', {
        dueDate: null,
        dueTime: null,
        dueTz: null,
        startDate: null,
        recurrence: null,
      }),
    ]);
    // Moving the date of a series keeps the rule, so the undo does not name it.
    const move = listOps.patchTask('w', { dueDate: '2026-10-12' });
    expect(inverseOf(move, state, ctx)).toEqual([
      listOps.patchTask('w', {
        dueDate: '2026-10-05',
        dueTime: null,
        dueTz: null,
        startDate: null,
      }),
    ]);
    // Round trip.
    for (const op of [clear, stop, set]) {
      const undone = applyOps(applyOp(state, op, ctx), inverseOf(op, state, ctx), ctx);
      const pick = (t: Task | undefined) => ({
        dueDate: t?.dueDate,
        recurrence: t?.recurrence,
        recurrenceBasis: t?.recurrenceBasis,
      });
      expect(pick(undone.tasks[op.entityId])).toEqual(pick(state.tasks[op.entityId]));
    }
  });

  it('bulk setDue may set a rule; its inverse restores rules per previous unit', () => {
    const state = fixture();
    const op = listOps.bulk(ORG, {
      op: 'setDue',
      ids: ['w', 'x', 'y'],
      args: { dueDate: '2026-10-09', recurrence: 'FREQ=WEEKLY' },
    });
    const after = applyOp(state, op, ctx);
    expect(after.tasks.x).toMatchObject({
      recurrence: 'FREQ=WEEKLY;BYDAY=FR',
      recurrenceBasis: 'due',
    });
    expect(after.tasks.w).toMatchObject({ recurrence: 'FREQ=WEEKLY;BYDAY=FR' });
    const undo = inverseOf(op, state, ctx);
    expect(undo).toEqual([
      listOps.bulk(ORG, {
        op: 'setDue',
        ids: ['w'],
        args: {
          dueDate: '2026-10-05',
          dueTime: null,
          dueTz: null,
          startDate: null,
          recurrence: MONDAYS,
          recurrenceBasis: 'due',
        },
      }),
      listOps.bulk(ORG, {
        op: 'setDue',
        ids: ['x', 'y'],
        args: { dueDate: null, dueTime: null, dueTz: null, startDate: null, recurrence: null },
      }),
    ]);
    const undone = applyOps(after, undo, ctx);
    expect(undone.tasks.w).toMatchObject({ dueDate: '2026-10-05', recurrence: MONDAYS });
    expect(undone.tasks.x).toMatchObject({ dueDate: null, recurrence: null });
    // A date-only bulk change keeps every rule.
    const dateOnly = listOps.bulk(ORG, {
      op: 'setDue',
      ids: ['w'],
      args: { dueDate: '2026-10-12' },
    });
    expect(applyOp(state, dateOnly, ctx).tasks.w).toMatchObject({ recurrence: MONDAYS });
    expect(inverseOf(dateOnly, state, ctx)[0]).toEqual(
      listOps.bulk(ORG, {
        op: 'setDue',
        ids: ['w'],
        args: { dueDate: '2026-10-05', dueTime: null, dueTz: null, startDate: null },
      }),
    );
  });
});

describe('task.create with a rule and reminders', () => {
  it('normalises the rule and sets the bell', () => {
    const s = applyOp(
      fixture(),
      listOps.createTask({
        id: 'n1',
        title: 'Standup',
        dueDate: '2026-10-08',
        dueTime: '09:00',
        dueTz: 'Europe/Stockholm',
        recurrence: 'FREQ=WEEKLY',
        reminders: [{ offsetMinutes: 15 }, { offsetMinutes: 60 }],
      }),
      ctx,
    );
    expect(s.tasks.n1).toMatchObject({
      recurrence: 'FREQ=WEEKLY;BYDAY=TH',
      recurrenceBasis: 'due',
      // 09:00 CEST = 07:00 UTC, an hour before.
      nextReminderAt: Date.UTC(2026, 9, 8, 6),
    });
  });

  it('leaves the fields out when not given', () => {
    const s = applyOp(fixture(), listOps.createTask({ id: 'n2', title: 'Plain' }), ctx);
    expect(s.tasks.n2).not.toHaveProperty('recurrence');
    expect(s.tasks.n2).not.toHaveProperty('nextReminderAt');
  });

  it('a relative reminder without a due date is dormant; an absolute one counts', () => {
    const at = NOW + 5 * HOUR;
    const s = applyOp(
      fixture(),
      listOps.createTask({ id: 'n3', title: 'x', reminders: [{ offsetMinutes: 15 }, { at }] }),
      ctx,
    );
    expect(s.tasks.n3?.nextReminderAt).toBe(at);
    const dormant = applyOp(
      fixture(),
      listOps.createTask({ id: 'n4', title: 'x', reminders: [{ offsetMinutes: 15 }] }),
      ctx,
    );
    expect(dormant.tasks.n4?.nextReminderAt).toBeNull();
  });
});

describe('task.complete with nextId (FR-REC-3, AC-10.1)', () => {
  const complete = listOps.completeTask('w', true, 'w2');

  it('creates the next instance directly after the completed task', () => {
    const s = applyOp(fixture(), complete, ctx);
    expect(s.tasks.w?.completedAt).toBe(NOW);
    expect(order(s, 'today')).toEqual(['w', 'w2', 'x', 'y']);
    expect(s.tasks.w2).toMatchObject({
      title: 'W',
      dueDate: '2026-10-12',
      recurrence: MONDAYS,
      recurrenceBasis: 'due',
      completedAt: null,
      tagIds: ['t1'],
      hasDescription: true,
      assigneeId: ME,
      seq: null,
      counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
      nextReminderAt: null,
      createdAt: NOW,
    });
  });

  it('is idempotent and only spawns from an open recurring task', () => {
    const once = applyOp(fixture(), complete, ctx);
    expect(applyOp(once, complete, ctx)).toBe(once);
    // Not recurring.
    const plain = applyOp(fixture(), listOps.completeTask('x', true, 'x2'), ctx);
    expect(plain.tasks.x2).toBeUndefined();
    // Reopening never removes the next one, and a nextId on reopen is dropped by the builder.
    expect(listOps.completeTask('w', false, 'zz').payload).toEqual({ completed: false });
    const reopened = applyOp(once, listOps.completeTask('w', false), ctx);
    expect(reopened.tasks.w2).toBeDefined();
  });

  it('a late completion skips missed occurrences (the completion day in the actor zone)', () => {
    // Monday Oct 19, 23:30 UTC is already Tuesday Oct 20 in Stockholm → next Monday Oct 26.
    const late = { ...ctx, now: Date.UTC(2026, 9, 19, 23, 30) };
    expect(applyOp(fixture(), complete, late).tasks.w2?.dueDate).toBe('2026-10-26');
    // Without a timezone the UTC day (Monday Oct 19) counts.
    const utc: ApplyContext = { userId: ME, now: late.now };
    expect(applyOp(fixture(), complete, utc).tasks.w2?.dueDate).toBe('2026-10-19');
    const bogus: ApplyContext = { ...utc, timezone: 'Nowhere/Land' };
    expect(applyOp(fixture(), complete, bogus).tasks.w2?.dueDate).toBe('2026-10-19');
  });

  it('a timed task completes on the day of its own due zone', () => {
    const base = fixture();
    const timed = {
      ...base,
      tasks: {
        ...base.tasks,
        w: { ...(base.tasks.w as Task), dueTime: '09:00', dueTz: 'America/New_York' },
      },
    };
    // Tue Oct 20, 02:00 UTC is still Monday Oct 19 in New York → that Monday is the next one.
    const at = { ...ctx, now: Date.UTC(2026, 9, 20, 2) };
    expect(applyOp(timed, complete, at).tasks.w2).toMatchObject({
      dueDate: '2026-10-19',
      dueTime: '09:00',
      dueTz: 'America/New_York',
    });
  });

  it('basis completion counts from the completion date; the start date shifts with the due date', () => {
    const base = fixture();
    const state = {
      ...base,
      tasks: {
        ...base.tasks,
        x: {
          ...(base.tasks.x as Task),
          dueDate: '2026-10-01',
          startDate: '2026-09-29',
          recurrence: 'FREQ=DAILY;INTERVAL=3;COUNT=4',
          recurrenceBasis: 'completion' as const,
        },
      },
    };
    const s = applyOp(state, listOps.completeTask('x', true, 'x2'), ctx);
    expect(s.tasks.x2).toMatchObject({
      dueDate: '2026-10-10',
      startDate: '2026-10-08',
      recurrence: 'FREQ=DAILY;INTERVAL=3;COUNT=3',
      recurrenceBasis: 'completion',
    });
  });

  it('the last instance of a COUNT series spawns nothing', () => {
    const base = fixture();
    const state = {
      ...base,
      tasks: { ...base.tasks, w: { ...(base.tasks.w as Task), recurrence: `${MONDAYS};COUNT=1` } },
    };
    const s = applyOp(state, complete, ctx);
    expect(s.tasks.w2).toBeUndefined();
    expect(inverseOf(complete, state, ctx)).toEqual([listOps.completeTask('w', false)]);
  });

  it('a subtask instance is the next sibling and counts on the parent', () => {
    const op = listOps.completeTask('ws', true, 'ws2');
    const s = applyOp(fixture(), op, ctx);
    expect(s.tasks.ws2).toMatchObject({ parentId: 'w', dueDate: '2026-10-08', placement: null });
    expect((s.tasks.ws2?.subtaskPosition as string) > k1).toBe(true);
    expect(s.tasks.w?.counts).toMatchObject({ subtasks: 2, subtasksDone: 1 });
  });

  it('undo reopens and deletes the next instance', () => {
    const state = fixture();
    const undo = inverseOf(complete, state, ctx);
    expect(undo).toEqual([listOps.completeTask('w', false), listOps.deleteTask('w2')]);
    const undone = applyOps(applyOp(state, complete, ctx), undo, ctx);
    expect(undone.tasks.w?.completedAt).toBeNull();
    expect(undone.tasks.w2).toBeUndefined();
    expect(order(undone, 'today')).toEqual(['w', 'x', 'y']);
  });

  it('opEntityIds names the next instance', () => {
    expect(opEntityIds(complete)).toEqual(['w', 'w2']);
    expect(opEntityIds(listOps.completeTask('w', true))).toEqual(['w']);
    expect(opEntityIds(listOps.skipTask('w', 'w2'))).toEqual(['w', 'w2']);
    expect(opEntityIds(listOps.skipTask('w'))).toEqual(['w']);
  });

  describe('mergeResponse', () => {
    const after = () => applyOp(fixture(), complete, ctx);

    it("the server's next instance replaces the optimistic one", () => {
      const next = task('w2', {
        dueDate: '2026-10-12',
        placement: { groupId: 'today', position: 'zz' },
        seq: 9,
        nextReminderAt: NOW + 2 * HOUR,
      });
      const r = mergeResponse(after(), complete, { task: { ...after().tasks.w, seq: 5 }, next });
      expect(r).toMatchObject({ refetch: false });
      expect(r.state.tasks.w2).toBe(next);
      expect(r.state.tasks.w?.seq).toBe(5);
    });

    it('copied subtasks need a refetch', () => {
      const next = task('w2', {
        counts: { subtasks: 2, subtasksDone: 0, comments: 0, attachments: 0 },
      });
      expect(mergeResponse(after(), complete, { task: after().tasks.w, next }).refetch).toBe(true);
    });

    it('no next instance (series ended or another one open) drops the optimistic one', () => {
      const r = mergeResponse(after(), complete, { task: after().tasks.w });
      expect(r.state.tasks.w2).toBeUndefined();
      const sub = listOps.completeTask('ws', true, 'ws2');
      const subAfter = applyOp(fixture(), sub, ctx);
      const merged = mergeResponse(subAfter, sub, { task: subAfter.tasks.ws }).state;
      expect(merged.tasks.ws2).toBeUndefined();
      expect(merged.tasks.w?.counts.subtasks).toBe(1);
      // Without a nextId nothing is dropped.
      const plain = listOps.completeTask('x', true);
      const s = applyOp(fixture(), plain, ctx);
      expect(mergeResponse(s, plain, { task: s.tasks.x }).state.tasks).toEqual(s.tasks);
    });

    it('a server instance under another id replaces the optimistic one', () => {
      const next = task('other', { placement: { groupId: 'today', position: 'zz' } });
      const r = mergeResponse(after(), complete, { task: after().tasks.w, next });
      expect(r.state.tasks.w2).toBeUndefined();
      expect(r.state.tasks.other).toBe(next);
    });

    it('ignores a malformed response', () => {
      expect(mergeResponse(after(), complete, null)).toEqual({ state: after(), refetch: false });
    });

    it('bulk completion of a recurring task asks for a refetch', () => {
      const bulk = listOps.bulk(ORG, { op: 'complete', ids: ['w', 'x'] });
      const s = applyOp(fixture(), bulk, ctx);
      expect(mergeResponse(s, bulk, { results: [] }).refetch).toBe(true);
      const plain = listOps.bulk(ORG, { op: 'complete', ids: ['x'] });
      expect(mergeResponse(applyOp(fixture(), plain, ctx), plain, { results: [] }).refetch).toBe(
        false,
      );
    });
  });
});

describe('task.skip (FR-REC-4 "this occurrence")', () => {
  const skip = listOps.skipTask('w', 'w2');

  it('puts the occurrence in Trash and creates the next one', () => {
    const s = applyOp(fixture(), skip, ctx);
    expect(s.tasks.w).toBeUndefined();
    expect(s.deletedTasks.w).toBeDefined();
    // Its subtask goes with it.
    expect(s.deletedTasks.ws?.withTaskId).toBe('w');
    expect(order(s, 'today')).toEqual(['w2', 'x', 'y']);
    expect(s.tasks.w2).toMatchObject({ dueDate: '2026-10-12', recurrence: MONDAYS });
    expect(applyOp(s, skip, ctx)).toBe(s);
    expect(applyOp(fixture(), listOps.skipTask('nope', 'n2'), ctx)).toEqual(fixture());
  });

  it('without a nextId only the delete is optimistic', () => {
    const s = applyOp(fixture(), listOps.skipTask('w'), ctx);
    expect(s.tasks.w).toBeUndefined();
    expect(Object.keys(s.tasks)).toEqual(['i1', 'x', 'y']);
  });

  it('undo restores it and deletes the next one', () => {
    const state = fixture();
    const undo = inverseOf(skip, state, ctx);
    expect(undo).toEqual([listOps.restoreTask('w'), listOps.deleteTask('w2')]);
    const undone = applyOps(applyOp(state, skip, ctx), undo, ctx);
    expect(order(undone, 'today')).toEqual(['w', 'x', 'y']);
    expect(undone.tasks.ws).toBeDefined();
    expect(inverseOf(skip, applyOp(state, skip, ctx), ctx)).toEqual([]);
  });

  it('merges the next instance, or drops the optimistic one when the series ended', () => {
    const s = applyOp(fixture(), skip, ctx);
    const next = task('w2', { placement: { groupId: 'today', position: k1 }, seq: 7 });
    expect(mergeResponse(s, skip, { next }).state.tasks.w2).toBe(next);
    expect(mergeResponse(s, skip, { next: null }).state.tasks.w2).toBeUndefined();
    expect(mergeResponse(s, skip, undefined).state).toBe(s);
    const bare = listOps.skipTask('w');
    const b = applyOp(fixture(), bare, ctx);
    expect(mergeResponse(b, bare, { next }).state.tasks.w2).toBe(next);
    expect(mergeResponse(b, bare, { next: null }).state).toBe(b);
  });
});

describe('reminder ops on the list (FR-REM-4)', () => {
  const at = NOW + 3 * HOUR;

  it('a create lowers the bell to its fire time', () => {
    const early = listOps.createReminder('w', 'r1', { at: NOW + 30 * MIN });
    expect(early).toEqual({
      kind: 'reminder.create',
      entityId: 'r1',
      taskId: 'w',
      payload: { at: NOW + 30 * MIN, id: 'r1' },
    });
    expect(applyOp(fixture(), early, ctx).tasks.w?.nextReminderAt).toBe(NOW + 30 * MIN);
    // A later one leaves the earlier bell.
    const later = listOps.createReminder('w', 'r2', { at });
    const s = fixture();
    expect(applyOp(s, later, ctx)).toBe(s);
    expect(applyOp(s, listOps.createReminder('nope', 'r3', { at }), ctx)).toBe(s);
  });

  it('a relative reminder resolves against the due moment', () => {
    // x due Fri Oct 9, all day: 09:00 Stockholm (07:00 UTC), a day before.
    const base = applyOp(fixture(), listOps.patchTask('x', { dueDate: '2026-10-09' }), ctx);
    const op = listOps.createReminder('x', 'r1', { offsetMinutes: 1440 });
    expect(applyOp(base, op, ctx).tasks.x?.nextReminderAt).toBe(Date.UTC(2026, 9, 8, 7));
    // The owner's all-day reminder time.
    const at8 = { ...ctx, allDayReminderTime: '08:00' };
    expect(applyOp(base, op, at8).tasks.x?.nextReminderAt).toBe(Date.UTC(2026, 9, 8, 6));
    // Without the owner's timezone an all-day due moment is unknown here.
    expect(applyOp(base, op, { userId: ME, now: NOW })).toBe(base);
    // A timed task needs no owner timezone.
    const timed = applyOp(
      fixture(),
      listOps.patchTask('x', { dueDate: '2026-10-09', dueTime: '14:00', dueTz: 'UTC' }),
      ctx,
    );
    expect(applyOp(timed, op, { userId: ME, now: NOW }).tasks.x?.nextReminderAt).toBe(
      Date.UTC(2026, 9, 8, 14),
    );
    // Dormant without a due date.
    const s = fixture();
    expect(applyOp(s, op, ctx)).toBe(s);
  });

  it('a delete changes nothing locally; the merge asks for a refetch when a bell is shown', () => {
    const del = listOps.deleteReminder('w', 'r1');
    const s = fixture();
    expect(applyOp(s, del, ctx)).toBe(s);
    expect(mergeResponse(s, del, undefined)).toEqual({ state: s, refetch: true });
    const quiet = listOps.deleteReminder('x', 'r1');
    expect(mergeResponse(s, quiet, undefined).refetch).toBe(false);
  });

  it('a create response settles a bell the client could not resolve', () => {
    const op = listOps.createReminder('x', 'r1', { offsetMinutes: 60 });
    const s = fixture();
    const reminder: Reminder = {
      id: 'r1',
      taskId: 'x',
      kind: 'relative',
      offsetMinutes: 60,
      remindAt: null,
      fireAt: at,
      firedAt: null,
      createdAt: NOW,
    };
    expect(mergeResponse(s, op, reminder).state.tasks.x?.nextReminderAt).toBe(at);
    expect(mergeResponse(s, op, { ...reminder, fireAt: null }).state).toBe(s);
    expect(mergeResponse(s, op, { ...reminder, firedAt: NOW }).state).toBe(s);
    expect(mergeResponse(s, op, null).state).toBe(s);
    expect(mergeResponse(s, listOps.createReminder('gone', 'r1', { at }), reminder).state).toBe(s);
  });

  it('create and delete are each other’s inverse; a delete needs its restore spec', () => {
    const s = fixture();
    const create = listOps.createReminder('w', 'r1', { offsetMinutes: 15 });
    expect(inverseOf(create, s, ctx)).toEqual([
      listOps.deleteReminder('w', 'r1', { offsetMinutes: 15 }),
    ]);
    const del = listOps.deleteReminder('w', 'r1', { at });
    expect(del).toMatchObject({ restore: { at } });
    expect(inverseOf(del, s, ctx)).toEqual([listOps.createReminder('w', 'r1', { at })]);
    expect(inverseOf(listOps.deleteReminder('w', 'r1'), s, ctx)).toEqual([]);
    expect(opEntityIds(create)).toEqual(['r1', 'w']);
    expect(opEntityIds(del)).toEqual(['r1', 'w']);
  });

  it('PATCH reminders / clearReminders move the bell', () => {
    const s = fixture();
    const add = listOps.patchTask('w', { reminders: [{ at: NOW + 10 * MIN }] });
    expect(applyOp(s, add, ctx).tasks.w?.nextReminderAt).toBe(NOW + 10 * MIN);
    const clear = listOps.patchTask('w', { clearReminders: true });
    expect(applyOp(s, clear, ctx).tasks.w?.nextReminderAt).toBeNull();
    const replace = listOps.patchTask('w', { clearReminders: true, reminders: [{ at }] });
    expect(applyOp(s, replace, ctx).tasks.w?.nextReminderAt).toBe(at);
  });
});

describe('the task detail (pane) and reminders', () => {
  function reminder(id: string, extra: Partial<Reminder> = {}): Reminder {
    return {
      id,
      taskId: 'd',
      kind: 'relative',
      offsetMinutes: 60,
      remindAt: null,
      fireAt: null,
      firedAt: null,
      createdAt: 1,
      ...extra,
    };
  }

  // Due Fri Oct 9 14:00 UTC.
  const due = Date.UTC(2026, 9, 9, 14);
  function detail(extra: Partial<TaskDetail> = {}): TaskDetail {
    return {
      ...task('d', {
        dueDate: '2026-10-09',
        dueTime: '14:00',
        dueTz: 'UTC',
        nextReminderAt: due - HOUR,
      }),
      description: 'Notes',
      subtasks: [],
      parentChain: [],
      followers: [],
      attachments: [],
      reminders: [reminder('r1', { fireAt: due - HOUR })],
      ...extra,
    };
  }

  it('a create adds the reminder in fire order and moves the bell', () => {
    const d = applyOpToDetail(
      detail(),
      listOps.createReminder('d', 'r2', { offsetMinutes: 1440 }),
      ctx,
    );
    expect(d.reminders?.map((r) => [r.id, r.fireAt])).toEqual([
      ['r2', due - 24 * HOUR],
      ['r1', due - HOUR],
    ]);
    expect(d.reminders?.[0]).toMatchObject({ kind: 'relative', remindAt: null, createdAt: NOW });
    expect(d.nextReminderAt).toBe(due - 24 * HOUR);
    const abs = applyOpToDetail(
      detail(),
      listOps.createReminder('d', 'r3', { at: due + HOUR }),
      ctx,
    );
    expect(abs.reminders?.[1]).toMatchObject({
      id: 'r3',
      kind: 'absolute',
      offsetMinutes: null,
      remindAt: due + HOUR,
      fireAt: due + HOUR,
    });
    expect(abs.nextReminderAt).toBe(due - HOUR);
  });

  it('an identical reminder, or the same id again, is not added twice', () => {
    const d = detail();
    expect(applyOpToDetail(d, listOps.createReminder('d', 'r9', { offsetMinutes: 60 }), ctx)).toBe(
      d,
    );
    expect(applyOpToDetail(d, listOps.createReminder('d', 'r1', { at: due }), ctx)).toBe(d);
    const abs = detail({
      reminders: [reminder('a', { kind: 'absolute', offsetMinutes: null, remindAt: due })],
    });
    expect(applyOpToDetail(abs, listOps.createReminder('d', 'b', { at: due }), ctx)).toBe(abs);
  });

  it('a detail from an older cache gets a reminder list', () => {
    const { reminders: _r, ...old } = detail();
    const d = applyOpToDetail(old, listOps.createReminder('d', 'r2', { at: due }), ctx);
    expect(d.reminders?.map((r) => r.id)).toEqual(['r2']);
    // A delete without a list changes nothing.
    expect(applyOpToDetail(old, listOps.deleteReminder('d', 'r1'), ctx)).toBe(old);
  });

  it('a delete removes it; fired and dormant ones never ring', () => {
    const d = detail({
      reminders: [
        reminder('r1', { fireAt: due - HOUR }),
        reminder('r2', { fireAt: due - 2 * HOUR, firedAt: NOW }),
        reminder('r3', { offsetMinutes: 30, fireAt: due - 30 * MIN }),
      ],
    });
    const after = applyOpToDetail(d, listOps.deleteReminder('d', 'r1'), ctx);
    expect(after.reminders?.map((r) => r.id)).toEqual(['r2', 'r3']);
    expect(after.nextReminderAt).toBe(due - 30 * MIN);
    const none = applyOpToDetail(after, listOps.deleteReminder('d', 'r3'), ctx);
    expect(none.nextReminderAt).toBeNull();
  });

  it('a due change re-resolves pending relative reminders; clearing the date makes them dormant', () => {
    const d = detail({
      reminders: [
        reminder('r1', { fireAt: due - HOUR }),
        reminder('a', {
          kind: 'absolute',
          offsetMinutes: null,
          remindAt: due + HOUR,
          fireAt: due + HOUR,
        }),
        reminder('f', { fireAt: due - 2 * HOUR, firedAt: 5, offsetMinutes: 120 }),
      ],
    });
    const moved = applyOpToDetail(
      d,
      listOps.patchTask('d', { dueDate: '2026-10-10', dueTime: '14:00', dueTz: 'UTC' }),
      ctx,
    );
    expect(moved.reminders?.map((r) => [r.id, r.fireAt])).toEqual([
      ['f', due - 2 * HOUR],
      ['a', due + HOUR],
      ['r1', due + 23 * HOUR],
    ]);
    expect(moved.nextReminderAt).toBe(due + HOUR);
    const cleared = applyOpToDetail(d, listOps.patchTask('d', { dueDate: null }), ctx);
    expect(cleared.reminders?.find((r) => r.id === 'r1')?.fireAt).toBeNull();
    expect(cleared.reminders?.at(-1)?.id).toBe('r1');
    expect(cleared.nextReminderAt).toBe(due + HOUR);
    // An all-day due date without the viewer's timezone cannot be resolved here.
    const allDay = applyOpToDetail(d, listOps.patchTask('d', { dueDate: '2026-10-10' }), {
      userId: ME,
      now: NOW,
    });
    expect(allDay.reminders?.find((r) => r.id === 'r1')?.fireAt).toBeNull();
  });

  it('PATCH clearReminders and reminders', () => {
    const d = detail();
    const cleared = applyOpToDetail(d, listOps.patchTask('d', { clearReminders: true }), ctx);
    expect(cleared.reminders).toEqual([]);
    expect(cleared.nextReminderAt).toBeNull();
    const added = applyOpToDetail(
      d,
      listOps.patchTask('d', { reminders: [{ offsetMinutes: 120 }, { at: due + HOUR }] }),
      ctx,
    );
    expect(added.reminders?.map((r) => r.id)).toEqual(['r1']);
    expect(added.nextReminderAt).toBe(due - 2 * HOUR);
    // A title patch leaves the reminders as they are.
    const titled = applyOpToDetail(d, listOps.patchTask('d', { title: 'New' }), ctx);
    expect(titled.reminders).toBe(d.reminders);
    expect(titled.attachments).toBe(d.attachments);
    // A detail without a reminder list keeps none.
    const { reminders: _r, ...old } = d;
    expect(applyOpToDetail(old, listOps.patchTask('d', { dueDate: null }), ctx)).not.toHaveProperty(
      'reminders',
    );
  });

  it('merging a create: the server row replaces the optimistic one (or the existing identical one wins)', () => {
    const op = listOps.createReminder('d', 'r2', { offsetMinutes: 30 });
    const server = reminder('r2', { offsetMinutes: 30, fireAt: due - 30 * MIN, createdAt: 77 });
    const merged = mergeDetailResponse(detail(), op, server, ctx);
    expect(merged.reminders?.map((r) => [r.id, r.createdAt])).toEqual([
      ['r1', 1],
      ['r2', 77],
    ]);
    expect(merged.nextReminderAt).toBe(due - HOUR);
    const existing = reminder('r1', { fireAt: due - HOUR });
    const same = mergeDetailResponse(
      detail(),
      listOps.createReminder('d', 'r5', { offsetMinutes: 60 }),
      existing,
      ctx,
    );
    expect(same.reminders?.map((r) => r.id)).toEqual(['r1']);
    // A malformed response keeps the optimistic state.
    expect(mergeDetailResponse(detail(), op, null, ctx).reminders?.map((r) => r.id)).toEqual([
      'r1',
      'r2',
    ]);
    const del = listOps.deleteReminder('d', 'r1');
    expect(mergeDetailResponse(detail(), del, undefined, ctx).reminders).toEqual([]);
  });

  it("reminder ops on a subtask move the subtask's bell; other tasks' are ignored", () => {
    const d = detail({ subtasks: [task('s', { parentId: 'd', subtaskPosition: k1 })] });
    const op = listOps.createReminder('s', 'r1', { at: due });
    expect(applyOpToDetail(d, op, ctx).subtasks[0]?.nextReminderAt).toBe(due);
    const reminderDto = reminder('r1', {
      taskId: 's',
      kind: 'absolute',
      offsetMinutes: null,
      remindAt: due,
      fireAt: due,
    });
    expect(mergeDetailResponse(d, op, reminderDto, ctx).subtasks[0]?.nextReminderAt).toBe(due);
    const other = listOps.createReminder('zz', 'r1', { at: due });
    expect(mergeDetailResponse(d, other, reminderDto, ctx)).toBe(d);
  });

  it('a patch response keeps the reminders and attachments the detail has', () => {
    const op = listOps.patchTask('d', { title: 'New' });
    const {
      reminders: _r,
      attachments: _a,
      subtasks: _s,
      parentChain: _p,
      followers: _f,
      description: _d,
      ...dto
    } = detail();
    const merged = mergeDetailResponse(detail(), op, { task: { ...dto, title: 'New' } }, ctx);
    expect(merged.title).toBe('New');
    expect(merged.reminders).toEqual(detail().reminders);
    expect(merged.attachments).toEqual([]);
  });

  it("completing a recurring subtask shows its next instance among the detail's subtasks", () => {
    const d = detail({
      subtasks: [
        task('s', {
          parentId: 'd',
          subtaskPosition: k1,
          dueDate: '2026-10-07',
          recurrence: 'FREQ=DAILY',
          recurrenceBasis: 'due',
        }),
      ],
    });
    const after = applyOpToDetail(d, listOps.completeTask('s', true, 's2'), ctx);
    expect(after.subtasks.map((t) => [t.id, t.dueDate])).toEqual([
      ['s', '2026-10-07'],
      ['s2', '2026-10-08'],
    ]);
  });
});

describe("Everyone's tasks", () => {
  const rows = [
    task('w', { dueDate: '2026-10-05', recurrence: MONDAYS, recurrenceBasis: 'due' }),
    task('b', { assigneeId: BOB }),
  ];
  const listCtx = { ...ctx };

  it('a skip removes the row and the response adds the next one', () => {
    const skip = listOps.skipTask('w', 'w2');
    const after = applyOpToTaskList(rows, skip, listCtx);
    expect(after.map((t) => t.id)).toEqual(['b']);
    const next = task('w2', { dueDate: '2026-10-12' });
    expect(mergeTaskListResponse(after, skip, { next }).tasks.map((t) => t.id)).toEqual([
      'b',
      'w2',
    ]);
    expect(mergeTaskListResponse(after, skip, { next: null }).tasks).toBe(after);
  });

  it('reminder ops leave the rows alone', () => {
    const ops: ListOpSpec[] = [
      listOps.createReminder('w', 'r1', { at: NOW }),
      listOps.deleteReminder('w', 'r1'),
    ];
    for (const op of ops) expect(applyOpToTaskList(rows, op, listCtx)).toBe(rows);
  });
});
