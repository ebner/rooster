import { describe, expect, it } from 'vitest';
import { generateNKeysBetween } from '../src/ordering.ts';
import type { Group, Task } from '../src/schemas/list.ts';
import { ALL_VIEW_NAMES } from '../src/schemas/task-query.ts';
import {
  ALL_VIEWS,
  type AllViewSource,
  allViewCounts,
  selectAllView,
  type ViewContext,
} from '../src/views.ts';

const ME = 'user-me';
const viewerTz = 'Europe/Stockholm';
// 2026-10-05 (Monday) 10:00 in Stockholm.
const nowMs = Date.UTC(2026, 9, 5, 8, 0);
const ctx: ViewContext = {
  today: '2026-10-05',
  nowMs,
  viewerTz,
  viewerId: ME,
  showCompleted: false,
};
const [p0, p1, p2] = generateNKeysBetween(null, null, 3) as [string, string, string];

function group(orgId: string, id: string, position: string): Group {
  return {
    id,
    orgId,
    kind: id.endsWith('inbox') ? 'inbox' : 'normal',
    name: id,
    position,
    collapsed: false,
  };
}

function task(orgId: string, id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    orgId,
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

function org(orgId: string, list: Task[]): AllViewSource {
  const groups = [group(orgId, `${orgId}-inbox`, p0)];
  return {
    orgId,
    source: {
      groups: Object.fromEntries(groups.map((g) => [g.id, g])),
      tasks: Object.fromEntries(list.map((t) => [t.id, t])),
    },
  };
}

const at = (orgId: string, position: string) => ({
  placement: { groupId: `${orgId}-inbox`, position },
});

const personal = org('personal', [
  task('personal', 'p-today-2', { ...at('personal', p1), dueDate: '2026-10-05' }),
  task('personal', 'p-today-1', { ...at('personal', p0), dueDate: '2026-10-05' }),
  task('personal', 'p-late', { ...at('personal', p2), dueDate: '2026-10-01' }),
  task('personal', 'p-done', { ...at('personal', p2), dueDate: '2026-10-05', completedAt: 5 }),
]);
const kestrel = org('kestrel', [
  task('kestrel', 'k-today', { ...at('kestrel', p0), dueDate: '2026-10-05' }),
  task('kestrel', 'k-timed', {
    ...at('kestrel', p1),
    dueDate: '2026-10-05',
    dueTime: '15:00',
    dueTz: viewerTz,
  }),
  task('kestrel', 'k-late', { ...at('kestrel', p2), dueDate: '2026-10-03' }),
  task('kestrel', 'k-thu', { ...at('kestrel', p2), dueDate: '2026-10-08' }),
  task('kestrel', 'k-theirs', { assigneeId: 'other', dueDate: '2026-10-05' }),
]);
const empty = org('club', []);

const shape = (view: (typeof ALL_VIEWS)[number], sources = [personal, kestrel, empty], c = ctx) =>
  selectAllView(sources, view, c).map((s) => [
    s.id,
    s.kind,
    s.date,
    s.items.map((i) => `${i.orgId}:${i.taskId}`),
  ]);

describe('All organisations views (ADR 0073 A)', () => {
  it('names the same views as the API', () => {
    expect([...ALL_VIEWS]).toEqual([...ALL_VIEW_NAMES]);
  });

  it('Today: overdue then today, mixed across orgs by due, then org order, then My tasks order', () => {
    expect(shape('today')).toEqual([
      ['overdue', 'overdue', null, ['personal:p-late', 'kestrel:k-late']],
      [
        'today',
        'today',
        '2026-10-05',
        ['kestrel:k-timed', 'personal:p-today-1', 'personal:p-today-2', 'kestrel:k-today'],
      ],
    ]);
    // The org order is the caller's (the sidebar order).
    expect(shape('today', [kestrel, personal])[1]?.[3]).toEqual([
      'kestrel:k-timed',
      'kestrel:k-today',
      'personal:p-today-1',
      'personal:p-today-2',
    ]);
  });

  it('keeps overdue first when only a later org has overdue tasks', () => {
    const late = org('late', [task('late', 'l1', { ...at('late', p0), dueDate: '2026-10-01' })]);
    const onlyToday = org('t', [task('t', 't1', { ...at('t', p0), dueDate: '2026-10-05' })]);
    expect(shape('today', [onlyToday, late]).map((s) => s[0])).toEqual(['overdue', 'today']);
  });

  it('Next 7 days: seven days in date order, Overdue: one section or none', () => {
    const week = shape('week');
    expect(week).toHaveLength(7);
    expect(week.map((s) => s[0])).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
    expect(week[3]?.[3]).toEqual(['kestrel:k-thu']);
    expect(shape('overdue')).toEqual([
      ['overdue', 'overdue', null, ['personal:p-late', 'kestrel:k-late']],
    ]);
    expect(shape('overdue', [empty])).toEqual([]);
    expect(shape('today', [])).toEqual([]);
  });

  it('shows completed tasks only with showCompleted', () => {
    const withDone = shape('today', [personal], { ...ctx, showCompleted: true });
    expect(withDone[1]?.[3]).toContain('personal:p-done');
  });

  it('sums the badges of every org', () => {
    expect(allViewCounts([personal, kestrel, empty], ctx)).toEqual({
      today: 6,
      week: 5,
      overdue: 2,
    });
  });
});
