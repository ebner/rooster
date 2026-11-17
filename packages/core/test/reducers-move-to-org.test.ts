import { describe, expect, it } from 'vitest';
import { applyOpToTaskList, mergeTaskListResponse } from '../src/everyone.ts';
import { generateNKeysBetween } from '../src/ordering.ts';
import {
  type ApplyContext,
  applyOp,
  applyOps,
  applyOpToDetail,
  detailState,
  inverseOf,
  inverseOfSequence,
  type ListOpSpec,
  type ListState,
  listOps,
  mergeDetailResponse,
  mergeResponse,
  movedSet,
  normalizeMyList,
  opEntityIds,
  tasksInGroup,
} from '../src/reducers.ts';
import type { Group, MyList, Task, TaskDetail, TaskMoveToOrgResult } from '../src/schemas/list.ts';

/** ADR 0072: the `task.moveToOrg` list op in the reducers. */

const SRC = 'org-src';
const DST = 'org-dst';
const ME = 'user-1';
const OTHER = 'user-2';
const ctx: ApplyContext = { userId: ME, now: 1_000 };

function group(id: string, position: string, kind: Group['kind'] = 'normal'): Group {
  return { id, orgId: SRC, kind, name: id, position, collapsed: false };
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    orgId: SRC,
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

const [k1, k2, k3, k4] = generateNKeysBetween(null, null, 4) as [string, string, string, string];
const counts = (subtasks: number, subtasksDone = 0) => ({
  subtasks,
  subtasksDone,
  comments: 0,
  attachments: 0,
});
const at = (groupId: string, position: string) => ({ placement: { groupId, position } });

/**
 * Inbox: i1. Today: a, p (subtasks s1 (with s1a), s2 done, s3), b, c. Prio: q. Someone else's
 * task x (no row). In Trash: s1b, deleted with s1.
 */
function fixture(): ListState {
  const list: MyList = {
    groups: [group('inbox', 'a0', 'inbox'), group('today', 'a0'), group('prio', 'a1')],
    tasks: [
      task('i1', at('inbox', k1)),
      task('a', at('today', k1)),
      task('p', { ...at('today', k2), counts: counts(3, 1) }),
      task('b', at('today', k3)),
      task('c', at('today', k4)),
      task('q', at('prio', k1)),
      task('s1', { parentId: 'p', subtaskPosition: k1, counts: counts(1) }),
      task('s2', { parentId: 'p', subtaskPosition: k2, completedAt: 5 }),
      task('s3', { parentId: 'p', subtaskPosition: k3 }),
      task('s1a', { parentId: 's1', subtaskPosition: k1 }),
      task('x', { assigneeId: OTHER }),
    ],
    expandedTaskIds: ['p'],
    serverTime: 0,
  };
  const state = normalizeMyList(SRC, list);
  return {
    ...state,
    deletedTasks: {
      s1b: { task: task('s1b', { parentId: 's1', subtaskPosition: k2 }) },
      s1c: { task: task('s1c', { parentId: 's1b', subtaskPosition: k1 }), withTaskId: 's1b' },
      zz: { task: task('zz', at('prio', k2)) },
    },
  };
}

const move = (ids: string[], extra: { groupId?: string | null } = {}) =>
  listOps.moveTasksToOrg(SRC, { ids, orgId: DST, ...extra });

const ids = (state: ListState) => Object.keys(state.tasks).sort();
const order = (state: ListState, groupId: string) => tasksInGroup(state, groupId).map((t) => t.id);

/** Applies the inverse ops to the source state, as its queue sees them (moves back arrive). */
const undo = (after: ListState, inverse: readonly ListOpSpec[]) => applyOps(after, inverse, ctx);

describe('movedSet', () => {
  it('takes whole subtrees, Trash included; listed descendants travel with their ancestor', () => {
    const moved = movedSet(fixture(), ['s1a', 'p', 'gone', 'q', 'p']);
    expect(moved.roots.map((t) => t.id)).toEqual(['p', 'q']);
    expect([...moved.live].sort()).toEqual(['p', 'q', 's1', 's1a', 's2', 's3']);
    expect([...moved.deleted].sort()).toEqual(['s1b', 's1c']);
  });
});

describe('applyOp task.moveToOrg (ADR 0072 §20)', () => {
  it('the subtrees leave the source org, soft-deleted descendants too', () => {
    const before = fixture();
    const after = applyOp(before, move(['p']), ctx);
    expect(ids(after)).toEqual(['a', 'b', 'c', 'i1', 'q', 'x']);
    expect(Object.keys(after.deletedTasks)).toEqual(['zz']);
    expect(order(after, 'today')).toEqual(['a', 'b', 'c']);
    // Untouched tasks keep their identity (memoised rows).
    expect(after.tasks.a).toBe(before.tasks.a);
    expect(applyOp(after, move(['p']), ctx)).toBe(after);
  });

  it('a detached subtask leaves its parent, whose counters follow (§3)', () => {
    const after = applyOp(fixture(), move(['s2', 's1']), ctx);
    expect(ids(after)).toEqual(['a', 'b', 'c', 'i1', 'p', 'q', 's3', 'x']);
    expect(after.tasks.p?.counts).toEqual(counts(1, 0));
    expect(Object.keys(after.deletedTasks)).toEqual(['zz']);
  });

  it('changes nothing in the org the tasks go to without a restore', () => {
    const target = { ...fixture(), orgId: DST };
    expect(applyOp(target, move(['p']), ctx)).toBe(target);
    expect(applyOp(fixture(), move(['nope']), ctx)).toEqual(fixture());
  });

  it('lists every moved id as an entity of the op', () => {
    expect(opEntityIds(move(['p', 'q']))).toEqual(['p', 'q']);
    expect(move(['p']).entityId).toBe(SRC);
    expect('restore' in move(['p'])).toBe(false);
  });
});

describe('inverseOf task.moveToOrg', () => {
  it('moves each run of rows back between the neighbours that stayed, under the target org', () => {
    const before = fixture();
    const op = move(['c', 'q', 'p', 'i1']);
    const inverse = inverseOf(op, before, ctx);
    expect(inverse.map((o) => [o.kind, o.entityId])).toEqual([
      ['task.moveToOrg', DST],
      ['task.moveToOrg', DST],
      ['task.moveToOrg', DST],
      ['task.moveToOrg', DST],
    ]);
    const payloads = inverse.map((o) => (o.kind === 'task.moveToOrg' ? o.payload : null));
    expect(payloads).toEqual([
      { ids: ['i1'], orgId: SRC, groupId: 'inbox', afterId: null, beforeId: null },
      { ids: ['p'], orgId: SRC, groupId: 'today', afterId: 'a', beforeId: 'b' },
      { ids: ['c'], orgId: SRC, groupId: 'today', afterId: 'b', beforeId: null },
      { ids: ['q'], orgId: SRC, groupId: 'prio', afterId: null, beforeId: null },
    ]);
    // Adjacent rows go back in one op, in their order.
    const runs = inverseOf(move(['c', 'b', 'p']), before, ctx);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      payload: { ids: ['p', 'b', 'c'], afterId: 'a', beforeId: null },
    });
    const first = inverse[1];
    if (first?.kind !== 'task.moveToOrg') throw new Error('expected a move');
    expect(first.restore?.tasks.map((t) => t.id)).toEqual(['p', 's1', 's1a', 's2', 's3']);
    expect(first.restore?.deleted.map((e) => e.task.id)).toEqual(['s1b', 's1c']);
  });

  it('an exact round trip: the moves back restore the source state', () => {
    const before = fixture();
    const op = move(['b', 'p', 'q', 'c', 's1a']);
    const inverse = inverseOf(op, before, ctx);
    const after = applyOp(before, op, ctx);
    const back = undo(after, inverse);
    expect(back.tasks).toEqual(before.tasks);
    expect(back.deletedTasks).toEqual(before.deletedTasks);
    // A replay over a state that has the tasks again changes nothing.
    expect(undo(back, inverse)).toBe(back);
  });

  it('a detached subtask moves back, then under its parent at its old slot (§3)', () => {
    const before = fixture();
    const op = move(['s1']);
    const inverse = inverseOf(op, before, ctx);
    expect(inverse.map((o) => o.kind)).toEqual(['task.moveToOrg', 'task.patch', 'task.reorder']);
    expect(inverse[0]).toMatchObject({
      entityId: DST,
      payload: { ids: ['s1'], orgId: SRC, groupId: 'inbox' },
    });
    expect(inverse[0]?.kind === 'task.moveToOrg' && 'afterId' in inverse[0].payload).toBe(false);
    expect(inverse[1]).toEqual(listOps.patchTask('s1', { parentId: 'p' }));
    expect(inverse[2]).toEqual(listOps.reorderSubtask('s1', { afterId: null, beforeId: 's2' }));
    const back = undo(applyOp(before, op, ctx), inverse);
    expect(back.tasks).toEqual(before.tasks);
    expect(back.tasks.p?.counts).toEqual(counts(3, 1));
  });

  it("a subtask whose parent isn't in the list is re-parented without a reorder", () => {
    const before = {
      ...fixture(),
      tasks: { ...fixture().tasks, o1: task('o1', { parentId: 'nx' }) },
    };
    const inverse = inverseOf(move(['o1']), before, ctx);
    expect(inverse.map((o) => o.kind)).toEqual(['task.moveToOrg', 'task.patch']);
  });

  it("someone else's task goes back to the top of my Inbox (the assignee is not restored)", () => {
    const inverse = inverseOf(move(['x']), fixture(), ctx);
    expect(inverse).toHaveLength(1);
    expect(inverse[0]).toMatchObject({ payload: { ids: ['x'], groupId: 'inbox' } });
    const noInbox = { ...fixture(), groups: {} };
    expect(inverseOf(move(['x']), noInbox, ctx)[0]).toMatchObject({ payload: { groupId: null } });
  });

  it('chunks a long run by the bulk limit, each chunk after the previous one', () => {
    const many = Array.from({ length: 205 }, (_, i) => `m${String(i).padStart(3, '0')}`);
    const keys = generateNKeysBetween(null, null, many.length);
    const base = fixture();
    const tasks = { ...base.tasks };
    many.forEach((id, i) => {
      tasks[id] = task(id, at('prio', `b${keys[i]}`));
    });
    const before = { ...base, tasks };
    const inverse = inverseOf(move(many), before, ctx);
    expect(inverse).toHaveLength(2);
    expect(inverse[1]).toMatchObject({
      payload: { ids: many.slice(200), afterId: many[199], beforeId: null, groupId: 'prio' },
    });
  });

  it('has no inverse when nothing moves, or seen from the org the tasks arrive in', () => {
    expect(inverseOf(move(['nope']), fixture(), ctx)).toEqual([]);
    const target = { ...fixture(), orgId: DST };
    expect(inverseOf(move(['p']), target, ctx)).toEqual([]);
    expect(inverseOfSequence([move(['p'])], fixture(), ctx)).toHaveLength(1);
  });
});

describe('mergeResponse task.moveToOrg', () => {
  const response = (tasks: Task[]): TaskMoveToOrgResult => ({
    orgId: SRC,
    tasks,
    movedIds: tasks.map((t) => t.id),
  });

  it('the source org refetches', () => {
    const after = applyOp(fixture(), move(['p']), ctx);
    expect(mergeResponse(after, move(['p']), response([]))).toEqual({
      state: after,
      refetch: true,
    });
  });

  it("the org a move back arrives in takes the server's roots, then refetches", () => {
    const before = fixture();
    const op = move(['p']);
    const [back] = inverseOf(op, before, ctx) as [ListOpSpec];
    const arrived = applyOp(applyOp(before, op, ctx), back, ctx);
    const server = task('p', { ...at('today', 'a1V'), seq: 42, counts: counts(3, 1) });
    const merged = mergeResponse(arrived, back, response([server, { ...server, id: 'nope' }]));
    expect(merged.refetch).toBe(true);
    expect(merged.state.tasks.p).toEqual(server);
    expect(merged.state.tasks.nope).toBeUndefined();
    // Not a task, or another org's: ignored.
    const foreign = { ...server, orgId: DST };
    expect(mergeResponse(arrived, back, response([foreign])).state).toBe(arrived);
    expect(mergeResponse(arrived, back, undefined).state).toBe(arrived);
    expect(mergeResponse(arrived, back, { tasks: [{ id: 'p' }] }).state).toBe(arrived);
  });
});

describe('task details', () => {
  function detail(): TaskDetail {
    const state = fixture();
    return {
      ...(state.tasks.p as Task),
      description: '',
      subtasks: ['s1', 's2', 's3'].map((id) => state.tasks[id] as Task),
      parentChain: [],
      followers: [],
    };
  }

  it("a subtask that moves away leaves the parent's detail, and comes back with undo", () => {
    const op = move(['s3']);
    const moved = applyOpToDetail(detail(), op, ctx);
    expect(moved.subtasks.map((t) => t.id)).toEqual(['s1', 's2']);
    expect(moved.counts).toEqual(counts(2, 1));
    const [back] = inverseOf(op, detailState(detail()), ctx) as [ListOpSpec];
    const merged = mergeDetailResponse(moved, back, undefined, ctx);
    expect(merged.subtasks.map((t) => t.id)).toEqual(['s1', 's2', 's3']);
    expect(mergeDetailResponse(detail(), move(['q']), undefined, ctx)).toEqual(detail());
  });
});

describe("Everyone's tasks (applyOpToTaskList)", () => {
  const rows = () => [
    task('p', { counts: counts(2, 1) }),
    task('s1', { parentId: 'p', assigneeId: OTHER, completedAt: 3 }),
    task('s1x', { parentId: 's1' }),
    task('s2', { parentId: 'p', assigneeId: OTHER }),
    task('q'),
  ];

  it('moved rows leave with the rows below them; a detached parent loses them', () => {
    const next = applyOpToTaskList(rows(), move(['s1']), ctx);
    expect(next.map((t) => t.id)).toEqual(['p', 's2', 'q']);
    expect(next[0]?.counts).toEqual(counts(1, 0));
    expect(applyOpToTaskList(rows(), move(['p']), ctx).map((t) => t.id)).toEqual(['q']);
    const same = rows();
    expect(applyOpToTaskList(same, move(['nope']), ctx)).toBe(same);
  });

  it('a confirmation refetches', () => {
    const list = rows();
    expect(mergeTaskListResponse(list, move(['p']), {})).toEqual({ tasks: list, refetch: true });
  });
});
