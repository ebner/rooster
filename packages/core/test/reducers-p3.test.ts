import { describe, expect, it } from 'vitest';
import { generateNKeysBetween } from '../src/ordering.ts';
import {
  type ApplyContext,
  ancestorsOf,
  applyOp,
  applyOps,
  applyOpToDetail,
  childrenOf,
  depthOf,
  derivedTaskId,
  descendantIds,
  detailState,
  inverseOf,
  type ListOpSpec,
  type ListState,
  listOps,
  mergeDetailResponse,
  mergeResponse,
  normalizeMyList,
  subtreeHeight,
  tasksInGroup,
} from '../src/reducers.ts';
import type { Group, MyList, Task, TaskDetail } from '../src/schemas/list.ts';

const ORG = 'org-1';
const ME = 'user-1';
const OTHER = 'user-2';
const ctx: ApplyContext = { userId: ME, now: 1_000 };

function group(id: string, name: string, position: string, kind: Group['kind'] = 'normal'): Group {
  return { id, orgId: ORG, kind, name, position, collapsed: false };
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
const counts = (subtasks: number, subtasksDone = 0) => ({
  subtasks,
  subtasksDone,
  comments: 0,
  attachments: 0,
});

/**
 * Today: p (with subtasks s1, s2 (done), s3; s1 has s1a), q. Inbox: i1. Prio: an orphan subtask
 * o1 whose parent op (someone else's task) is only in the payload for the breadcrumb.
 */
function fixture(): ListState {
  const list: MyList = {
    groups: [
      group('inbox', 'Inbox', 'a0', 'inbox'),
      group('today', 'Today', 'a0'),
      group('prio', 'Prio', 'a1'),
    ],
    tasks: [
      task('i1', { placement: { groupId: 'inbox', position: k1 } }),
      task('p', { placement: { groupId: 'today', position: k1 }, counts: counts(3, 1) }),
      task('q', { placement: { groupId: 'today', position: k2 } }),
      task('s1', { parentId: 'p', subtaskPosition: k1, counts: counts(1) }),
      task('s2', { parentId: 'p', subtaskPosition: k2, completedAt: 5 }),
      task('s3', { parentId: 'p', subtaskPosition: k3, tagIds: ['t1'] }),
      task('s1a', { parentId: 's1', subtaskPosition: k1 }),
      task('op', { assigneeId: OTHER, counts: counts(1) }),
      task('o1', {
        parentId: 'op',
        subtaskPosition: k1,
        placement: { groupId: 'prio', position: k1 },
      }),
    ],
    expandedTaskIds: ['p'],
    serverTime: 5,
  };
  return normalizeMyList(ORG, list);
}

const kids = (state: ListState, id: string) => childrenOf(state, id).map((t) => t.id);
const countsOf = (state: ListState, id: string) => {
  const c = state.tasks[id]?.counts;
  return [c?.subtasks, c?.subtasksDone];
};

function undo(state: ListState, op: ListOpSpec) {
  const after = applyOp(state, op, ctx);
  const inverse = inverseOf(op, state, ctx);
  return { after, inverse, undone: applyOps(after, inverse, ctx) };
}

describe('subtask helpers', () => {
  it('walks children, descendants, ancestors and depth', () => {
    const state = fixture();
    expect(kids(state, 'p')).toEqual(['s1', 's2', 's3']);
    expect(descendantIds(state, 'p')).toEqual(['s1', 's2', 's3', 's1a']);
    expect(ancestorsOf(state, 's1a').map((t) => t.id)).toEqual(['s1', 'p']);
    expect(depthOf(state, 's1a')).toBe(2);
    expect(depthOf(state, 'p')).toBe(0);
    expect(subtreeHeight(state, 'p')).toBe(2);
    expect(subtreeHeight(state, 'q')).toBe(0);
  });

  it('stops at a missing ancestor and never loops', () => {
    const state = fixture();
    const looped = {
      ...state,
      tasks: { ...state.tasks, x: task('x', { parentId: 'y' }), y: task('y', { parentId: 'x' }) },
    };
    expect(ancestorsOf(looped, 'x').map((t) => t.id)).toEqual(['y']);
    expect(ancestorsOf(state, 'o1').map((t) => t.id)).toEqual(['op']);
    const orphan = { ...state, tasks: { ...state.tasks, z: task('z', { parentId: 'gone' }) } };
    expect(depthOf(orphan, 'z')).toBe(0);
  });
});

describe('subtask create (P3)', () => {
  it('creates a sibling after another subtask, assigned like the parent, without placement', () => {
    const state = fixture();
    const op = listOps.createTask({ id: 'n', title: 'New', parentId: 'p', afterId: 's1' });
    const after = applyOp(state, op, ctx);
    expect(kids(after, 'p')).toEqual(['s1', 'n', 's2', 's3']);
    expect(after.tasks.n).toMatchObject({ parentId: 'p', placement: null, assigneeId: ME });
    expect(countsOf(after, 'p')).toEqual([4, 1]);
    expect(tasksInGroup(after, 'today').map((t) => t.id)).toEqual(['p', 'q']);
    const { undone } = undo(state, op);
    expect(kids(undone, 'p')).toEqual(['s1', 's2', 's3']);
    expect(countsOf(undone, 'p')).toEqual([3, 1]);
  });

  it('appends without an intent, and inherits the assignee of a foreign parent', () => {
    const state = fixture();
    const after = applyOp(state, listOps.createTask({ id: 'n', title: 'N', parentId: 'op' }), ctx);
    expect(kids(after, 'op')).toEqual(['o1', 'n']);
    expect(after.tasks.n?.assigneeId).toBe(OTHER);
    const before = applyOp(
      state,
      listOps.createTask({
        id: 'm',
        title: 'M',
        parentId: 'p',
        beforeId: 's1',
        tagIds: ['t', 't'],
      }),
      ctx,
    );
    expect(kids(before, 'p')[0]).toBe('m');
    expect(before.tasks.m?.tagIds).toEqual(['t']);
  });

  it('ignores a missing parent and nesting deeper than five levels', () => {
    let state = fixture();
    expect(applyOp(state, listOps.createTask({ id: 'n', title: 'N', parentId: 'nope' }), ctx)).toBe(
      state,
    );
    let parent = 's1a';
    for (const id of ['d3', 'd4', 'd5']) {
      state = applyOp(state, listOps.createTask({ id, title: id, parentId: parent }), ctx);
      parent = id;
    }
    expect(depthOf(state, 'd5')).toBe(5);
    expect(applyOp(state, listOps.createTask({ id: 'd6', title: 'x', parentId: 'd5' }), ctx)).toBe(
      state,
    );
  });

  it('creates top-level tasks with tags and without a group in the Inbox', () => {
    const state = fixture();
    const after = applyOp(state, listOps.createTask({ id: 'n', title: 'N', tagIds: ['a'] }), ctx);
    expect(after.tasks.n?.placement?.groupId).toBe('inbox');
    expect(tasksInGroup(after, 'inbox')[0]?.id).toBe('n');
    expect(after.tasks.n?.tagIds).toEqual(['a']);
  });
});

describe('subtask counters', () => {
  it('follows completion of children, including bulk', () => {
    const state = fixture();
    const done = applyOp(state, listOps.completeTask('s1', true), ctx);
    expect(countsOf(done, 'p')).toEqual([3, 2]);
    const reopened = applyOp(done, listOps.completeTask('s2', false), ctx);
    expect(countsOf(reopened, 'p')).toEqual([3, 1]);
    const bulk = applyOp(state, listOps.bulk(ORG, { op: 'complete', ids: ['s1', 's3', 'p'] }), ctx);
    expect(countsOf(bulk, 'p')).toEqual([3, 3]);
    expect(bulk.tasks.p?.completedAt).toBe(1_000);
  });
});

describe('cascade delete and restore', () => {
  it('soft-deletes descendants with the task and restores them together', () => {
    const state = fixture();
    const op = listOps.deleteTask('p');
    const { after, inverse, undone } = undo(state, op);
    for (const id of ['p', 's1', 's2', 's3', 's1a']) expect(after.tasks[id]).toBeUndefined();
    expect(after.deletedTasks.s1a?.withTaskId).toBe('p');
    expect(inverse).toEqual([listOps.restoreTask('p')]);
    expect(kids(undone, 'p')).toEqual(['s1', 's2', 's3']);
    expect(kids(undone, 's1')).toEqual(['s1a']);
    expect(countsOf(undone, 'p')).toEqual([3, 1]);
  });

  it('decrements the parent and keeps an earlier separate delete deleted', () => {
    const state = fixture();
    const childGone = applyOp(state, listOps.deleteTask('s2'), ctx);
    expect(countsOf(childGone, 'p')).toEqual([2, 0]);
    const parentGone = applyOp(childGone, listOps.deleteTask('p'), ctx);
    const restored = applyOp(parentGone, listOps.restoreTask('p'), ctx);
    expect(kids(restored, 'p')).toEqual(['s1', 's3']);
    expect(restored.deletedTasks.s2).toBeDefined();
    const both = applyOp(restored, listOps.restoreTask('s2'), ctx);
    expect(countsOf(both, 'p')).toEqual([3, 1]);
  });

  it('promotes a subtask restored while its parent is still deleted (ADR 0007 §5)', () => {
    const state = fixture();
    const childGone = applyOp(state, listOps.deleteTask('s3'), ctx);
    const parentGone = applyOp(childGone, listOps.deleteTask('p'), ctx);
    const restored = applyOp(parentGone, listOps.restoreTask('s3'), ctx);
    expect(restored.tasks.s3).toMatchObject({ parentId: null, subtaskPosition: null });
    expect(tasksInGroup(restored, 'inbox')[0]?.id).toBe('s3');
  });

  it('treats listed descendants of a listed task as part of its cascade (bulk)', () => {
    const state = fixture();
    const op = listOps.bulk(ORG, { op: 'delete', ids: ['s1a', 'p'] });
    const after = applyOp(state, op, ctx);
    expect(after.deletedTasks.s1a?.withTaskId).toBe('p');
    expect(after.deletedTasks.p?.withTaskId).toBeUndefined();
    const undone = applyOps(after, inverseOf(op, state, ctx), ctx);
    expect(Object.keys(undone.tasks).sort()).toEqual(Object.keys(state.tasks).sort());
  });

  it('cascades through a group deleted with its tasks', () => {
    const state = fixture();
    const op = listOps.deleteGroup('today', { deleteTasks: true });
    const after = applyOp(state, op, ctx);
    expect(after.tasks.s1a).toBeUndefined();
    const undone = applyOps(after, inverseOf(op, state, ctx), ctx);
    expect(undone.tasks.s1a).toBeDefined();
    expect(kids(undone, 'p')).toEqual(['s1', 's2', 's3']);
  });
});

describe('re-parent (patch parentId)', () => {
  it('makes a top-level task a subtask, dropping its placement, and undoes to the same spot', () => {
    const state = fixture();
    const op = listOps.patchTask('q', { parentId: 'p' });
    const { after, inverse, undone } = undo(state, op);
    expect(kids(after, 'p')).toEqual(['s1', 's2', 's3', 'q']);
    expect(after.tasks.q?.placement).toBeNull();
    expect(countsOf(after, 'p')).toEqual([4, 1]);
    expect(inverse.map((o) => o.kind)).toEqual(['task.patch', 'task.move']);
    expect(undone.tasks.q?.parentId).toBeNull();
    expect(tasksInGroup(undone, 'today').map((t) => t.id)).toEqual(['p', 'q']);
    expect(countsOf(undone, 'p')).toEqual([3, 1]);
  });

  it('promotes a subtask to the top of the Inbox and restores its sibling slot on undo', () => {
    const state = fixture();
    const op = listOps.patchTask('s2', { parentId: null, title: 'Renamed' });
    const { after, undone } = undo(state, op);
    expect(after.tasks.s2?.placement?.groupId).toBe('inbox');
    expect(tasksInGroup(after, 'inbox')[0]?.id).toBe('s2');
    expect(countsOf(after, 'p')).toEqual([2, 0]);
    expect(kids(undone, 'p')).toEqual(['s1', 's2', 's3']);
    expect(undone.tasks.s2?.title).toBe('S2');
    expect(undone.tasks.s2?.placement).toBeNull();
    expect(countsOf(undone, 'p')).toEqual([3, 1]);
  });

  it('keeps an orphan placement and moves subtasks between parents', () => {
    const state = fixture();
    const promoted = applyOp(state, listOps.patchTask('o1', { parentId: null }), ctx);
    expect(promoted.tasks.o1?.placement).toEqual({ groupId: 'prio', position: k1 });
    const moved = applyOp(state, listOps.patchTask('s3', { parentId: 's1' }), ctx);
    expect(kids(moved, 's1')).toEqual(['s1a', 's3']);
    const toForeign = applyOp(state, listOps.patchTask('s3', { parentId: 'op' }), ctx);
    expect(toForeign.tasks.s3?.placement?.groupId).toBe('inbox');
  });

  it('leaves cycles, self-parenting, unknown parents and depth overflows to the server', () => {
    const state = fixture();
    for (const parentId of ['s1a', 'p', 'nope']) {
      const op = listOps.patchTask('p', { parentId });
      expect(applyOp(state, op, ctx)).toBe(state);
      expect(inverseOf(op, state, ctx)).toEqual([]);
    }
    expect(applyOp(state, listOps.patchTask('s1', { parentId: 'p' }), ctx)).toBe(state);
    let deep = state;
    let parent = 'q';
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      deep = applyOp(deep, listOps.createTask({ id, title: id, parentId: parent }), ctx);
      parent = id;
    }
    // p carries two levels below it: under d4 (depth 4) it would reach depth 7.
    expect(applyOp(deep, listOps.patchTask('p', { parentId: 'd4' }), ctx)).toBe(deep);
    expect(applyOp(deep, listOps.patchTask('missing', { parentId: 'd4' }), ctx)).toBe(deep);
  });
});

describe('subtask reorder', () => {
  it('reorders among siblings and undoes to the original slot', () => {
    const state = fixture();
    const op = listOps.reorderSubtask('s3', { afterId: null, beforeId: 's1' });
    const { after, undone } = undo(state, op);
    expect(kids(after, 'p')).toEqual(['s3', 's1', 's2']);
    expect(kids(undone, 'p')).toEqual(['s1', 's2', 's3']);
    const middle = undo(state, listOps.reorderSubtask('s1', { afterId: 's2' }));
    expect(kids(middle.after, 'p')).toEqual(['s2', 's1', 's3']);
    expect(kids(middle.undone, 'p')).toEqual(['s1', 's2', 's3']);
  });

  it('ignores top-level tasks, unknown tasks and no-op moves', () => {
    const state = fixture();
    expect(applyOp(state, listOps.reorderSubtask('q', { afterId: null }), ctx)).toBe(state);
    expect(applyOp(state, listOps.reorderSubtask('zz', { afterId: null }), ctx)).toBe(state);
    const same = listOps.reorderSubtask('s1', { afterId: 'nope' });
    const after = applyOp(state, listOps.reorderSubtask('s3', { afterId: 's2' }), ctx);
    expect(after).toBe(state);
    expect(inverseOf(same, fixture(), ctx).length).toBeLessThanOrEqual(1);
    expect(inverseOf(listOps.reorderSubtask('zz', {}), state, ctx)).toEqual([]);
  });

  it('merges the server key', () => {
    const state = fixture();
    const op = listOps.reorderSubtask('s1', { afterId: 's3' });
    const merged = mergeResponse(applyOp(state, op, ctx), op, { subtaskPosition: 'zz' });
    expect(merged.state.tasks.s1?.subtaskPosition).toBe('zz');
    expect(mergeResponse(state, op, undefined).state).toBe(state);
    expect(
      mergeResponse(state, listOps.reorderSubtask('nope', {}), { subtaskPosition: 'a' }).state,
    ).toBe(state);
  });
});

describe('duplicate', () => {
  it('copies a task with its subtasks directly after the original', () => {
    const state = applyOp(fixture(), listOps.completeTask('p', true), ctx);
    const copyId = '01900000-0000-7000-8000-00000000c0de';
    const op = listOps.duplicateTask('p', copyId);
    const { after, inverse, undone } = undo(state, op);
    expect(tasksInGroup(after, 'today').map((t) => t.id)).toEqual(['p', copyId, 'q']);
    const copy = after.tasks[copyId] as Task;
    expect(copy).toMatchObject({ title: 'P', completedAt: null, seq: null, parentId: null });
    expect(copy.counts.subtasks).toBe(3);
    const copiedKids = childrenOf(after, copyId);
    expect(copiedKids.map((t) => t.title)).toEqual(['S1', 'S2', 'S3']);
    expect(copiedKids[0]?.id).toBe(derivedTaskId(copyId, 0));
    expect(copiedKids[2]?.tagIds).toEqual(['t1']);
    expect(childrenOf(after, copiedKids[0]?.id as string).map((t) => t.title)).toEqual(['S1A']);
    // Replaying gives the same ids.
    expect(Object.keys(applyOp(state, op, ctx).tasks)).toEqual(Object.keys(after.tasks));
    expect(inverse).toEqual([listOps.deleteTask(copyId)]);
    expect(Object.keys(undone.tasks)).toEqual(Object.keys(state.tasks));
  });

  it('copies a subtask among its siblings, optionally without subtasks', () => {
    const state = fixture();
    const after = applyOp(state, listOps.duplicateTask('s1', 'c1', false), ctx);
    expect(kids(after, 'p')).toEqual(['s1', 'c1', 's2', 's3']);
    expect(after.tasks.c1?.counts.subtasks).toBe(0);
    expect(countsOf(after, 'p')).toEqual([4, 1]);
    expect(applyOp(after, listOps.duplicateTask('s1', 'c1'), ctx)).toBe(after);
    expect(applyOp(state, listOps.duplicateTask('nope', 'c2'), ctx)).toBe(state);
    expect(inverseOf(listOps.duplicateTask('nope', 'c2'), state, ctx)).toEqual([]);
    const orphanCopy = applyOp(state, listOps.duplicateTask('op', 'c3'), ctx);
    expect(orphanCopy.tasks.c3?.placement).toBeNull();
  });

  it('puts the server copy in and asks for a refetch', () => {
    const state = fixture();
    const op = listOps.duplicateTask('q', 'c1');
    const after = applyOp(state, op, ctx);
    const merged = mergeResponse(after, op, task('c1', { seq: 9, title: 'Q' }));
    expect(merged.refetch).toBe(true);
    expect(merged.state.tasks.c1?.seq).toBe(9);
    expect(mergeResponse(after, op, undefined).state).toBe(after);
  });
});

describe('expansion and single-task tags', () => {
  it('toggles expansion idempotently', () => {
    const state = fixture();
    const expand = listOps.setExpanded('s1', true);
    const after = applyOp(state, expand, ctx);
    expect(after.expandedTaskIds).toEqual(['p', 's1']);
    expect(applyOp(after, expand, ctx)).toBe(after);
    expect(inverseOf(expand, state, ctx)).toEqual([listOps.setExpanded('s1', false)]);
    expect(inverseOf(expand, after, ctx)).toEqual([]);
    expect(applyOp(after, listOps.setExpanded('p', false), ctx).expandedTaskIds).toEqual(['s1']);
    expect(mergeResponse(after, expand, undefined).state).toBe(after);
  });

  it('adds and removes a tag on one task, with inverses', () => {
    const state = fixture();
    const add = listOps.addTag('q', 't9');
    const { after, undone } = undo(state, add);
    expect(after.tasks.q?.tagIds).toEqual(['t9']);
    expect(undone.tasks.q?.tagIds).toEqual([]);
    expect(inverseOf(add, after, ctx)).toEqual([]);
    const remove = listOps.removeTag('s3', 't1');
    const removed = undo(state, remove);
    expect(removed.after.tasks.s3?.tagIds).toEqual([]);
    expect(removed.undone.tasks.s3?.tagIds).toEqual(['t1']);
    expect(inverseOf(listOps.removeTag('zz', 't1'), state, ctx)).toEqual([]);
    const merged = mergeResponse(after, add, task('q', { tagIds: ['t9', 'srv'] }));
    expect(merged.state.tasks.q?.tagIds).toEqual(['t9', 'srv']);
    expect(mergeResponse(after, add, undefined).state).toBe(after);
  });

  it('leaves the list alone for tag creation', () => {
    const state = fixture();
    const op = listOps.createTag({ id: 'tag', name: 'urgent' });
    expect(applyOp(state, op, ctx)).toBe(state);
    expect(inverseOf(op, state, ctx)).toEqual([]);
    expect(mergeResponse(state, op, {}).state).toBe(state);
  });
});

describe('task detail reducers', () => {
  const detail = (): TaskDetail => {
    const state = fixture();
    const p = state.tasks.p as Task;
    return {
      ...p,
      description: 'Notes',
      subtasks: childrenOf(state, 'p'),
      parentChain: [],
      followers: [],
    };
  };

  it('applies ops to the task and its direct subtasks', () => {
    const d = detail();
    expect(Object.keys(detailState(d).tasks)).toEqual(['p', 's1', 's2', 's3']);
    const created = applyOpToDetail(
      d,
      listOps.createTask({ id: 'n', title: 'N', parentId: 'p', afterId: 's1' }),
      ctx,
    );
    expect(created.subtasks.map((t) => t.id)).toEqual(['s1', 'n', 's2', 's3']);
    expect(created.counts.subtasks).toBe(4);
    const described = applyOpToDetail(d, listOps.patchTask('p', { description: 'New' }), ctx);
    expect(described.description).toBe('New');
    expect(described.hasDescription).toBe(true);
    const cleared = applyOpToDetail(described, listOps.patchTask('p', { description: '' }), ctx);
    expect(cleared).toMatchObject({ description: '', hasDescription: false });
    const untouched = applyOpToDetail(d, listOps.patchTask('q', { title: 'x' }), ctx);
    expect(untouched).toBe(d);
    const deleted = applyOpToDetail(d, listOps.deleteTask('p'), ctx);
    expect(deleted).toBe(d);
  });

  it('merges responses and keeps the description the server does not send', () => {
    const d = detail();
    const patch = listOps.patchTask('p', { description: 'Edited' });
    const merged = mergeDetailResponse(
      d,
      patch,
      { task: task('p', { title: 'Server', counts: counts(3, 1) }), ignoredFields: [] },
      ctx,
    );
    expect(merged.title).toBe('Server');
    expect(merged.description).toBe('Edited');
    const title = listOps.patchTask('p', { title: 'T' });
    expect(mergeDetailResponse(d, title, undefined, ctx).description).toBe('Notes');
    const sub = listOps.completeTask('s1', true);
    const done = mergeDetailResponse(
      d,
      sub,
      { task: task('s1', { parentId: 'p', subtaskPosition: k1, completedAt: 7 }) },
      ctx,
    );
    expect(done.subtasks[0]?.completedAt).toBe(7);
    expect(done.counts.subtasksDone).toBe(2);
    const other = listOps.patchTask('q', { title: 'x' });
    expect(mergeDetailResponse(d, other, undefined, ctx)).toBe(d);
    const groupOp = listOps.patchGroup('today', { collapsed: true });
    expect(mergeDetailResponse(d, groupOp, undefined, ctx)).toBe(d);
    const bulk = listOps.bulk(ORG, { op: 'complete', ids: ['s3'] });
    expect(mergeDetailResponse(d, bulk, { results: [] }, ctx).counts.subtasksDone).toBe(2);
    const child = listOps.createTask({ id: 'k', title: 'K', parentId: 'p' });
    expect(mergeDetailResponse(d, child, undefined, ctx).subtasks.at(-1)?.id).toBe('k');
    const top = listOps.createTask({ id: 'k2', title: 'K', groupId: 'today' });
    expect(mergeDetailResponse(d, top, undefined, ctx)).toBe(d);
  });
});
