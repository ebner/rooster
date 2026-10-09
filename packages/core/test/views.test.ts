import { describe, expect, it } from 'vitest';
import { todayIn } from '../src/dates.ts';
import { generateNKeysBetween } from '../src/ordering.ts';
import type { Group, Task } from '../src/schemas/list.ts';
import {
  inSmartView,
  SMART_VIEWS,
  type SmartView,
  selectView,
  type ViewContext,
  type ViewSource,
  viewCounts,
} from '../src/views.ts';

const ORG = 'org-1';
const ME = 'user-me';
const OTHER = 'user-other';
const viewerTz = 'Europe/Stockholm';
// 2026-10-05 (Monday) 10:00 in Stockholm (CEST, UTC+2).
const nowMs = Date.UTC(2026, 9, 5, 8, 0);
const today = todayIn(viewerTz, nowMs);
const ctx: ViewContext = { today, nowMs, viewerTz, viewerId: ME, showCompleted: false };

const [p0, p1, p2, p3, p4] = generateNKeysBetween(null, null, 5) as [
  string,
  string,
  string,
  string,
  string,
];

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
    createdAt: 10,
    updatedAt: 10,
    ...extra,
  };
}

const at = (groupId: string, position: string) => ({ placement: { groupId, position } });
const STHLM = { dueTz: viewerTz };

// Groups are listed out of order on purpose: the Inbox comes first, then normal groups by position.
const groups = [group('work', p1), group('inbox', p4, 'inbox'), group('home', p0)];
const tasks: Task[] = [
  task('in-1', { ...at('inbox', p0), dueDate: '2026-10-05' }),
  task('in-2', { ...at('inbox', p1), dueDate: '2026-10-03' }),
  // An orphan subtask: its parent is assigned to someone else, so it has its own row.
  task('orphan', { ...at('inbox', p2), parentId: 'w1-other', subtaskPosition: p0 }),
  task('h1', { ...at('home', p0), dueDate: '2026-10-01' }),
  // Timed and already past (10:00 now): overdue although dated today (ADR 0001).
  task('h2', { ...at('home', p1), dueDate: '2026-10-05', dueTime: '09:30', ...STHLM }),
  task('h3', { ...at('home', p2), dueDate: '2026-10-05', dueTime: '11:00', ...STHLM }),
  task('w1', { ...at('work', p0) }),
  task('w1-other', { assigneeId: OTHER, parentId: 'w1', subtaskPosition: p0 }),
  // Subtasks of my own task have no placement; they follow their parent in sibling order.
  task('w1-s1', { parentId: 'w1', subtaskPosition: p1, dueDate: '2026-10-05' }),
  task('w1-s1-a', { parentId: 'w1-s1', subtaskPosition: p0 }),
  task('w2', { ...at('work', p1), dueDate: '2026-10-08' }),
  task('w3', { ...at('work', p2), dueDate: '2026-10-12' }),
  task('w4', { ...at('work', p3), dueDate: '2026-10-05', completedAt: 5 }),
  task('w5', { ...at('work', p4), dueDate: '2026-10-03' }),
  // Same date as in-2 but timed: timed first on the same date.
  task('w6', { ...at('home', p3), dueDate: '2026-10-03', dueTime: '08:00', ...STHLM }),
  task('deleted', { ...at('work', p4), dueDate: '2026-10-05', deletedAt: 7 }),
  task('theirs', { assigneeId: OTHER, dueDate: '2026-10-05' }),
  task('unassigned', { assigneeId: null, dueDate: '2026-10-05' }),
  // Unreachable from My tasks: last, by createdAt.
  task('lost-late', {
    parentId: 'missing',
    subtaskPosition: p0,
    dueDate: '2026-10-05',
    createdAt: 9,
  }),
  task('lost-early', { ...at('gone-group', p0), dueDate: '2026-10-05', createdAt: 3 }),
];

function source(list: readonly Task[] = tasks, gs: readonly Group[] = groups): ViewSource {
  return {
    groups: Object.fromEntries(gs.map((g) => [g.id, g])),
    tasks: Object.fromEntries(list.map((t) => [t.id, t])),
  };
}

const shape = (view: SmartView, c: ViewContext = ctx, s: ViewSource = source()) =>
  selectView(s, view, c).map((section) => [
    section.id,
    section.kind,
    section.date,
    section.taskIds,
  ]);

describe('selectView (02 §10)', () => {
  it('AC-5.1 Today: overdue by due date, then today in My tasks order, from all groups', () => {
    expect(shape('today')).toEqual([
      ['overdue', 'overdue', null, ['h1', 'w6', 'in-2', 'w5', 'h2']],
      ['today', 'today', '2026-10-05', ['in-1', 'h3', 'w1-s1', 'lost-early', 'lost-late']],
    ]);
  });

  it('AC-5.1 Today keeps an empty today section and drops an empty overdue section', () => {
    expect(shape('today', ctx, source([]))).toEqual([['today', 'today', '2026-10-05', []]]);
  });

  it('Overdue is one section sorted by due date, or nothing at all', () => {
    expect(shape('overdue')).toEqual([
      ['overdue', 'overdue', null, ['h1', 'w6', 'in-2', 'w5', 'h2']],
    ]);
    expect(selectView(source([]), 'overdue', ctx)).toEqual([]);
  });

  it('Next 7 days has one section per day (today … today + 6), empty days included', () => {
    expect(shape('week')).toEqual([
      ['2026-10-05', 'day', '2026-10-05', ['in-1', 'h2', 'h3', 'w1-s1', 'lost-early', 'lost-late']],
      ['2026-10-06', 'day', '2026-10-06', []],
      ['2026-10-07', 'day', '2026-10-07', []],
      ['2026-10-08', 'day', '2026-10-08', ['w2']],
      ['2026-10-09', 'day', '2026-10-09', []],
      ['2026-10-10', 'day', '2026-10-10', []],
      ['2026-10-11', 'day', '2026-10-11', []],
    ]);
  });

  it('No date mirrors My tasks: group order, position, subtasks after their parent', () => {
    expect(shape('nodate')).toEqual([['flat', 'flat', null, ['orphan', 'w1', 'w1-s1-a']]]);
    expect(shape('nodate', ctx, source([]))).toEqual([['flat', 'flat', null, []]]);
  });

  it('includes completed tasks in place only with showCompleted', () => {
    const withDone = { ...ctx, showCompleted: true };
    expect(selectView(source(), 'today', withDone)[1]?.taskIds).toEqual([
      'in-1',
      'h3',
      'w1-s1',
      'w4',
      'lost-early',
      'lost-late',
    ]);
    // A completed task due in the past stays in Overdue (classified as if open).
    const pastDone = task('past-done', {
      ...at('inbox', p3),
      dueDate: '2026-10-02',
      completedAt: 1,
    });
    expect(selectView(source([pastDone]), 'overdue', withDone)[0]?.taskIds).toEqual(['past-done']);
    expect(selectView(source([pastDone]), 'overdue', ctx)).toEqual([]);
  });

  it('a timed due dated tomorrow whose instant passed is overdue in Today, tomorrow in Week', () => {
    // 23:30 in Stockholm (still 10-05); 10-06 09:00 in Kiritimati (UTC+14) was 19:00 UTC on 10-05.
    const late = Date.UTC(2026, 9, 5, 21, 30);
    const c = { ...ctx, nowMs: late, today: todayIn(viewerTz, late) };
    const t = task('kiri', {
      ...at('inbox', p0),
      dueDate: '2026-10-06',
      dueTime: '09:00',
      dueTz: 'Pacific/Kiritimati',
    });
    expect(selectView(source([t]), 'today', c)[0]).toMatchObject({
      id: 'overdue',
      taskIds: ['kiri'],
    });
    expect(selectView(source([t]), 'week', c)[1]).toMatchObject({
      id: '2026-10-06',
      taskIds: ['kiri'],
    });
  });

  it('sorts overdue tasks on the same date: timed by time, then untimed', () => {
    const due = (id: string, dueTime: string | null, position: string) =>
      task(id, {
        ...at('inbox', position),
        dueDate: '2026-10-02',
        dueTime,
        dueTz: dueTime && viewerTz,
      });
    const list = [
      due('late', '18:00', p0),
      due('none', null, p1),
      due('early', '07:00', p2),
      due('none2', null, p3),
    ];
    for (const order of [list, [...list].reverse()]) {
      expect(selectView(source(order), 'overdue', ctx)[0]?.taskIds).toEqual([
        'early',
        'late',
        'none',
        'none2',
      ]);
    }
  });

  it('accepts server rows with an explicit null deletedAt', () => {
    const row = { ...task('row', { ...at('inbox', p0) }), deletedAt: null } as unknown as Task;
    expect(selectView(source([row]), 'nodate', ctx)[0]?.taskIds).toEqual(['row']);
  });

  it('survives a parent cycle in a corrupt cache', () => {
    const a = task('a', { parentId: 'b' });
    const b = task('b', { parentId: 'a' });
    expect(selectView(source([a, b]), 'nodate', ctx)[0]?.taskIds).toHaveLength(2);
  });

  it('orders tasks of the same group and position by id (ORDER BY position, id)', () => {
    const x = task('x', { ...at('inbox', p0) });
    const y = task('y', { ...at('inbox', p0) });
    expect(selectView(source([y, x]), 'nodate', ctx)[0]?.taskIds).toEqual(['x', 'y']);
  });
});

describe('viewCounts', () => {
  it('counts open tasks only; my = placed rows of My tasks', () => {
    expect(viewCounts(source(), ctx)).toEqual({
      my: 11,
      today: 10,
      week: 7,
      overdue: 5,
      nodate: 3,
    });
  });

  it('agrees with selectView for every smart view', () => {
    const counts = viewCounts(source(), ctx);
    for (const view of SMART_VIEWS) {
      const total = selectView(source(), view, ctx).reduce((n, s) => n + s.taskIds.length, 0);
      expect(total, view).toBe(counts[view]);
    }
  });

  it('is all zeros for an empty org', () => {
    expect(viewCounts(source([]), ctx)).toEqual({
      my: 0,
      today: 0,
      week: 0,
      overdue: 0,
      nodate: 0,
    });
  });
});

describe('inSmartView', () => {
  it.each([
    ['2026-10-04', null, ['today', 'overdue']],
    ['2026-10-05', null, ['today', 'week']],
    ['2026-10-05', '09:00', ['today', 'week', 'overdue']],
    ['2026-10-06', null, ['week']],
    ['2026-10-11', null, ['week']],
    ['2026-10-12', null, []],
    [null, null, ['nodate']],
  ] as const)('%s %s → %j', (dueDate, dueTime, expected) => {
    const t = { dueDate, dueTime, dueTz: dueTime ? viewerTz : null };
    expect(SMART_VIEWS.filter((view) => inSmartView(t, view, ctx))).toEqual(expected);
  });
});

describe('performance (AC-2.12 budget)', () => {
  it('selects every view and the counts for 1,000 tasks well within 50 ms each', () => {
    const many: Task[] = [];
    const keys = generateNKeysBetween(null, null, 800);
    keys.forEach((key, i) => {
      const day = String(1 + (i % 28)).padStart(2, '0');
      many.push(
        task(`t${i}`, {
          ...at(i % 2 ? 'work' : 'home', key),
          dueDate: i % 5 === 0 ? null : `2026-10-${day}`,
          dueTime: i % 7 === 0 ? '12:00' : null,
          dueTz: i % 7 === 0 ? viewerTz : null,
        }),
      );
    });
    for (let i = 0; i < 200; i++) {
      many.push(task(`s${i}`, { parentId: `t${i}`, subtaskPosition: p0, dueDate: '2026-10-05' }));
    }
    const s = source(many);
    selectView(s, 'today', ctx); // warm-up
    for (const view of SMART_VIEWS) {
      const start = performance.now();
      selectView(s, view, ctx);
      expect(performance.now() - start, view).toBeLessThan(50);
    }
    const start = performance.now();
    viewCounts(s, ctx);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
