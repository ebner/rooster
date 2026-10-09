import { normalizeMyList } from '@rooster/core/reducers';
import type { Group, Task } from '@rooster/core/schemas';
import { describe, expect, test } from 'vitest';
import type { Draft } from '../../../state/list-store';
import { groupStepTarget, isNoopIntent, keyboardMoveTarget } from './moves';
import { buildRows, type GroupOrder, type RowCache, type RowOptions, visibleOrder } from './rows';
import {
  currentSlot,
  dropSlots,
  groupJump,
  indicatorSlot,
  isNoopSlot,
  slotIndicator,
  slotIntent,
} from './slots';

const org = 'org';
const group = (
  id: string,
  position: string,
  kind: Group['kind'] = 'normal',
  collapsed = false,
): Group => ({
  id,
  orgId: org,
  kind,
  name: id,
  position,
  collapsed,
});
const task = (id: string, groupId: string, position: string, done = false): Task => ({
  id,
  orgId: org,
  seq: 1,
  parentId: null,
  subtaskPosition: null,
  title: id,
  assigneeId: 'me',
  createdBy: 'me',
  dueDate: null,
  dueTime: null,
  dueTz: null,
  startDate: null,
  tagIds: [],
  completedAt: done ? 1 : null,
  hasDescription: false,
  counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
  placement: { groupId, position },
  createdAt: 0,
  updatedAt: 0,
});

function state(
  tasks: Task[],
  groups: Group[] = [group('inbox', 'a0', 'inbox'), group('g1', 'a0'), group('g2', 'a1')],
) {
  return normalizeMyList(org, { groups, tasks, expandedTaskIds: [], serverTime: 0 });
}

const options = (patch: Partial<RowOptions> = {}): RowOptions => ({
  drafts: [],
  showCompleted: false,
  hiding: {},
  dragCollapsed: false,
  hoverExpanded: {},
  draftTask: (d: Draft) => task(d.id, d.groupId, ''),
  ...patch,
});

const ids = (rows: ReturnType<typeof buildRows>) => rows.map((r) => r.id);

describe('buildRows', () => {
  test('headers, tasks, add rows and the add-group row; the empty Inbox is hidden', () => {
    const rows = buildRows(state([task('a', 'g1', 'a0'), task('b', 'g1', 'a1')]), options());
    expect(ids(rows)).toEqual(['group:g1', 'a', 'b', 'add:g1', 'group:g2', 'add:g2', 'add-group']);
    expect(rows[0]).toMatchObject({ kind: 'group', count: 2, first: true, collapsed: false });
  });

  test('the Inbox shows first only with open tasks', () => {
    const withOpen = buildRows(state([task('i', 'inbox', 'a0')]), options());
    expect(ids(withOpen).slice(0, 3)).toEqual(['group:inbox', 'i', 'add:inbox']);
    const onlyDone = buildRows(state([task('i', 'inbox', 'a0', true)]), options());
    expect(ids(onlyDone)[0]).toBe('group:g1');
  });

  test('completed tasks show with "show completed" or while hiding', () => {
    const s = state([task('a', 'g1', 'a0', true), task('b', 'g1', 'a1')]);
    expect(ids(buildRows(s, options()))).not.toContain('a');
    expect(ids(buildRows(s, options({ showCompleted: true })))).toContain('a');
    expect(ids(buildRows(s, options({ hiding: { a: 'hold' } })))).toContain('a');
    expect(buildRows(s, options())[0]).toMatchObject({ count: 1 });
  });

  test('drafts splice in after their row, at the top, or at the end', () => {
    const s = state([task('a', 'g1', 'a0'), task('b', 'g1', 'a1')]);
    const drafts: Draft[] = [
      { id: 'd1', groupId: 'g1', afterId: 'a' },
      { id: 'd2', groupId: 'g1', afterId: null },
      { id: 'd3', groupId: 'g1', afterId: 'gone' },
      { id: 'd4', groupId: 'g1', afterId: 'd1' },
    ];
    expect(ids(buildRows(s, options({ drafts }))).slice(0, 7)).toEqual([
      'group:g1',
      'd2',
      'a',
      'd1',
      'd4',
      'b',
      'd3',
    ]);
  });

  test('collapsed groups render only their header; drags collapse all, hover opens one', () => {
    const s = state(
      [task('a', 'g1', 'a0')],
      [group('g1', 'a0', 'normal', true), group('g2', 'a1')],
    );
    expect(ids(buildRows(s, options()))).toEqual(['group:g1', 'group:g2', 'add:g2', 'add-group']);
    expect(ids(buildRows(s, options({ hoverExpanded: { g1: true } })))).toContain('a');
    expect(
      ids(buildRows(s, options({ dragCollapsed: true, hoverExpanded: { g1: true } }))),
    ).toEqual(['group:g1', 'group:g2', 'add-group']);
  });

  test('first run: a hint row in the first group', () => {
    expect(ids(buildRows(state([]), options()))).toContain('hint:g1');
    expect(ids(buildRows(state([task('a', 'g2', 'a0')]), options()))).not.toContain('hint:g1');
  });

  test('unchanged rows keep their identity across builds', () => {
    const cache: RowCache = new Map();
    const s1 = state([task('a', 'g1', 'a0'), task('b', 'g1', 'a1')]);
    const first = buildRows(s1, options(), cache);
    const changed = { ...s1, tasks: { ...s1.tasks, b: { ...(s1.tasks.b as Task), title: 'B!' } } };
    const second = buildRows(changed, options(), cache);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
  });

  test('visibleOrder lists persisted tasks per group, without drafts', () => {
    const s = state([task('a', 'g1', 'a0')]);
    const order = visibleOrder(
      buildRows(s, options({ drafts: [{ id: 'd', groupId: 'g1', afterId: 'a' }] })),
    );
    expect(order).toEqual([
      { id: 'g1', collapsed: false, taskIds: ['a'] },
      { id: 'g2', collapsed: false, taskIds: [] },
    ]);
  });
});

const order: GroupOrder[] = [
  { id: 'g1', collapsed: false, taskIds: ['a', 'b', 'c'] },
  { id: 'gc', collapsed: true, taskIds: [] },
  { id: 'g2', collapsed: false, taskIds: ['d', 'e'] },
];

describe('keyboardMoveTarget (02 §5)', () => {
  test('up and down by one, crossing group edges (collapsed groups are skipped)', () => {
    expect(keyboardMoveTarget(order, ['b'], 'up')).toEqual({
      groupId: 'g1',
      afterId: null,
      beforeId: 'a',
    });
    expect(keyboardMoveTarget(order, ['b'], 'down')).toEqual({
      groupId: 'g1',
      afterId: 'c',
      beforeId: null,
    });
    expect(keyboardMoveTarget(order, ['c'], 'down')).toEqual({
      groupId: 'g2',
      afterId: null,
      beforeId: 'd',
    });
    expect(keyboardMoveTarget(order, ['d'], 'up')).toEqual({
      groupId: 'g1',
      afterId: 'c',
      beforeId: null,
    });
    expect(keyboardMoveTarget(order, ['a'], 'up')).toBeNull();
    expect(keyboardMoveTarget(order, ['e'], 'down')).toBeNull();
  });

  test('to the neighbouring group and to the group edges', () => {
    expect(keyboardMoveTarget(order, ['e'], 'previousGroupEnd')).toEqual({
      groupId: 'g1',
      afterId: 'c',
      beforeId: null,
    });
    expect(keyboardMoveTarget(order, ['a'], 'nextGroupStart')).toEqual({
      groupId: 'g2',
      afterId: null,
      beforeId: 'd',
    });
    expect(keyboardMoveTarget(order, ['c'], 'groupTop')).toEqual({
      groupId: 'g1',
      afterId: null,
      beforeId: 'a',
    });
    expect(keyboardMoveTarget(order, ['a'], 'groupBottom')).toEqual({
      groupId: 'g1',
      afterId: 'c',
      beforeId: null,
    });
    expect(keyboardMoveTarget(order, ['a'], 'groupTop')).toBeNull();
    expect(keyboardMoveTarget(order, ['c'], 'groupBottom')).toBeNull();
    expect(keyboardMoveTarget(order, ['a'], 'previousGroupEnd')).toBeNull();
    expect(keyboardMoveTarget(order, ['e'], 'nextGroupStart')).toBeNull();
  });

  test('a multi-selection moves as one block', () => {
    expect(keyboardMoveTarget(order, ['b', 'c'], 'up')).toEqual({
      groupId: 'g1',
      afterId: null,
      beforeId: 'a',
    });
    expect(keyboardMoveTarget(order, ['a', 'b'], 'down')).toEqual({
      groupId: 'g1',
      afterId: 'c',
      beforeId: null,
    });
    expect(keyboardMoveTarget(order, ['nope'], 'up')).toBeNull();
  });

  test('group steps', () => {
    expect(groupStepTarget(['x', 'y', 'z'], 'y', -1)).toEqual({ afterId: null, beforeId: 'x' });
    expect(groupStepTarget(['x', 'y', 'z'], 'y', 1)).toEqual({ afterId: 'z', beforeId: null });
    expect(groupStepTarget(['x', 'y'], 'x', -1)).toBeNull();
    expect(groupStepTarget(['x'], 'nope', 1)).toBeNull();
  });
});

describe('drop slots (keyboard drag)', () => {
  const moving = new Set(['b']);

  test('every insertion point, one per collapsed group', () => {
    expect(dropSlots(order, moving)).toHaveLength(3 + 1 + 3);
    expect(currentSlot(order, moving)).toBe(1);
    expect(currentSlot(order, new Set(['zzz']))).toBe(0);
  });

  test('jumping groups and drawing indicators', () => {
    const slots = dropSlots(order, moving);
    expect(groupJump(slots, 1, 1)).toBe(3);
    expect(groupJump(slots, 3, -1)).toBe(0);
    expect(groupJump(slots, 0, -1)).toBe(0);
    expect(groupJump(slots, 99, 1)).toBe(99);
    expect(slotIndicator(order, moving, { groupIndex: 0, index: 0 })).toEqual({
      rowId: 'a',
      edge: 'before',
    });
    expect(slotIndicator(order, moving, { groupIndex: 0, index: 2 })).toEqual({
      rowId: 'c',
      edge: 'after',
    });
    expect(slotIndicator(order, moving, { groupIndex: 1, index: 0 })).toEqual({
      rowId: 'group:gc',
      edge: 'inside',
    });
    expect(slotIndicator(order, moving, { groupIndex: 9, index: 0 })).toBeNull();
    expect(slotIntent(order, moving, { groupIndex: 2, index: 1 })).toEqual({
      groupId: 'g2',
      afterId: 'd',
      beforeId: 'e',
    });
    expect(slotIntent(order, moving, { groupIndex: 9, index: 0 })).toBeNull();
  });

  test('pointer indicators map back to slots', () => {
    expect(indicatorSlot(order, moving, { rowId: 'c', edge: 'after' })).toEqual({
      groupIndex: 0,
      index: 2,
    });
    expect(indicatorSlot(order, moving, { rowId: 'd', edge: 'before' })).toEqual({
      groupIndex: 2,
      index: 0,
    });
    expect(indicatorSlot(order, moving, { rowId: 'group:gc', edge: 'inside' })).toEqual({
      groupIndex: 1,
      index: 0,
    });
    expect(indicatorSlot(order, moving, { rowId: 'add:g2', edge: 'before' })).toEqual({
      groupIndex: 2,
      index: 2,
    });
    expect(indicatorSlot(order, moving, { rowId: 'unknown', edge: 'before' })).toBeNull();
  });
});

describe('no-op moves (02 §5: never offered, never sent)', () => {
  test('a block directly before or after itself is a no-op', () => {
    const seq = ['a', 'b', 'c', 'd'];
    expect(isNoopIntent(seq, ['b'], { afterId: 'a', beforeId: 'c' })).toBe(true);
    expect(isNoopIntent(seq, ['a'], { afterId: null, beforeId: 'b' })).toBe(true);
    expect(isNoopIntent(seq, ['d'], { afterId: 'c', beforeId: null })).toBe(true);
    expect(isNoopIntent(seq, ['b', 'c'], { afterId: 'a', beforeId: 'd' })).toBe(true);
    expect(isNoopIntent(seq, ['b'], { afterId: 'c', beforeId: 'd' })).toBe(false);
    expect(isNoopIntent(seq, ['b'], { afterId: null, beforeId: 'a' })).toBe(false);
    // Half an intent is not the same place: the server may resolve it elsewhere.
    expect(isNoopIntent(seq, ['b'], { afterId: 'a' })).toBe(false);
  });

  test('scattered, reordered or foreign tasks always move', () => {
    const seq = ['a', 'b', 'c', 'd'];
    expect(isNoopIntent(seq, ['a', 'c'], { afterId: null, beforeId: 'b' })).toBe(false);
    expect(isNoopIntent(seq, ['c', 'b'], { afterId: 'a', beforeId: 'd' })).toBe(false);
    expect(isNoopIntent(seq, ['x'], { afterId: null, beforeId: 'a' })).toBe(false);
    expect(isNoopIntent(seq, [], { afterId: null, beforeId: 'a' })).toBe(false);
  });

  test('drop slots equivalent to the current position', () => {
    // b sits at index 1 of g1's remaining tasks [a, c].
    expect(isNoopSlot(order, ['b'], { groupIndex: 0, index: 1 })).toBe(true);
    expect(isNoopSlot(order, ['b'], { groupIndex: 0, index: 0 })).toBe(false);
    expect(isNoopSlot(order, ['b'], { groupIndex: 0, index: 2 })).toBe(false);
    expect(isNoopSlot(order, ['b'], { groupIndex: 2, index: 0 })).toBe(false);
    expect(isNoopSlot(order, ['b'], { groupIndex: 1, index: 0 })).toBe(false);
    expect(isNoopSlot(order, ['b'], { groupIndex: 9, index: 0 })).toBe(false);
    expect(isNoopSlot(order, ['a', 'b'], { groupIndex: 0, index: 0 })).toBe(true);
    expect(isNoopSlot(order, ['a', 'c'], { groupIndex: 0, index: 0 })).toBe(false);
    const slot = indicatorSlot(order, new Set(['b']), { rowId: 'a', edge: 'after' });
    expect(slot && isNoopSlot(order, ['b'], slot)).toBe(true);
  });
});

describe('subtask rows (P3)', () => {
  const sub = (
    id: string,
    parentId: string,
    position: string,
    extra: Partial<Task> = {},
  ): Task => ({
    ...task(id, 'g1', position),
    parentId,
    subtaskPosition: position,
    placement: null,
    ...extra,
  });

  test('expanded parents show indented subtasks, drafts, and "+ Add subtask"', () => {
    const parent = {
      ...task('p', 'g1', 'a0'),
      counts: { subtasks: 2, subtasksDone: 0, comments: 0, attachments: 0 },
    };
    const s = {
      ...state([parent, task('q', 'g1', 'a1'), sub('s1', 'p', 'a0'), sub('s2', 'p', 'a1')]),
      expandedTaskIds: ['p'],
    };
    const drafts: Draft[] = [{ id: 'd', groupId: 'g1', afterId: 's1', parentId: 'p' }];
    const rows = buildRows(s, options({ drafts }));
    const ids = rows.map((r) => r.id);
    expect(ids.slice(ids.indexOf('p'), ids.indexOf('q') + 1)).toEqual([
      'p',
      's1',
      'd',
      's2',
      'addsub:p',
      'q',
    ]);
    const s1 = rows.find((r) => r.id === 's1');
    expect(s1).toMatchObject({ kind: 'task', level: 3, parentId: 'p', groupId: 'g1' });
    expect(rows.find((r) => r.id === 'p')).toMatchObject({ expandable: true, expanded: true });
    // Subtasks never take part in group moves.
    expect(visibleOrder(rows).find((g) => g.id === 'g1')?.taskIds).toEqual(['p', 'q']);
    const collapsed = buildRows({ ...s, expandedTaskIds: [] }, options());
    expect(collapsed.map((r) => r.id)).not.toContain('s1');
  });

  test('orphan subtasks get the parent breadcrumb; the tag filter keeps headers', () => {
    const foreign = {
      ...task('fp', 'g1', 'a0'),
      placement: null,
      assigneeId: 'other',
      title: 'Their plan',
    };
    const orphan = { ...sub('o', 'fp', 'a0'), placement: { groupId: 'g1', position: 'a0' } };
    const tagged = { ...task('t', 'g2', 'a0'), tagIds: ['urgent'] };
    const s = state([foreign, orphan, tagged]);
    const rows = buildRows(s, options());
    expect(rows.find((r) => r.id === 'o')).toMatchObject({ breadcrumb: 'Their plan', level: 2 });
    expect(rows.map((r) => r.id)).not.toContain('fp');
    const filtered = buildRows(s, options({ tagFilter: ['urgent'] }));
    expect(filtered.filter((r) => r.kind === 'task').map((r) => r.id)).toEqual(['t']);
    expect(filtered.filter((r) => r.kind === 'group').length).toBe(2);
  });
});
