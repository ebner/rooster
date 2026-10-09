import { describe, expect, it } from 'vitest';
import { viewRows } from '../src/commands/list.ts';

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
