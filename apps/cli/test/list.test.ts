import { describe, expect, it } from 'vitest';
import { viewRows } from '../src/commands/list.ts';
import { inUpcoming } from '../src/output/format.ts';

const task = (id: string, parentId: string | null, assigneeId: string | null) => ({
  id,
  parentId,
  assigneeId,
});

describe('[P2] view rows without --subtasks (D-05)', () => {
  it('collapses only subtasks that share their parent’s assignee', () => {
    const tasks = [
      task('p', null, 'ann'),
      task('same', 'p', 'ann'),
      task('other', 'p', 'bob'),
      task('unassigned', 'p', null),
      task('orphan', 'gone', 'ann'),
      task('deep', 'same', 'ann'),
      task('deep-other', 'same', 'bob'),
    ];
    expect(viewRows(tasks).map((t) => t.id)).toEqual([
      'p',
      'other',
      'unassigned',
      'orphan',
      'deep-other',
    ]);
  });
});

describe('ADR 0068: which tasks Upcoming holds (server values untrusted)', () => {
  const base = {
    parentId: null,
    recurrence: 'FREQ=WEEKLY' as string | null,
    startDate: null as string | null,
    dueDate: '2026-11-16' as string | null,
    completedAt: null as number | null,
  };
  it('an open, top-level repeating task whose day is after today', () => {
    expect(inUpcoming(base, '2026-11-11')).toBe(true);
    expect(inUpcoming(base, '2026-11-16')).toBe(false);
    // The start date is its day.
    expect(inUpcoming({ ...base, startDate: '2026-11-11' }, '2026-11-11')).toBe(false);
    expect(inUpcoming({ ...base, completedAt: 1 }, '2026-11-11')).toBe(false);
    expect(inUpcoming({ ...base, parentId: 'p' }, '2026-11-11')).toBe(false);
    expect(inUpcoming({ ...base, recurrence: null }, '2026-11-11')).toBe(false);
  });

  it('never for a rule or a day that is not what the API promises', () => {
    expect(inUpcoming({ ...base, dueDate: 'zzzz' }, '2026-11-11')).toBe(false);
    expect(inUpcoming({ ...base, startDate: '9999-99-99' }, '2026-11-11')).toBe(false);
    expect(inUpcoming({ ...base, recurrence: 1 as unknown as string }, '2026-11-11')).toBe(false);
  });
});
