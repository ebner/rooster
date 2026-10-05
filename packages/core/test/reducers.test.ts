import { describe, expect, it } from 'vitest';
import { generateNKeysBetween } from '../src/ordering.ts';
import {
  type ApplyContext,
  applyOp,
  applyOps,
  emptyListState,
  groupIdOf,
  inboxOf,
  intentAt,
  inverseOf,
  inverseOfSequence,
  keysForIntent,
  type ListOpSpec,
  type ListState,
  listOps,
  mergeResponse,
  normalGroups,
  normalizeMyList,
  orderedGroups,
  restorePlacements,
  tasksInGroup,
} from '../src/reducers.ts';
import type { Group, MyList, Task } from '../src/schemas/list.ts';

const ORG = 'org-1';
const ME = 'user-1';
const ctx: ApplyContext = { userId: ME, now: 1_000 };

function group(id: string, name: string, position: string, kind: Group['kind'] = 'normal'): Group {
  return { id, orgId: ORG, kind, name, position, collapsed: false };
}

function task(id: string, groupId: string, position: string, extra: Partial<Task> = {}): Task {
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
    completedAt: null,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: { groupId, position },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

/** Inbox (i1), Today (a1..a4), Prio (p1, p2), Upcoming (empty). */
function fixture(): ListState {
  const [k1, k2, k3, k4] = generateNKeysBetween(null, null, 4) as [string, string, string, string];
  const list: MyList = {
    groups: [
      group('inbox', 'Inbox', 'a0', 'inbox'),
      group('today', 'Today', 'a0'),
      group('prio', 'Prio', 'a1'),
      group('upcoming', 'Upcoming', 'a2'),
    ],
    tasks: [
      task('i1', 'inbox', k1),
      task('a1', 'today', k1),
      task('a2', 'today', k2),
      task('a3', 'today', k3),
      task('a4', 'today', k4),
      task('p1', 'prio', k1),
      task('p2', 'prio', k2),
    ],
    expandedTaskIds: [],
    serverTime: 5,
  };
  return normalizeMyList(ORG, list);
}

/** The order-and-content projection undo must restore exactly. */
function snapshot(state: ListState) {
  return orderedGroups(state).map((g) => ({
    id: g.id,
    name: g.name,
    collapsed: g.collapsed,
    tasks: tasksInGroup(state, g.id).map((t) => ({
      id: t.id,
      title: t.title,
      done: t.completedAt !== null,
      due: [t.dueDate, t.dueTime, t.dueTz],
    })),
  }));
}

const ids = (state: ListState, groupId: string) => tasksInGroup(state, groupId).map((t) => t.id);

/** Applies `op`, then its inverse, and expects the original projection back. */
function expectUndoable(state: ListState, op: ListOpSpec) {
  const after = applyOp(state, op, ctx);
  const inverse = inverseOf(op, state, ctx);
  expect(inverse.length).toBeGreaterThan(0);
  expect(snapshot(applyOps(after, inverse, ctx))).toEqual(snapshot(state));
  return { after, inverse };
}

describe('state helpers', () => {
  it('orders the Inbox first, then groups by position', () => {
    const state = fixture();
    expect(orderedGroups(state).map((g) => g.id)).toEqual(['inbox', 'today', 'prio', 'upcoming']);
    expect(normalGroups(state).map((g) => g.id)).toEqual(['today', 'prio', 'upcoming']);
    expect(inboxOf(state)?.id).toBe('inbox');
    expect(orderedGroups(emptyListState(ORG))).toEqual([]);
  });

  it('keeps locally deleted entities across a refetch, unless the server lists them again', () => {
    let state = applyOp(fixture(), listOps.deleteTask('a1'), ctx);
    state = applyOp(state, listOps.deleteGroup('upcoming'), ctx);
    const list: MyList = {
      groups: Object.values(state.groups),
      tasks: Object.values(state.tasks),
      expandedTaskIds: ['p1'],
      serverTime: 9,
    };
    const again = normalizeMyList(ORG, list, state);
    expect(Object.keys(again.deletedTasks)).toEqual(['a1']);
    expect(Object.keys(again.deletedGroups)).toEqual(['upcoming']);
    expect(again.expandedTaskIds).toEqual(['p1']);
    const relisted = normalizeMyList(
      ORG,
      {
        ...list,
        tasks: [...list.tasks, task('a1', 'today', 'Zz')],
        groups: [...list.groups, group('upcoming', 'U', 'a2')],
      },
      state,
    );
    expect(relisted.deletedTasks).toEqual({});
    expect(relisted.deletedGroups).toEqual({});
  });

  it('finds the group of live and deleted tasks', () => {
    const state = applyOp(fixture(), listOps.deleteTask('p1'), ctx);
    expect(groupIdOf(state, 'a1')).toBe('today');
    expect(groupIdOf(state, 'p1')).toBe('prio');
    expect(groupIdOf(state, 'nope')).toBeUndefined();
  });

  it('computes intents for an index in an order', () => {
    const order = [{ id: 'x' }, { id: 'y' }];
    expect(intentAt(order, 0)).toEqual({ afterId: null, beforeId: 'x' });
    expect(intentAt(order, 1)).toEqual({ afterId: 'x', beforeId: 'y' });
    expect(intentAt(order, 2)).toEqual({ afterId: 'y', beforeId: null });
  });

  it('keysForIntent mirrors the server, falling back to the end', () => {
    const siblings = [
      { id: 'x', position: 'a0' },
      { id: 'y', position: 'a1' },
    ];
    const [end = ''] = keysForIntent(siblings, {});
    expect(end > 'a1').toBe(true);
    const [top = ''] = keysForIntent(siblings, { afterId: null, beforeId: 'x' });
    expect(top < 'a0').toBe(true);
    const [mid = ''] = keysForIntent(siblings, { afterId: 'x', beforeId: 'y' });
    expect(mid > 'a0' && mid < 'a1').toBe(true);
    const [missing = ''] = keysForIntent(siblings, { afterId: 'zz', beforeId: 'y' });
    expect(missing > 'a1').toBe(true);
    const [missingBefore = ''] = keysForIntent(siblings, { beforeId: 'zz' });
    expect(missingBefore > 'a1').toBe(true);
    // ADR 0005 §2: with both, directly below afterId, whatever beforeId says.
    const [below = ''] = keysForIntent(siblings, { afterId: 'x', beforeId: 'zz' });
    expect(below > 'a0' && below < 'a1').toBe(true);
    const [afterOnly = ''] = keysForIntent(siblings, { afterId: 'x' });
    expect(afterOnly > 'a0' && afterOnly < 'a1').toBe(true);
    const [aboveOnly = ''] = keysForIntent(siblings, { beforeId: 'y' });
    expect(aboveOnly > 'a0' && aboveOnly < 'a1').toBe(true);
    const many = keysForIntent(siblings, { afterId: 'x', beforeId: 'y' }, 3);
    expect(many).toHaveLength(3);
    expect([...many].sort()).toEqual(many);
    expect(keysForIntent([], {})).toHaveLength(1);
  });
});

describe('task reducers', () => {
  it('creates a task between its neighbours, assigned to and created by me', () => {
    const op = listOps.createTask({
      id: 'n1',
      title: 'Buy milk',
      groupId: 'today',
      afterId: 'a1',
      beforeId: 'a2',
    });
    const state = applyOp(fixture(), op, ctx);
    expect(ids(state, 'today')).toEqual(['a1', 'n1', 'a2', 'a3', 'a4']);
    expect(state.tasks.n1).toMatchObject({
      title: 'Buy milk',
      assigneeId: ME,
      createdBy: ME,
      seq: null,
      completedAt: null,
      createdAt: 1_000,
      dueDate: null,
    });
    // Idempotent: replaying the create over a snapshot that has it changes nothing.
    expect(applyOp(state, op, ctx)).toBe(state);
  });

  it('creates at the end, with a due unit and description, and in the Inbox for an unknown group', () => {
    let state = applyOp(
      fixture(),
      listOps.createTask({
        id: 'n1',
        title: 'Call Bob',
        groupId: 'prio',
        dueDate: '2026-10-09',
        dueTime: '14:00',
        dueTz: 'Europe/Stockholm',
        description: 'notes',
      }),
      ctx,
    );
    expect(ids(state, 'prio')).toEqual(['p1', 'p2', 'n1']);
    expect(state.tasks.n1).toMatchObject({
      dueDate: '2026-10-09',
      dueTime: '14:00',
      dueTz: 'Europe/Stockholm',
      description: 'notes',
    });
    // ADR 0005 §1: no intent fields → top of the Inbox; explicit nulls → the end.
    state = applyOp(state, listOps.createTask({ id: 'n2', title: 'x', groupId: 'gone' }), ctx);
    expect(ids(state, 'inbox')).toEqual(['n2', 'i1']);
    state = applyOp(
      state,
      listOps.createTask({ id: 'n5', title: 'x', groupId: 'gone', afterId: null, beforeId: null }),
      ctx,
    );
    expect(ids(state, 'inbox')).toEqual(['n2', 'i1', 'n5']);
    const noInbox = emptyListState(ORG);
    expect(
      applyOp(noInbox, listOps.createTask({ id: 'n3', title: 'x', groupId: 'gone' }), ctx),
    ).toBe(noInbox);
    const empty = { ...emptyListState(ORG), groups: { g: group('g', 'G', 'a0') } };
    const created = applyOp(empty, listOps.createTask({ id: 'n4', title: 'x', groupId: 'g' }), ctx);
    expect(ids(created, 'g')).toEqual(['n4']);
  });

  it('patches titles and replaces the due unit as a whole', () => {
    let state = applyOp(
      fixture(),
      listOps.patchTask('a1', { dueDate: '2026-10-10', dueTime: '09:00', dueTz: 'UTC' }),
      ctx,
    );
    state = applyOp(state, listOps.patchTask('a1', { title: 'New', dueDate: '2026-10-11' }), ctx);
    expect(state.tasks.a1).toMatchObject({
      title: 'New',
      dueDate: '2026-10-11',
      dueTime: null,
      dueTz: null,
      updatedAt: 1_000,
    });
    state = applyOp(state, listOps.patchTask('a1', { description: 'd' }), ctx);
    expect(state.tasks.a1?.description).toBe('d');
    expect(state.tasks.a1?.dueDate).toBe('2026-10-11');
    const same = fixture();
    expect(applyOp(same, listOps.patchTask('nope', { title: 'x' }), ctx)).toBe(same);
  });

  it('completes and uncompletes, keeping the placement', () => {
    const state = applyOp(fixture(), listOps.completeTask('a2', true), ctx);
    expect(state.tasks.a2?.completedAt).toBe(1_000);
    expect(ids(state, 'today')).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(applyOp(state, listOps.completeTask('a2', true), { ...ctx, now: 2 })).toBe(state);
    expect(applyOp(state, listOps.completeTask('a2', false), ctx).tasks.a2?.completedAt).toBeNull();
  });

  it('soft-deletes and restores to the exact position', () => {
    const base = fixture();
    const deleted = applyOp(base, listOps.deleteTask('a2'), ctx);
    expect(ids(deleted, 'today')).toEqual(['a1', 'a3', 'a4']);
    expect(deleted.deletedTasks.a2?.task.id).toBe('a2');
    expect(applyOp(deleted, listOps.deleteTask('a2'), ctx)).toBe(deleted);
    const restored = applyOp(deleted, listOps.restoreTask('a2'), ctx);
    expect(snapshot(restored)).toEqual(snapshot(base));
    expect(applyOp(restored, listOps.restoreTask('a2'), ctx)).toBe(restored);
  });

  it('restores a task whose group is gone to the top of the Inbox (05 §4.1)', () => {
    let state = applyOp(fixture(), listOps.deleteTask('p1'), ctx);
    state = applyOp(state, listOps.deleteGroup('prio', { moveTasksTo: 'today' }), ctx);
    // ADR 0005 §4: soft-deleted placements stay with the deleted group.
    expect(state.deletedTasks.p1?.task.placement?.groupId).toBe('prio');
    expect(ids(applyOp(state, listOps.restoreTask('p1'), ctx), 'inbox')).toEqual(['p1', 'i1']);
    const gone = {
      ...state,
      deletedTasks: {
        p1: {
          task: task('p1', 'vanished', 'a0'),
        },
      },
    };
    const restored = applyOp(gone, listOps.restoreTask('p1'), ctx);
    expect(ids(restored, 'inbox')).toEqual(['p1', 'i1']);
    const noInbox = { ...gone, groups: { today: gone.groups.today as Group } };
    expect(applyOp(noInbox, listOps.restoreTask('p1'), ctx).tasks.p1?.placement?.groupId).toBe(
      'vanished',
    );
  });

  it('moves within and between groups', () => {
    let state = applyOp(
      fixture(),
      listOps.moveTask('a4', { groupId: 'today', afterId: null, beforeId: 'a1' }),
      ctx,
    );
    expect(ids(state, 'today')).toEqual(['a4', 'a1', 'a2', 'a3']);
    state = applyOp(
      state,
      listOps.moveTask('a1', { groupId: 'prio', afterId: 'p1', beforeId: 'p2' }),
      ctx,
    );
    expect(ids(state, 'prio')).toEqual(['p1', 'a1', 'p2']);
    state = applyOp(state, listOps.moveTask('a2', { groupId: 'upcoming' }), ctx);
    expect(ids(state, 'upcoming')).toEqual(['a2']);
    expect(applyOp(state, listOps.moveTask('a3', { groupId: 'nope' }), ctx)).toBe(state);
    expect(applyOp(state, listOps.moveTask('nope', { groupId: 'today' }), ctx)).toBe(state);
  });
});

describe('bulk reducers', () => {
  const bulk = (payload: Parameters<typeof listOps.bulk>[1]) => listOps.bulk(ORG, payload);

  it('completes, uncompletes, deletes and restores many', () => {
    let state = applyOp(fixture(), bulk({ op: 'complete', ids: ['a1', 'p1', 'nope'] }), ctx);
    expect([state.tasks.a1?.completedAt, state.tasks.p1?.completedAt]).toEqual([1_000, 1_000]);
    state = applyOp(state, bulk({ op: 'uncomplete', ids: ['a1'] }), ctx);
    expect(state.tasks.a1?.completedAt).toBeNull();
    state = applyOp(state, bulk({ op: 'delete', ids: ['a1', 'a2'] }), ctx);
    expect(ids(state, 'today')).toEqual(['a3', 'a4']);
    state = applyOp(state, bulk({ op: 'restore', ids: ['a1', 'a2'] }), ctx);
    expect(ids(state, 'today')).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('moves many consecutively in the given order', () => {
    const state = applyOp(
      fixture(),
      bulk({
        op: 'move',
        ids: ['a3', 'a1'],
        args: { groupId: 'prio', afterId: 'p1', beforeId: 'p2' },
      }),
      ctx,
    );
    expect(ids(state, 'prio')).toEqual(['p1', 'a3', 'a1', 'p2']);
    expect(ids(state, 'today')).toEqual(['a2', 'a4']);
  });

  it('sets the due unit on many', () => {
    const state = applyOp(
      fixture(),
      bulk({ op: 'setDue', ids: ['a1', 'a2'], args: { dueDate: '2026-10-12' } }),
      ctx,
    );
    expect([state.tasks.a1?.dueDate, state.tasks.a2?.dueDate]).toEqual([
      '2026-10-12',
      '2026-10-12',
    ]);
  });
});

describe('group reducers', () => {
  it('creates a group at an intent', () => {
    const state = applyOp(
      fixture(),
      listOps.createGroup({ id: 'g', name: 'Later', afterId: 'today', beforeId: 'prio' }),
      ctx,
    );
    expect(normalGroups(state).map((g) => g.id)).toEqual(['today', 'g', 'prio', 'upcoming']);
    expect(state.groups.g).toMatchObject({ kind: 'normal', name: 'Later', collapsed: false });
    const again = applyOp(state, listOps.createGroup({ id: 'g', name: 'x' }), ctx);
    expect(again).toBe(state);
    const empty = applyOp(emptyListState(ORG), listOps.createGroup({ id: 'g', name: 'x' }), ctx);
    expect(normalGroups(empty)).toHaveLength(1);
  });

  it('splits a group after a task (Tab+N), keeping the order', () => {
    const state = applyOp(
      fixture(),
      listOps.createGroup({ id: 'g', name: 'Split', splitAfterTaskId: 'a2' }),
      ctx,
    );
    expect(normalGroups(state).map((g) => g.id)).toEqual(['today', 'g', 'prio', 'upcoming']);
    expect(ids(state, 'today')).toEqual(['a1', 'a2']);
    expect(ids(state, 'g')).toEqual(['a3', 'a4']);
  });

  it('splits after an Inbox task into a group at the top', () => {
    const base = applyOp(
      fixture(),
      listOps.createTask({ id: 'i2', title: 'x', groupId: 'inbox' }),
      ctx,
    );
    const state = applyOp(
      base,
      listOps.createGroup({ id: 'g', name: 'S', splitAfterTaskId: 'i1' }),
      ctx,
    );
    expect(normalGroups(state).map((g) => g.id)).toEqual(['g', 'today', 'prio', 'upcoming']);
    expect(ids(state, 'g')).toEqual(['i2']);
  });

  it('renames, collapses and moves groups, never the Inbox', () => {
    let state = applyOp(fixture(), listOps.patchGroup('prio', { name: 'P', collapsed: true }), ctx);
    expect(state.groups.prio).toMatchObject({ name: 'P', collapsed: true });
    state = applyOp(state, listOps.patchGroup('prio', { collapsed: false }), ctx);
    expect(state.groups.prio).toMatchObject({ name: 'P', collapsed: false });
    expect(applyOp(state, listOps.patchGroup('inbox', { name: 'x' }), ctx)).toBe(state);
    // ADR 0005 §6: the Inbox collapses, but keeps its name.
    const inboxCollapsed = applyOp(
      state,
      listOps.patchGroup('inbox', { name: 'x', collapsed: true }),
      ctx,
    );
    expect(inboxCollapsed.groups.inbox).toMatchObject({ name: 'Inbox', collapsed: true });
    expect(applyOp(state, listOps.patchGroup('nope', { name: 'x' }), ctx)).toBe(state);
    state = applyOp(
      state,
      listOps.moveGroup('upcoming', { afterId: null, beforeId: 'today' }),
      ctx,
    );
    expect(normalGroups(state).map((g) => g.id)).toEqual(['upcoming', 'today', 'prio']);
    expect(applyOp(state, listOps.moveGroup('inbox', {}), ctx)).toBe(state);
    expect(applyOp(state, listOps.moveGroup('nope', {}), ctx)).toBe(state);
  });

  it('deletes a group moving its tasks to the end of another', () => {
    const state = applyOp(fixture(), listOps.deleteGroup('today', { moveTasksTo: 'prio' }), ctx);
    expect(ids(state, 'prio')).toEqual(['p1', 'p2', 'a1', 'a2', 'a3', 'a4']);
    expect(state.groups.today).toBeUndefined();
    expect(state.deletedGroups.today?.name).toBe('Today');
  });

  it('deletes a group with its tasks and restores both', () => {
    const base = fixture();
    const state = applyOp(base, listOps.deleteGroup('prio', { deleteTasks: true }), ctx);
    expect(state.tasks.p1).toBeUndefined();
    expect(state.deletedTasks.p1?.withGroupId).toBe('prio');
    const restored = applyOp(state, listOps.restoreGroup('prio'), ctx);
    expect(snapshot(restored)).toEqual(snapshot(base));
    expect(applyOp(restored, listOps.restoreGroup('prio'), ctx)).toBe(restored);
  });

  it('moves completed leftovers to the end of the Inbox when deleted without options', () => {
    const base = applyOp(fixture(), listOps.completeTask('p1', true), ctx);
    const done = applyOp(base, listOps.deleteTask('p2'), ctx);
    const state = applyOp(done, listOps.deleteGroup('prio'), ctx);
    expect(ids(state, 'inbox')).toEqual(['i1', 'p1']);
    expectUndoable(done, listOps.deleteGroup('prio'));
  });

  it('deletes an empty group; never the Inbox', () => {
    const base = fixture();
    const state = applyOp(base, listOps.deleteGroup('upcoming'), ctx);
    expect(state.groups.upcoming).toBeUndefined();
    expect(applyOp(state, listOps.deleteGroup('inbox'), ctx)).toBe(state);
    expect(applyOp(state, listOps.deleteGroup('nope'), ctx)).toBe(state);
    // An unknown move target only deletes the group.
    const odd = applyOp(base, listOps.deleteGroup('prio', { moveTasksTo: 'nope' }), ctx);
    expect(odd.groups.prio).toBeUndefined();
  });
});

describe('inverseOf', () => {
  it('undoes creates, patches, completions, deletes and restores', () => {
    const base = fixture();
    expectUndoable(base, listOps.createTask({ id: 'n', title: 'x', groupId: 'today' }));
    expectUndoable(base, listOps.patchTask('a1', { title: 'Renamed' }));
    expectUndoable(base, listOps.patchTask('a1', { dueDate: '2026-10-10' }));
    expectUndoable(base, listOps.completeTask('a2', true));
    expectUndoable(base, listOps.deleteTask('a3'));
    const deleted = applyOp(base, listOps.deleteTask('a3'), ctx);
    expectUndoable(deleted, listOps.restoreTask('a3'));
    const withDesc = applyOp(base, listOps.patchTask('a1', { description: 'x' }), ctx);
    expect(inverseOf(listOps.patchTask('a1', { description: 'y' }), withDesc, ctx)).toEqual([
      listOps.patchTask('a1', { description: 'x' }),
    ]);
    expect(inverseOf(listOps.patchTask('a1', { description: 'y' }), base, ctx)).toEqual([
      listOps.patchTask('a1', { description: '' }),
    ]);
  });

  it('returns nothing for ops that changed nothing', () => {
    const base = fixture();
    expect(
      inverseOf(listOps.createTask({ id: 'a1', title: 'x', groupId: 'today' }), base, ctx),
    ).toEqual([]);
    expect(inverseOf(listOps.patchTask('a1', { title: 'A1' }), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.patchTask('nope', { title: 'x' }), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.patchTask('a1', { dueDate: null }), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.completeTask('a1', false), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.completeTask('nope', true), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.deleteTask('nope'), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.restoreTask('a1'), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.createGroup({ id: 'today', name: 'x' }), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.patchGroup('inbox', { name: 'x' }), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.patchGroup('nope', { name: 'x' }), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.patchGroup('inbox', { collapsed: true }), base, ctx)).toEqual([
      listOps.patchGroup('inbox', { collapsed: false }),
    ]);
    expect(inverseOf(listOps.patchGroup('prio', { name: 'Prio' }), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.moveGroup('inbox', {}), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.deleteGroup('inbox'), base, ctx)).toEqual([]);
    expect(inverseOf(listOps.restoreGroup('prio'), base, ctx)).toEqual([]);
  });

  it('undoes moves to the exact original position, even at a group edge', () => {
    const base = fixture();
    expectUndoable(
      base,
      listOps.moveTask('a1', { groupId: 'prio', afterId: 'p1', beforeId: 'p2' }),
    );
    expectUndoable(
      base,
      listOps.moveTask('a4', { groupId: 'today', afterId: null, beforeId: 'a1' }),
    );
    expectUndoable(base, listOps.moveTask('p2', { groupId: 'upcoming' }));
  });

  it('undoes bulk ops', () => {
    const base = fixture();
    const bulk = (payload: Parameters<typeof listOps.bulk>[1]) => listOps.bulk(ORG, payload);
    expectUndoable(base, bulk({ op: 'complete', ids: ['a1', 'a2'] }));
    const done = applyOp(base, bulk({ op: 'complete', ids: ['a1'] }), ctx);
    expectUndoable(done, bulk({ op: 'uncomplete', ids: ['a1', 'a2'] }));
    expectUndoable(base, bulk({ op: 'delete', ids: ['a1', 'p2'] }));
    const gone = applyOp(base, bulk({ op: 'delete', ids: ['a1', 'p2'] }), ctx);
    expectUndoable(gone, bulk({ op: 'restore', ids: ['a1', 'p2'] }));
    // Non-adjacent tasks from two groups, moved together to the top of a third.
    const { inverse } = expectUndoable(
      base,
      bulk({ op: 'move', ids: ['a1', 'a3', 'p2'], args: { groupId: 'upcoming' } }),
    );
    expect(inverse.every((op) => op.kind === 'task.move')).toBe(true);
    expectUndoable(
      base,
      bulk({
        op: 'move',
        ids: ['a2', 'a3'],
        args: { groupId: 'today', afterId: 'a4', beforeId: null },
      }),
    );
    const dated = applyOp(base, listOps.patchTask('a1', { dueDate: '2026-10-01' }), ctx);
    const { inverse: dueInverse } = expectUndoable(
      dated,
      bulk({ op: 'setDue', ids: ['a1', 'a2', 'a3'], args: { dueDate: '2026-12-24' } }),
    );
    expect(dueInverse).toHaveLength(2);
    expect(inverseOf(bulk({ op: 'complete', ids: ['nope'] }), base, ctx)).toEqual([]);
  });

  it('undoes group creation, including a split (one entry)', () => {
    const base = fixture();
    expectUndoable(
      base,
      listOps.createGroup({ id: 'g', name: 'G', afterId: 'today', beforeId: 'prio' }),
    );
    const { inverse } = expectUndoable(
      base,
      listOps.createGroup({ id: 'g', name: 'G', splitAfterTaskId: 'a2' }),
    );
    expect(inverse).toEqual([listOps.deleteGroup('g', { moveTasksTo: 'today' })]);
    // Splitting after the last task creates an empty group; its inverse needs no target.
    expect(
      inverseOf(listOps.createGroup({ id: 'g', name: 'G', splitAfterTaskId: 'a4' }), base, ctx),
    ).toEqual([listOps.deleteGroup('g', {})]);
  });

  it('undoes renames, collapses and group moves', () => {
    const base = fixture();
    expectUndoable(base, listOps.patchGroup('prio', { name: 'P' }));
    expectUndoable(base, listOps.patchGroup('prio', { collapsed: true }));
    expectUndoable(base, listOps.moveGroup('upcoming', { afterId: null, beforeId: 'today' }));
    expectUndoable(base, listOps.moveGroup('today', { afterId: 'upcoming', beforeId: null }));
  });

  it('undoes group deletes of every kind, and restores', () => {
    const base = fixture();
    const { inverse } = expectUndoable(base, listOps.deleteGroup('today', { moveTasksTo: 'prio' }));
    expect(inverse[0]).toEqual(listOps.restoreGroup('today'));
    expectUndoable(base, listOps.deleteGroup('prio', { deleteTasks: true }));
    expectUndoable(base, listOps.deleteGroup('upcoming'));
    const gone = applyOp(base, listOps.deleteGroup('prio', { deleteTasks: true }), ctx);
    expect(inverseOf(listOps.restoreGroup('prio'), gone, ctx)).toEqual([
      listOps.deleteGroup('prio', { deleteTasks: true }),
    ]);
    const empty = applyOp(base, listOps.deleteGroup('upcoming'), ctx);
    expectUndoable(empty, listOps.restoreGroup('upcoming'));
  });

  it('chunks bulk inverses at BULK_MAX', () => {
    let state = fixture();
    const many = Array.from({ length: 205 }, (_, i) => `m${String(i).padStart(3, '0')}`);
    for (const id of many) {
      state = applyOp(state, listOps.createTask({ id, title: id, groupId: 'upcoming' }), ctx);
    }
    const inverse = inverseOf(listOps.deleteGroup('upcoming', { moveTasksTo: 'prio' }), state, ctx);
    expect(inverse).toHaveLength(3);
    expect(inverse[2]).toMatchObject({ payload: { args: { afterId: many[199] } } });
    const after = applyOp(state, listOps.deleteGroup('upcoming', { moveTasksTo: 'prio' }), ctx);
    expect(snapshot(applyOps(after, inverse, ctx))).toEqual(snapshot(state));
  });

  it('inverts a sequence in reverse order (colon-to-group on an existing task)', () => {
    const base = fixture();
    const ops = [
      listOps.createGroup({ id: 'g', name: 'Prio 2', splitAfterTaskId: 'a2' }),
      listOps.deleteTask('a2'),
    ];
    const after = applyOps(base, ops, ctx);
    expect(ids(after, 'today')).toEqual(['a1']);
    const inverse = inverseOfSequence(ops, base, ctx);
    expect(inverse.map((o) => o.kind)).toEqual(['task.restore', 'group.delete']);
    expect(snapshot(applyOps(after, inverse, ctx))).toEqual(snapshot(base));
  });

  it('restorePlacements ignores tasks that did not move', () => {
    const base = fixture();
    expect(restorePlacements(base, base, ['a1', 'nope'], ctx)).toEqual([]);
  });
});

describe('mergeResponse', () => {
  const base = fixture();

  it('replaces optimistic tasks with server DTOs', () => {
    const op = listOps.createTask({ id: 'n', title: 'x', groupId: 'today' });
    const optimistic = applyOp(base, op, ctx);
    const server = task('n', 'today', 'zz', { seq: 42, title: 'x' });
    const { state, refetch } = mergeResponse(optimistic, op, server);
    expect(state.tasks.n?.seq).toBe(42);
    expect(refetch).toBe(false);
    // A task deleted locally meanwhile is not resurrected.
    expect(mergeResponse(base, op, server).state.tasks.n).toBeUndefined();
    expect(mergeResponse(optimistic, op, undefined).state).toBe(optimistic);
  });

  it('merges patch, completion and move results', () => {
    const patch = listOps.patchTask('a1', { title: 'y' });
    const patched = mergeResponse(base, patch, {
      task: task('a1', 'today', 'b', { title: 'y' }),
      ignoredFields: ['title'],
    });
    expect(patched.state.tasks.a1?.title).toBe('y');
    expect(patched.refetch).toBe(true);
    expect(mergeResponse(base, patch, {}).state).toBe(base);

    const complete = listOps.completeTask('a1', true);
    const next = task('r', 'today', 'b1');
    const completed = mergeResponse(base, complete, {
      task: task('a1', 'today', 'b', { completedAt: 7 }),
      next,
    });
    expect(completed.state.tasks.a1?.completedAt).toBe(7);
    expect(completed.state.tasks.r).toEqual(next);
    expect(mergeResponse(base, complete, null).state).toBe(base);

    const move = listOps.moveTask('a1', { groupId: 'prio' });
    const moved = mergeResponse(base, move, { placement: { groupId: 'prio', position: 'q' } });
    expect(moved.state.tasks.a1?.placement).toEqual({ groupId: 'prio', position: 'q' });
    expect(
      mergeResponse(base, listOps.moveTask('nope', { groupId: 'prio' }), {
        placement: { groupId: 'prio', position: 'q' },
      }).state,
    ).toBe(base);
    expect(mergeResponse(base, move, { placement: 3 }).state).toBe(base);
    const restore = listOps.restoreTask('a1');
    expect(
      mergeResponse(base, restore, task('a1', 'today', 'c')).state.tasks.a1?.placement?.position,
    ).toBe('c');
  });

  it('asks for a refetch after bulk moves and partial bulk failures', () => {
    const move = listOps.bulk(ORG, { op: 'move', ids: ['a1'], args: { groupId: 'prio' } });
    expect(mergeResponse(base, move, { results: [{ id: 'a1', ok: true }] }).refetch).toBe(true);
    const done = listOps.bulk(ORG, { op: 'complete', ids: ['a1', 'a2'] });
    expect(mergeResponse(base, done, { results: [{ id: 'a1', ok: true }] }).refetch).toBe(false);
    expect(
      mergeResponse(base, done, { results: [{ id: 'a1', ok: false, code: 'not_found' }] }).refetch,
    ).toBe(true);
    expect(mergeResponse(base, done, undefined).refetch).toBe(false);
  });

  it('merges group results', () => {
    const create = listOps.createGroup({ id: 'g', name: 'G', splitAfterTaskId: 'a2' });
    const optimistic = applyOp(base, create, ctx);
    const { state } = mergeResponse(optimistic, create, {
      group: { ...group('g', 'G', 'a05'), collapsed: false },
      moved: [
        { taskId: 'a3', groupId: 'g', position: 'k1' },
        { taskId: 'gone', groupId: 'g', position: 'k2' },
      ],
    });
    expect(state.groups.g?.position).toBe('a05');
    expect(state.tasks.a3?.placement?.position).toBe('k1');
    expect(mergeResponse(optimistic, create, {}).state).toBe(optimistic);
    const noMoved = mergeResponse(optimistic, create, { group: group('g', 'G', 'a06') });
    expect(noMoved.state.groups.g?.position).toBe('a06');

    const patch = listOps.patchGroup('prio', { name: 'P' });
    expect(mergeResponse(base, patch, group('prio', 'P', 'a1')).state.groups.prio?.name).toBe('P');
    expect(mergeResponse(base, patch, undefined).state).toBe(base);
    expect(
      mergeResponse(base, listOps.patchGroup('nope', { name: 'P' }), group('nope', 'P', 'a1'))
        .state,
    ).toBe(base);

    const move = listOps.moveGroup('prio', {});
    expect(mergeResponse(base, move, { position: 'zz' }).state.groups.prio?.position).toBe('zz');
    expect(mergeResponse(base, move, {}).state).toBe(base);
    expect(mergeResponse(base, listOps.deleteGroup('prio'), undefined)).toEqual({
      state: base,
      refetch: false,
    });
    expect(mergeResponse(base, listOps.deleteTask('a1'), undefined).refetch).toBe(false);
    expect(mergeResponse(base, listOps.restoreGroup('prio'), undefined).refetch).toBe(true);
    expect(
      mergeResponse(base, listOps.restoreGroup('prio'), group('prio', 'P', 'a1')).refetch,
    ).toBe(false);
  });
});
