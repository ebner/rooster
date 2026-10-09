import { describe, expect, it } from 'vitest';
import { generateNKeysBetween } from '../src/ordering.ts';
import {
  type ApplyContext,
  applyOp,
  applyOps,
  applyOpToDetail,
  inverseOf,
  inverseOfSequence,
  type ListOpSpec,
  type ListState,
  listOps,
  mergeDetailResponse,
  mergeResponse,
  normalizeMyList,
  opEntityIds,
  tasksInGroup,
} from '../src/reducers.ts';
import type { Group, MyList, Task, TaskDetail } from '../src/schemas/list.ts';

const ORG = 'org-1';
const ME = 'user-1';
const BOB = 'user-2';
const CAROL = 'user-3';
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

/**
 * Inbox: i1. Today: p (subtasks s1 mine, s2 Bob's), q, r. Prio: o1, an orphan of mine under
 * Bob's task bp (in the payload for the breadcrumb).
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
      task('p', { placement: { groupId: 'today', position: k1 } }),
      task('q', { placement: { groupId: 'today', position: k2 } }),
      task('r', { placement: { groupId: 'today', position: k3 } }),
      task('s1', { parentId: 'p', subtaskPosition: k1 }),
      task('s2', { parentId: 'p', subtaskPosition: k2, assigneeId: BOB }),
      task('bp', { assigneeId: BOB }),
      task('o1', {
        parentId: 'bp',
        subtaskPosition: k1,
        placement: { groupId: 'prio', position: k1 },
      }),
    ],
    expandedTaskIds: [],
    serverTime: 5,
  };
  return normalizeMyList(ORG, list);
}

const ids = (state: ListState, groupId: string) => tasksInGroup(state, groupId).map((t) => t.id);

function undo(state: ListState, op: ListOpSpec) {
  const after = applyOp(state, op, ctx);
  const inverse = inverseOf(op, state, ctx);
  return { after, inverse, undone: applyOps(after, inverse, ctx) };
}

describe('assignment (P6, 05 §4.1 seen from my list)', () => {
  it('assigning away from me removes the row and keeps the task without a placement', () => {
    const state = fixture();
    const next = applyOp(state, listOps.patchTask('q', { assigneeId: BOB }), ctx);
    expect(ids(next, 'today')).toEqual(['p', 'r']);
    expect(next.tasks.q).toMatchObject({ assigneeId: BOB, placement: null, updatedAt: 1_000 });
  });

  it('assigning to me puts the task at the top of my Inbox', () => {
    const state = fixture();
    const next = applyOp(state, listOps.patchTask('bp', { assigneeId: ME }), ctx);
    expect(ids(next, 'inbox')).toEqual(['bp', 'i1']);
    // AC-6.2: the orphan row of my subtask disappears; it now shows under its parent.
    expect(next.tasks.o1?.placement).toBeNull();
    expect(ids(next, 'prio')).toEqual([]);
  });

  it('AC-6.2: a subtask of my task assigned to Bob stays a subtask row under my parent', () => {
    const state = fixture();
    const next = applyOp(state, listOps.patchTask('s1', { assigneeId: BOB }), ctx);
    expect(next.tasks.s1).toMatchObject({ assigneeId: BOB, placement: null, parentId: 'p' });
    expect(ids(next, 'today')).toEqual(['p', 'q', 'r']);
  });

  it("AC-6.2 from Bob's side: his orphan row goes when the parent becomes his", () => {
    const bob: ApplyContext = { userId: BOB, now: 1_000 };
    const list: MyList = {
      groups: [group('binbox', 'Inbox', 'a0', 'inbox'), group('bwork', 'Work', 'a0')],
      tasks: [
        task('p', { assigneeId: ME }),
        task('s', {
          parentId: 'p',
          subtaskPosition: k1,
          assigneeId: BOB,
          placement: { groupId: 'bwork', position: k1 },
        }),
      ],
      expandedTaskIds: [],
      serverTime: 0,
    };
    const state = normalizeMyList(ORG, list);
    const next = applyOp(state, listOps.patchTask('p', { assigneeId: BOB }), bob);
    expect(tasksInGroup(next, 'binbox').map((t) => t.id)).toEqual(['p']);
    expect(next.tasks.s?.placement).toBeNull();
  });

  it('assigning my parent away makes my subtask an orphan row at the top of my Inbox', () => {
    const state = fixture();
    const next = applyOp(state, listOps.patchTask('p', { assigneeId: BOB }), ctx);
    expect(next.tasks.p?.placement).toBeNull();
    expect(ids(next, 'inbox')).toEqual(['s1', 'i1']);
    // Bob's subtask stays without a placement in my list.
    expect(next.tasks.s2?.placement).toBeNull();
  });

  it('unassigning removes the row; an unchanged assignee is a no-op', () => {
    const state = fixture();
    expect(applyOp(state, listOps.patchTask('q', { assigneeId: null }), ctx).tasks.q).toMatchObject(
      { assigneeId: null, placement: null },
    );
    expect(applyOp(state, listOps.patchTask('q', { assigneeId: ME }), ctx)).toBe(state);
    expect(applyOp(state, listOps.patchTask('missing', { assigneeId: BOB }), ctx)).toBe(state);
  });

  it('bulk assign reconciles every task', () => {
    const state = fixture();
    const op = listOps.bulk(ORG, { op: 'assign', ids: ['q', 'r', 'bp'], args: { assigneeId: ME } });
    const next = applyOp(state, op, ctx);
    expect(ids(next, 'today')).toEqual(['p', 'q', 'r']);
    expect(ids(next, 'inbox')).toEqual(['bp', 'i1']);
    const away = applyOp(
      state,
      listOps.bulk(ORG, { op: 'assign', ids: ['q', 'r'], args: { assigneeId: CAROL } }),
      ctx,
    );
    expect(ids(away, 'today')).toEqual(['p']);
  });

  it('undo of an assign restores the assignee and the exact placement', () => {
    const state = fixture();
    const { inverse, undone } = undo(state, listOps.patchTask('q', { assigneeId: BOB }));
    expect(inverse[0]).toEqual(listOps.patchTask('q', { assigneeId: ME }));
    expect(inverse.slice(1).map((op) => op.kind)).toEqual(['task.move']);
    expect(ids(undone, 'today')).toEqual(['p', 'q', 'r']);
    expect(undone.tasks.q?.assigneeId).toBe(ME);
  });

  it('undo of assigning my parent away puts the orphan subtask back under it', () => {
    const state = fixture();
    const { undone } = undo(state, listOps.patchTask('p', { assigneeId: BOB }));
    expect(ids(undone, 'today')).toEqual(['p', 'q', 'r']);
    expect(ids(undone, 'inbox')).toEqual(['i1']);
    expect(undone.tasks.s1?.placement).toBeNull();
  });

  it('undo of taking a task restores the orphan row of its subtask at its old spot', () => {
    const state = fixture();
    const { inverse, undone } = undo(state, listOps.patchTask('bp', { assigneeId: ME }));
    expect(inverse[0]).toEqual(listOps.patchTask('bp', { assigneeId: BOB }));
    expect(ids(undone, 'prio')).toEqual(['o1']);
    expect(undone.tasks.bp?.placement).toBeNull();
    expect(ids(undone, 'inbox')).toEqual(['i1']);
  });

  it('undo of an assign combined with a re-parent restores both', () => {
    const state = fixture();
    const op = listOps.patchTask('q', { assigneeId: BOB, parentId: 'p' });
    const { undone } = undo(state, op);
    expect(undone.tasks.q).toMatchObject({ assigneeId: ME, parentId: null });
    expect(ids(undone, 'today')).toEqual(['p', 'q', 'r']);
  });

  it('undo of a bulk assign groups by previous assignee and restores the rows', () => {
    const state = fixture();
    const op = listOps.bulk(ORG, {
      op: 'assign',
      ids: ['q', 'bp', 'r', 'missing'],
      args: { assigneeId: CAROL },
    });
    const { inverse, undone } = undo(state, op);
    const assigns = inverse.filter((o) => o.kind === 'task.bulk');
    expect(assigns.map((o) => o.kind === 'task.bulk' && o.payload)).toEqual([
      { op: 'assign', ids: ['q', 'r'], args: { assigneeId: ME } },
      { op: 'assign', ids: ['bp'], args: { assigneeId: BOB } },
    ]);
    expect(ids(undone, 'today')).toEqual(['p', 'q', 'r']);
    expect(ids(undone, 'prio')).toEqual(['o1']);
    expect(ids(undone, 'inbox')).toEqual(['i1']);
    expect(
      inverseOf(listOps.bulk(ORG, { ...op.payload, ids: ['zzz'] } as never), state, ctx),
    ).toEqual([]);
  });

  it('the server answer of an assignment is merged and asks for a refetch', () => {
    const state = applyOp(fixture(), listOps.patchTask('q', { assigneeId: BOB }), ctx);
    const op = listOps.patchTask('q', { assigneeId: BOB });
    const dto = task('q', { assigneeId: BOB, seq: 9 });
    const merged = mergeResponse(state, op, { task: dto, ignoredFields: [] });
    expect(merged.refetch).toBe(true);
    expect(merged.state.tasks.q?.seq).toBe(9);
    // A task taken from Everyone's tasks joins my list with the server's placement.
    const taken = listOps.patchTask('new', { assigneeId: ME });
    const placed = task('new', { placement: { groupId: 'inbox', position: 'Zz' } });
    const joined = mergeResponse(fixture(), taken, { task: placed, ignoredFields: [] });
    expect(joined.state.tasks.new?.placement).toEqual({ groupId: 'inbox', position: 'Zz' });
    const bulk = listOps.bulk(ORG, { op: 'assign', ids: ['q'], args: { assigneeId: BOB } });
    expect(mergeResponse(state, bulk, { results: [{ id: 'q', ok: true }] }).refetch).toBe(true);
  });
});

describe('create with an assignee (P6)', () => {
  it("someone else's or an unassigned task has no row", () => {
    const state = fixture();
    const bobs = applyOp(state, listOps.createTask({ id: 'n', title: 'N', assigneeId: BOB }), ctx);
    expect(bobs.tasks.n).toMatchObject({ assigneeId: BOB, placement: null, createdBy: ME });
    const none = applyOp(state, listOps.createTask({ id: 'n', title: 'N', assigneeId: null }), ctx);
    expect(none.tasks.n).toMatchObject({ assigneeId: null, placement: null });
    expect(ids(none, 'inbox')).toEqual(['i1']);
  });

  it('assigning myself explicitly behaves like the default', () => {
    const state = fixture();
    const next = applyOp(
      state,
      listOps.createTask({ id: 'n', title: 'N', assigneeId: ME, groupId: 'today' }),
      ctx,
    );
    expect(ids(next, 'today')).toEqual(['p', 'q', 'r', 'n']);
  });

  it('a subtask of mine under a parent of someone else is an orphan row', () => {
    const state = fixture();
    const mine = applyOp(
      state,
      listOps.createTask({ id: 'n', title: 'N', parentId: 'bp', assigneeId: ME }),
      ctx,
    );
    expect(ids(mine, 'inbox')).toEqual(['n', 'i1']);
    const bobs = applyOp(
      state,
      listOps.createTask({ id: 'n', title: 'N', parentId: 'p', assigneeId: BOB }),
      ctx,
    );
    expect(bobs.tasks.n).toMatchObject({ assigneeId: BOB, placement: null, parentId: 'p' });
    // Default: like the parent.
    const inherited = applyOp(
      state,
      listOps.createTask({ id: 'n', title: 'N', parentId: 'bp' }),
      ctx,
    );
    expect(inherited.tasks.n).toMatchObject({ assigneeId: BOB, placement: null });
  });
});

describe('comments and followers in the list and the detail (P6)', () => {
  it('counts comments on create, delete and restore', () => {
    const state = fixture();
    const created = applyOp(state, listOps.createComment('q', { id: 'c1', body: 'Hi' }), ctx);
    expect(created.tasks.q?.counts.comments).toBe(1);
    const deleted = applyOp(created, listOps.deleteComment('c1', 'q'), ctx);
    expect(deleted.tasks.q?.counts.comments).toBe(0);
    expect(applyOp(deleted, listOps.deleteComment('c1', 'q'), ctx).tasks.q?.counts.comments).toBe(
      0,
    );
    expect(applyOp(deleted, listOps.restoreComment('c1', 'q'), ctx).tasks.q?.counts.comments).toBe(
      1,
    );
    expect(applyOp(state, listOps.patchComment('c1', 'q', { body: 'x' }), ctx)).toBe(state);
    expect(applyOp(state, listOps.setFollowing('q', true), ctx)).toBe(state);
    expect(applyOp(state, listOps.createComment('zz', { id: 'c', body: 'x' }), ctx)).toBe(state);
  });

  it('comment inverses: create ↔ delete, delete ↔ restore; patch and follow have none', () => {
    const state = fixture();
    expect(inverseOf(listOps.createComment('q', { id: 'c1', body: 'x' }), state, ctx)).toEqual([
      listOps.deleteComment('c1', 'q'),
    ]);
    expect(inverseOf(listOps.deleteComment('c1', 'q'), state, ctx)).toEqual([
      listOps.restoreComment('c1', 'q'),
    ]);
    expect(inverseOf(listOps.restoreComment('c1', 'q'), state, ctx)).toEqual([
      listOps.deleteComment('c1', 'q'),
    ]);
    expect(inverseOf(listOps.patchComment('c1', 'q', { body: 'y' }), state, ctx)).toEqual([]);
    expect(inverseOf(listOps.setFollowing('q', true), state, ctx)).toEqual([]);
    expect(
      inverseOfSequence([listOps.createComment('q', { id: 'c1', body: 'x' })], state, ctx),
    ).toHaveLength(1);
  });

  it('comment and follow responses keep the list as it is', () => {
    const state = fixture();
    for (const op of [
      listOps.setFollowing('q', true),
      listOps.createComment('q', { id: 'c1', body: 'x' }),
      listOps.patchComment('c1', 'q', { body: 'y' }),
      listOps.deleteComment('c1', 'q'),
      listOps.restoreComment('c1', 'q'),
    ]) {
      expect(mergeResponse(state, op, {})).toEqual({ state, refetch: false });
    }
  });

  const detail = (extra: Partial<TaskDetail> = {}): TaskDetail => ({
    ...task('q'),
    description: '',
    subtasks: [],
    parentChain: [],
    followers: [BOB],
    ...extra,
  });

  it('follow and unfollow change the followers of the detail', () => {
    const d = detail();
    const followed = applyOpToDetail(d, listOps.setFollowing('q', true), ctx);
    expect(followed.followers).toEqual([BOB, ME]);
    expect(applyOpToDetail(followed, listOps.setFollowing('q', true), ctx)).toBe(followed);
    expect(applyOpToDetail(followed, listOps.setFollowing('q', false), ctx).followers).toEqual([
      BOB,
    ]);
    expect(applyOpToDetail(d, listOps.setFollowing('other', true), ctx)).toBe(d);
  });

  it("the server's follow state replaces the guess", () => {
    const d = detail();
    const op = listOps.setFollowing('q', true);
    expect(mergeDetailResponse(d, op, { followers: [ME, CAROL] }, ctx).followers).toEqual([
      ME,
      CAROL,
    ]);
    expect(mergeDetailResponse(d, op, undefined, ctx).followers).toEqual([BOB, ME]);
    expect(mergeDetailResponse(d, listOps.setFollowing('x', true), {}, ctx)).toBe(d);
  });

  it('comment counts follow into the detail, including confirmed deletes and restores', () => {
    const d = detail({ counts: { subtasks: 0, subtasksDone: 0, comments: 2, attachments: 0 } });
    const created = applyOpToDetail(d, listOps.createComment('q', { id: 'c', body: 'x' }), ctx);
    expect(created.counts.comments).toBe(3);
    expect(created.followers).toEqual([BOB]);
    const del = listOps.deleteComment('c', 'q');
    expect(mergeDetailResponse(d, del, undefined, ctx).counts.comments).toBe(1);
    const restore = listOps.restoreComment('c', 'q');
    expect(mergeDetailResponse(d, restore, {}, ctx).counts.comments).toBe(3);
    expect(mergeDetailResponse(d, listOps.deleteComment('c', 'other'), undefined, ctx)).toBe(d);
    expect(mergeDetailResponse(d, listOps.patchComment('c', 'q', { body: 'y' }), {}, ctx)).toBe(d);
  });

  it('an assignment in the detail changes the assignee', () => {
    const d = detail({ placement: { groupId: 'today', position: k2 } });
    const next = applyOpToDetail(d, listOps.patchTask('q', { assigneeId: BOB }), ctx);
    expect(next).toMatchObject({ assigneeId: BOB, placement: null, followers: [BOB] });
  });
});

describe('opEntityIds', () => {
  it('names every task and comment an op changes', () => {
    expect(opEntityIds(listOps.patchTask('a', { title: 'x' }))).toEqual(['a']);
    expect(opEntityIds(listOps.bulk(ORG, { op: 'complete', ids: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(opEntityIds(listOps.duplicateTask('a', 'b'))).toEqual(['a', 'b']);
    expect(opEntityIds(listOps.createComment('t', { id: 'c', body: 'x' }))).toEqual(['c', 't']);
    expect(opEntityIds(listOps.deleteComment('c', 't'))).toEqual(['c', 't']);
  });
});
