import { describe, expect, it } from 'vitest';
import type { Task } from '../src/schemas/list.ts';
import { compareUpcoming, isUpcoming, upcomingDay } from '../src/upcoming.ts';

const TODAY = '2026-10-05';

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 't',
    orgId: 'o',
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title: 't',
    assigneeId: 'me',
    createdBy: 'me',
    dueDate: '2026-10-08',
    dueTime: null,
    dueTz: null,
    startDate: null,
    recurrence: 'FREQ=WEEKLY',
    completedAt: null,
    tagIds: [],
    hasDescription: false,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: { groupId: 'g', position: 'a0' },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe('ADR 0068 isUpcoming', () => {
  it('holds an open recurring task back until its day', () => {
    expect(isUpcoming(task(), TODAY)).toBe(true);
    expect(isUpcoming(task({ dueDate: '2026-10-06' }), TODAY)).toBe(true);
  });

  it('shows it on its day, and when it is overdue', () => {
    expect(isUpcoming(task({ dueDate: TODAY }), TODAY)).toBe(false);
    expect(isUpcoming(task({ dueDate: '2026-10-01' }), TODAY)).toBe(false);
  });

  it('uses the start date when there is one', () => {
    expect(isUpcoming(task({ startDate: TODAY, dueDate: '2026-10-09' }), TODAY)).toBe(false);
    expect(isUpcoming(task({ startDate: '2026-10-07', dueDate: '2026-10-09' }), TODAY)).toBe(true);
  });

  it('leaves non-recurring, completed, deleted, undated tasks and subtasks alone', () => {
    expect(isUpcoming(task({ recurrence: null }), TODAY)).toBe(false);
    expect(isUpcoming(task({ recurrence: undefined }), TODAY)).toBe(false);
    expect(isUpcoming(task({ completedAt: 5 }), TODAY)).toBe(false);
    expect(isUpcoming({ ...task(), deletedAt: 5 }, TODAY)).toBe(false);
    expect(isUpcoming({ ...task(), deletedAt: null }, TODAY)).toBe(true);
    expect(isUpcoming(task({ dueDate: null }), TODAY)).toBe(false);
    expect(isUpcoming(task({ parentId: 'p' }), TODAY)).toBe(false);
  });
});

describe('ADR 0068 upcomingDay', () => {
  it('is the start date, else the due date, else null', () => {
    expect(upcomingDay(task({ startDate: '2026-10-07' }))).toBe('2026-10-07');
    expect(upcomingDay(task())).toBe('2026-10-08');
    expect(upcomingDay(task({ dueDate: null }))).toBeNull();
  });
});

describe('ADR 0068 compareUpcoming', () => {
  it('orders by day, due date, due time (untimed last), title, then id', () => {
    const rows = [
      task({ id: 'f', title: 'b', dueDate: '2026-10-09' }),
      task({ id: 'e', title: 'a', dueDate: '2026-10-09' }),
      task({ id: 'd', title: 'a', dueDate: '2026-10-09' }),
      task({ id: 'c', dueDate: '2026-10-08', dueTime: null }),
      task({ id: 'b', dueDate: '2026-10-08', dueTime: '09:00' }),
      task({ id: 'a2', dueDate: '2026-10-08', dueTime: '08:00' }),
      task({ id: 'a', startDate: '2026-10-06', dueDate: '2026-10-10' }),
      task({ id: 'z', startDate: '2026-10-06', dueDate: '2026-10-07' }),
    ];
    expect(rows.sort(compareUpcoming).map((t) => t.id)).toEqual([
      'z',
      'a',
      'a2',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('is zero only for the same task', () => {
    expect(compareUpcoming(task(), task())).toBe(0);
    expect(compareUpcoming(task({ dueDate: null }), task({ dueDate: null }))).toBe(0);
  });
});
