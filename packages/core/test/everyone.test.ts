import { describe, expect, it } from 'vitest';
import type { DueContext } from '../src/dates/index.ts';
import {
  applyOpToTaskList,
  compareRows,
  type EveryoneContext,
  isRow,
  matchesEveryoneFilters,
  mergeTaskListResponse,
  rowsDeletedWith,
  selectEveryone,
  type TaskListContext,
} from '../src/everyone.ts';
import { listOps } from '../src/reducers.ts';
import type { Task } from '../src/schemas/list.ts';

const ORG = 'org-1';
const ME = 'u-me';
const ANNA = 'u-anna';
const OLLE = 'u-olle';
const ORVAR = 'u-orvar';
const GONE = 'u-gone';

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    orgId: ORG,
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title: id,
    assigneeId: ME,
    createdBy: ME,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
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

const due: DueContext = {
  today: '2026-10-09',
  nowMs: Date.parse('2026-10-09T12:00:00Z'),
  viewerTz: 'UTC',
};

const members = [
  { userId: ME, name: 'Zed Me' },
  { userId: OLLE, name: 'Ölle' },
  { userId: ANNA, name: 'anna' },
  { userId: ORVAR, name: 'Orvar' },
];

const base: EveryoneContext = { viewerId: ME, members, locale: 'sv', due };

describe('selectEveryone (02 §11)', () => {
  const tasks = [
    task('a1', { assigneeId: ANNA, dueDate: '2026-10-12' }),
    task('a2', { assigneeId: ANNA, dueDate: '2026-10-10', dueTime: '09:00' }),
    task('a3', { assigneeId: ANNA, dueDate: '2026-10-10' }),
    task('a4', { assigneeId: ANNA, createdAt: 5 }),
    task('a5', { assigneeId: ANNA, createdAt: 3 }),
    task('m1', { completedAt: 9 }),
    task('m2'),
    task('u1', { assigneeId: null }),
    task('g1', { assigneeId: GONE }),
    // Rows by the server's rule: an orphan is a row, a subtask like its parent is not.
    task('s1', { parentId: 'm2', assigneeId: ME }),
    task('s2', { parentId: 'm2', assigneeId: OLLE }),
    task('s3', { parentId: 'missing', assigneeId: ORVAR }),
  ];

  it('orders sections: me, members alphabetically, others, Unassigned', () => {
    const sections = selectEveryone(tasks, base);
    // Swedish collation: Ö sorts after O.
    expect(sections.map((s) => s.assigneeId)).toEqual([ME, ANNA, ORVAR, OLLE, GONE, null]);
  });

  it('orders rows by due date (untimed after timed, no date last), then created, then ID', () => {
    const sections = selectEveryone(tasks, base);
    expect(sections[1]).toEqual({
      assigneeId: ANNA,
      taskIds: ['a2', 'a3', 'a1', 'a5', 'a4'],
      openCount: 5,
    });
    expect(sections.find((s) => s.assigneeId === OLLE)?.taskIds).toEqual(['s2']);
    expect(sections.find((s) => s.assigneeId === ORVAR)?.taskIds).toEqual(['s3']);
    expect(sections[0]?.taskIds).toEqual(['m2']);
  });

  it('shows completed rows on request, counting only the open ones', () => {
    const [mine] = selectEveryone(tasks, { ...base, filters: { showCompleted: true } });
    expect(mine).toEqual({ assigneeId: ME, taskIds: ['m1', 'm2'], openCount: 1 });
  });

  it('keeps empty member sections and drops empty sections of non-members', () => {
    const sections = selectEveryone([task('x', { assigneeId: ANNA })], base);
    expect(sections.map((s) => [s.assigneeId, s.taskIds.length])).toEqual([
      [ME, 0],
      [ANNA, 1],
      [ORVAR, 0],
      [OLLE, 0],
      [null, 0],
    ]);
  });

  it('the member filter keeps exactly the chosen sections', () => {
    const sections = selectEveryone(tasks, { ...base, filters: { assigneeIds: [null, OLLE] } });
    expect(sections.map((s) => s.assigneeId)).toEqual([OLLE, null]);
    expect(sections[1]?.taskIds).toEqual(['u1']);
  });

  it('filters by tag (OR) and due', () => {
    const tagged = [
      task('t1', { tagIds: ['x', 'y'] }),
      task('t2', { tagIds: ['x'] }),
      task('t3', { dueDate: '2026-10-08' }),
      task('t4', { dueDate: '2026-10-09', dueTime: '08:00', dueTz: 'UTC' }),
      task('t5', { dueDate: '2026-10-15' }),
      task('t6', { dueDate: '2026-10-16' }),
    ];
    const mine = (filters: EveryoneContext['filters']) =>
      selectEveryone(tagged, { ...base, filters })[0]?.taskIds;
    expect(mine({ tagIds: ['x', 'y'] })).toEqual(['t1', 't2']);
    expect(mine({ tagIds: ['y'] })).toEqual(['t1']);
    expect(mine({ due: 'overdue' })).toEqual(['t3', 't4']);
    expect(mine({ due: 'week' })).toEqual(['t4', 't5']);
    expect(mine({ due: 'nodate' })).toEqual(['t1', 't2']);
    expect(mine({ due: 'any' })).toHaveLength(6);
    // Without a due context the date filters match nothing.
    expect(matchesEveryoneFilters(tagged[2] as Task, { due: 'overdue' })).toBe(false);
    expect(matchesEveryoneFilters(tagged[4] as Task, { due: 'week' })).toBe(false);
  });

  it('isRow and compareRows', () => {
    const parent = task('p', { assigneeId: ANNA });
    const byId = new Map([['p', parent]]);
    expect(isRow(task('c', { parentId: 'p', assigneeId: ANNA }), byId)).toBe(false);
    expect(isRow(task('c', { parentId: 'p', assigneeId: null }), byId)).toBe(true);
    expect(compareRows(task('a', { dueDate: '2026-01-01' }), task('b'))).toBeLessThan(0);
    expect(compareRows(task('b'), task('a', { dueDate: '2026-01-01' }))).toBeGreaterThan(0);
    expect(
      compareRows(
        task('a', { dueDate: '2026-01-01', dueTime: '10:00' }),
        task('b', { dueDate: '2026-01-01', dueTime: '09:00' }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareRows(
        task('a', { dueDate: '2026-01-01', dueTime: '10:00' }),
        task('b', { dueDate: '2026-01-01' }),
      ),
    ).toBeLessThan(0);
  });
});

describe('applyOpToTaskList (the everyone caches)', () => {
  const ctx: TaskListContext = { userId: ME, now: 500 };
  const list = () => [
    task('p', {
      assigneeId: ANNA,
      counts: { subtasks: 1, subtasksDone: 0, comments: 2, attachments: 0 },
    }),
    task('o', { parentId: 'p', assigneeId: OLLE }),
    task('q', { tagIds: ['x'] }),
  ];
  const byId = (tasks: readonly Task[], id: string) => tasks.find((t) => t.id === id);

  it('creates rows assigned to me, to a member, or nobody; subtasks only when they are rows', () => {
    const tasks = list();
    const mine = applyOpToTaskList(tasks, listOps.createTask({ id: 'n', title: 'N' }), ctx);
    expect(byId(mine, 'n')).toMatchObject({ assigneeId: ME, orgId: ORG, createdAt: 500 });
    const annas = applyOpToTaskList(
      tasks,
      listOps.createTask({
        id: 'n',
        title: 'N',
        assigneeId: ANNA,
        description: ' x ',
        dueDate: '2026-10-10',
        tagIds: ['t', 't'],
      }),
      ctx,
    );
    expect(byId(annas, 'n')).toMatchObject({
      assigneeId: ANNA,
      hasDescription: true,
      dueDate: '2026-10-10',
      tagIds: ['t'],
    });
    expect(
      byId(
        applyOpToTaskList(
          tasks,
          listOps.createTask({ id: 'n', title: 'N', assigneeId: null }),
          ctx,
        ),
        'n',
      )?.assigneeId,
    ).toBeNull();
    // Like its parent: not a row, but the parent counts it.
    const sub = applyOpToTaskList(
      tasks,
      listOps.createTask({ id: 'n', title: 'N', parentId: 'p' }),
      ctx,
    );
    expect(byId(sub, 'n')).toBeUndefined();
    expect(byId(sub, 'p')?.counts.subtasks).toBe(2);
    const orphan = applyOpToTaskList(
      tasks,
      listOps.createTask({ id: 'n', title: 'N', parentId: 'p', assigneeId: ME }),
      ctx,
    );
    expect(byId(orphan, 'n')).toMatchObject({ parentId: 'p', assigneeId: ME });
    // Unknown parent, or an existing id: unchanged.
    const unknown = listOps.createTask({ id: 'n', title: 'N', parentId: 'zz' });
    expect(applyOpToTaskList(tasks, unknown, ctx)).toBe(tasks);
    expect(applyOpToTaskList(tasks, listOps.createTask({ id: 'q', title: 'Q' }), ctx)).toBe(tasks);
    expect(
      byId(applyOpToTaskList([], listOps.createTask({ id: 'n', title: 'N' }), ctx), 'n')?.orgId,
    ).toBe('');
  });

  it('patches fields, the due unit and the assignee; children like their parent leave', () => {
    const tasks = list();
    const renamed = applyOpToTaskList(
      tasks,
      listOps.patchTask('q', { title: 'Q2', description: '', dueDate: '2026-10-11' }),
      ctx,
    );
    expect(byId(renamed, 'q')).toMatchObject({
      title: 'Q2',
      hasDescription: false,
      dueDate: '2026-10-11',
      dueTime: null,
      updatedAt: 500,
    });
    const assigned = applyOpToTaskList(tasks, listOps.patchTask('p', { assigneeId: OLLE }), ctx);
    expect(byId(assigned, 'p')?.assigneeId).toBe(OLLE);
    expect(byId(assigned, 'o')).toBeUndefined();
    const other = applyOpToTaskList(tasks, listOps.patchTask('p', { assigneeId: ME }), ctx);
    expect(byId(other, 'o')).toBeDefined();
    expect(applyOpToTaskList(tasks, listOps.patchTask('q', { parentId: 'p' }), ctx)).toBe(tasks);
    expect(applyOpToTaskList(tasks, listOps.patchTask('zz', { title: 'x' }), ctx)).toBe(tasks);
  });

  it('completes and reopens, keeping the parent counter', () => {
    const tasks = list();
    const done = applyOpToTaskList(tasks, listOps.completeTask('o', true), ctx);
    expect(byId(done, 'o')?.completedAt).toBe(500);
    expect(byId(done, 'p')?.counts.subtasksDone).toBe(1);
    expect(applyOpToTaskList(done, listOps.completeTask('o', true), ctx)).toBe(done);
    const open = applyOpToTaskList(done, listOps.completeTask('o', false), ctx);
    expect(byId(open, 'p')?.counts.subtasksDone).toBe(0);
    const bulk = applyOpToTaskList(
      tasks,
      listOps.bulk(ORG, { op: 'complete', ids: ['q', 'p'] }),
      ctx,
    );
    expect(bulk.filter((t) => t.completedAt !== null).map((t) => t.id)).toEqual(['p', 'q']);
    expect(
      applyOpToTaskList(bulk, listOps.bulk(ORG, { op: 'uncomplete', ids: ['q'] }), ctx).find(
        (t) => t.id === 'q',
      )?.completedAt,
    ).toBeNull();
  });

  it('deletes with the rows below, and restores what it recalls', () => {
    const tasks = list();
    const recalled = rowsDeletedWith(tasks, ['p', 'zz', 'p']);
    expect([...recalled.keys()]).toEqual(['p']);
    expect(recalled.get('p')?.map((t) => t.id)).toEqual(['p', 'o']);
    const deleted = applyOpToTaskList(tasks, listOps.deleteTask('p'), ctx);
    expect(deleted.map((t) => t.id)).toEqual(['q']);
    expect(applyOpToTaskList(tasks, listOps.deleteTask('zz'), ctx)).toBe(tasks);
    const recall = (id: string) => recalled.get(id);
    const restored = applyOpToTaskList(deleted, listOps.restoreTask('p'), { ...ctx, recall });
    expect(restored.map((t) => t.id)).toEqual(['q', 'p', 'o']);
    expect(applyOpToTaskList(deleted, listOps.restoreTask('p'), ctx)).toBe(deleted);
    expect(applyOpToTaskList(tasks, listOps.restoreTask('p'), { ...ctx, recall })).toBe(tasks);
    const bulkGone = applyOpToTaskList(tasks, listOps.bulk(ORG, { op: 'delete', ids: ['q'] }), ctx);
    expect(bulkGone.map((t) => t.id)).toEqual(['p', 'o']);
    const bulkBack = applyOpToTaskList(bulkGone, listOps.bulk(ORG, { op: 'restore', ids: ['q'] }), {
      ...ctx,
      recall: (id) => rowsDeletedWith(tasks, [id]).get(id),
    });
    expect(bulkBack.map((t) => t.id)).toEqual(['p', 'o', 'q']);
  });

  it('bulk due, assign and tags; moves, groups and follows change nothing', () => {
    const tasks = list();
    const dated = applyOpToTaskList(
      tasks,
      listOps.bulk(ORG, { op: 'setDue', ids: ['q'], args: { dueDate: '2026-12-24' } }),
      ctx,
    );
    expect(byId(dated, 'q')?.dueDate).toBe('2026-12-24');
    // The due unit is replaced as a whole, as in My tasks: a bulk "no date" clears the dates.
    const timed = applyOpToTaskList(
      dated,
      listOps.bulk(ORG, {
        op: 'setDue',
        ids: ['q'],
        args: { dueDate: '2026-12-24', dueTime: '09:00', dueTz: 'Europe/Stockholm' },
      }),
      ctx,
    );
    const cleared = applyOpToTaskList(
      timed,
      listOps.bulk(ORG, { op: 'setDue', ids: ['q'], args: {} }),
      ctx,
    );
    expect(byId(cleared, 'q')).toMatchObject({ dueDate: null, dueTime: null, dueTz: null });
    const assigned = applyOpToTaskList(
      tasks,
      listOps.bulk(ORG, { op: 'assign', ids: ['q'], args: { assigneeId: null } }),
      ctx,
    );
    expect(byId(assigned, 'q')?.assigneeId).toBeNull();
    const tagged = applyOpToTaskList(
      tasks,
      listOps.bulk(ORG, { op: 'addTag', ids: ['q', 'p'], args: { tagId: 'x' } }),
      ctx,
    );
    expect(tagged.map((t) => t.tagIds)).toEqual([['x'], [], ['x']]);
    expect(applyOpToTaskList(tasks, listOps.addTag('q', 'x'), ctx)).toBe(tasks);
    expect(byId(applyOpToTaskList(tasks, listOps.removeTag('q', 'x'), ctx), 'q')?.tagIds).toEqual(
      [],
    );
    for (const op of [
      listOps.bulk(ORG, { op: 'move', ids: ['q'], args: { groupId: 'g' } }),
      listOps.moveTask('q', { groupId: 'g' }),
      listOps.reorderSubtask('o', {}),
      listOps.setExpanded('p', true),
      listOps.setFollowing('p', true),
      listOps.patchComment('c', 'p', { body: 'x' }),
      listOps.createTag({ id: 't', name: 'T' }),
      listOps.createGroup({ id: 'g', name: 'G' }),
      listOps.patchGroup('g', { name: 'H' }),
      listOps.moveGroup('g', {}),
      listOps.deleteGroup('g'),
      listOps.restoreGroup('g'),
    ]) {
      expect(applyOpToTaskList(tasks, op, ctx)).toBe(tasks);
    }
  });

  it('duplicates a row and counts comments', () => {
    const tasks = list();
    const copied = applyOpToTaskList(tasks, listOps.duplicateTask('p', 'p2'), ctx);
    expect(byId(copied, 'p2')).toMatchObject({ seq: null, completedAt: null, createdBy: ME });
    expect(byId(copied, 'p2')?.counts).toEqual({
      subtasks: 1,
      subtasksDone: 0,
      comments: 0,
      attachments: 0,
    });
    const flat = applyOpToTaskList(tasks, listOps.duplicateTask('p', 'p2', false), ctx);
    expect(byId(flat, 'p2')?.counts.subtasks).toBe(0);
    expect(applyOpToTaskList(copied, listOps.duplicateTask('p', 'p2'), ctx)).toBe(copied);
    const commented = applyOpToTaskList(
      tasks,
      listOps.createComment('p', { id: 'c', body: 'x' }),
      ctx,
    );
    expect(byId(commented, 'p')?.counts.comments).toBe(3);
    const deleted = applyOpToTaskList(tasks, listOps.deleteComment('c', 'p'), ctx);
    expect(byId(deleted, 'p')?.counts.comments).toBe(1);
    const restored = applyOpToTaskList(tasks, listOps.restoreComment('c', 'p'), ctx);
    expect(byId(restored, 'p')?.counts.comments).toBe(3);
  });
});

describe('applyOpToTaskList: recurrence (ADR 0049 §1.8, as the My tasks reducer)', () => {
  const ctx: TaskListContext = { userId: ME, now: 500 };
  const MONDAYS = 'FREQ=WEEKLY;BYDAY=MO';
  const list = () => [
    task('w', { dueDate: '2026-10-05', recurrence: MONDAYS, recurrenceBasis: 'due' }),
    task('x', { dueDate: '2026-01-31', recurrence: null, recurrenceBasis: null }),
    task('n'),
  ];
  const byId = (tasks: readonly Task[], id: string) => tasks.find((t) => t.id === id);

  it('a recurrence-only patch sets the rule, normalised against the due date', () => {
    const set = applyOpToTaskList(
      list(),
      listOps.patchTask('x', { recurrence: 'FREQ=MONTHLY' }),
      ctx,
    );
    expect(byId(set, 'x')).toMatchObject({
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=31',
      recurrenceBasis: 'due',
      updatedAt: 500,
    });
  });

  it('stops the series, re-normalises on a basis alone, and keeps the rule on a new date', () => {
    const tasks = list();
    expect(
      byId(applyOpToTaskList(tasks, listOps.patchTask('w', { recurrence: null }), ctx), 'w'),
    ).toMatchObject({ dueDate: '2026-10-05', recurrence: null, recurrenceBasis: null });
    const basis = applyOpToTaskList(
      tasks,
      listOps.patchTask('w', { recurrenceBasis: 'completion' }),
      ctx,
    );
    expect(byId(basis, 'w')).toMatchObject({
      recurrence: 'FREQ=WEEKLY',
      recurrenceBasis: 'completion',
    });
    expect(
      byId(applyOpToTaskList(tasks, listOps.patchTask('w', { dueDate: '2026-10-12' }), ctx), 'w'),
    ).toMatchObject({ dueDate: '2026-10-12', recurrence: MONDAYS, recurrenceBasis: 'due' });
  });

  it('clearing the due date clears the rule; a rule without a date is ignored', () => {
    const tasks = list();
    const cleared = applyOpToTaskList(tasks, listOps.patchTask('w', { dueDate: null }), ctx);
    expect(byId(cleared, 'w')).toMatchObject({ recurrence: null, recurrenceBasis: null });
    const undated = applyOpToTaskList(
      tasks,
      listOps.patchTask('n', { recurrence: 'FREQ=DAILY' }),
      ctx,
    );
    expect(byId(undated, 'n')).not.toHaveProperty('recurrence');
  });

  it('a create and a bulk setDue carry the rule too', () => {
    const created = applyOpToTaskList(
      list(),
      listOps.createTask({ id: 'c', title: 'C', dueDate: '2026-10-05', recurrence: MONDAYS }),
      ctx,
    );
    expect(byId(created, 'c')).toMatchObject({ recurrence: MONDAYS, recurrenceBasis: 'due' });
    const bulk = applyOpToTaskList(
      list(),
      listOps.bulk(ORG, {
        op: 'setDue',
        ids: ['x'],
        args: { dueDate: '2026-10-07', recurrence: 'FREQ=DAILY', recurrenceBasis: 'completion' },
      }),
      ctx,
    );
    expect(byId(bulk, 'x')).toMatchObject({
      recurrence: 'FREQ=DAILY',
      recurrenceBasis: 'completion',
    });
  });
});

describe('mergeTaskListResponse', () => {
  const tasks = [task('a'), task('p', { assigneeId: ANNA })];

  it('replaces task DTOs; a restored or recurring task joins when it is a row', () => {
    const create = listOps.createTask({ id: 'a', title: 'A' });
    const merged = mergeTaskListResponse(tasks, create, task('a', { seq: 7 }));
    expect(merged.tasks[0]?.seq).toBe(7);
    expect(merged.refetch).toBe(false);
    expect(mergeTaskListResponse(tasks, create, task('zz')).tasks).toBe(tasks);
    expect(mergeTaskListResponse(tasks, create, undefined).tasks).toBe(tasks);
    const restored = mergeTaskListResponse(tasks, listOps.restoreTask('r'), task('r'));
    expect(restored.tasks.map((t) => t.id)).toEqual(['a', 'p', 'r']);
    const child = task('c', { parentId: 'p', assigneeId: ANNA });
    expect(mergeTaskListResponse(tasks, listOps.restoreTask('c'), child).tasks).toBe(tasks);
    expect(mergeTaskListResponse(tasks, listOps.restoreTask('c'), null).tasks).toBe(tasks);
    const complete = listOps.completeTask('a', true);
    const next = mergeTaskListResponse(tasks, complete, {
      task: task('a', { completedAt: 3 }),
      next: task('a2'),
    });
    expect(next.tasks.map((t) => [t.id, t.completedAt])).toEqual([
      ['a', 3],
      ['p', null],
      ['a2', null],
    ]);
    expect(mergeTaskListResponse(tasks, complete, {}).tasks).toBe(tasks);
  });

  it('asks for a refetch after assignments, re-parents, ignored fields and failures', () => {
    const patch = (p: object) => listOps.patchTask('a', p as never);
    const dto = { task: task('a', { title: 'X' }), ignoredFields: [] };
    expect(mergeTaskListResponse(tasks, patch({ title: 'X' }), dto)).toMatchObject({
      refetch: false,
    });
    expect(mergeTaskListResponse(tasks, patch({ title: 'X' }), dto).tasks[0]?.title).toBe('X');
    expect(mergeTaskListResponse(tasks, patch({ assigneeId: ANNA }), dto).refetch).toBe(true);
    expect(mergeTaskListResponse(tasks, patch({ parentId: 'p' }), dto).refetch).toBe(true);
    expect(
      mergeTaskListResponse(tasks, patch({ title: 'X' }), { ...dto, ignoredFields: ['title'] })
        .refetch,
    ).toBe(true);
    expect(mergeTaskListResponse(tasks, patch({ title: 'X' }), undefined).tasks).toBe(tasks);
    const bulk = (op: 'assign' | 'complete') =>
      listOps.bulk(ORG, {
        op,
        ids: ['a'],
        ...(op === 'assign' ? { args: { assigneeId: null } } : {}),
      } as never);
    expect(mergeTaskListResponse(tasks, bulk('assign'), { results: [] }).refetch).toBe(true);
    expect(
      mergeTaskListResponse(tasks, bulk('complete'), { results: [{ ok: true }] }).refetch,
    ).toBe(false);
    expect(
      mergeTaskListResponse(tasks, bulk('complete'), { results: [{ ok: false }] }).refetch,
    ).toBe(true);
    expect(mergeTaskListResponse(tasks, bulk('complete'), undefined).refetch).toBe(false);
    expect(mergeTaskListResponse(tasks, listOps.deleteTask('a'), undefined)).toEqual({
      tasks,
      refetch: false,
    });
  });
});
