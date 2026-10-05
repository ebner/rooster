import { describe, expect, it } from 'vitest';
import { BACKUP_NAME_REGEX, backupNameSchema, backupSchema } from '../src/schemas/backup.ts';
import { groupMoveResultSchema } from '../src/schemas/list.ts';
import {
  myListQuerySchema,
  pageQuerySchema,
  taskPageSchema,
  taskQuerySchema,
} from '../src/schemas/task-query.ts';

describe('task query schemas', () => {
  it('coerces query-string numbers and bounds the page size', () => {
    expect(pageQuerySchema.parse({ limit: '25', cursor: 'abc' })).toEqual({
      limit: 25,
      cursor: 'abc',
    });
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(myListQuerySchema.parse({ completedSince: '1700000000000' })).toEqual({
      completedSince: 1_700_000_000_000,
    });
  });

  it('accepts the P2 views and filters', () => {
    expect(
      taskQuerySchema.parse({ view: 'overdue', completed: 'any', dueFrom: '2026-10-01' }),
    ).toEqual({ view: 'overdue', completed: 'any', dueFrom: '2026-10-01' });
    expect(taskQuerySchema.safeParse({ view: 'everyone' }).success).toBe(false);
    expect(taskQuerySchema.safeParse({ dueTo: '2026-02-30' }).success).toBe(false);
    expect(taskPageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('group move result carries the position', () => {
    expect(groupMoveResultSchema.parse({ position: 'a0' })).toEqual({ position: 'a0' });
  });
});

describe('backup schemas', () => {
  it('accepts only names produced by the server', () => {
    for (const name of [
      'rooster-2026-10-05T03-00-00-000Z.db',
      'manual-2026-10-05T12-34-56-789Z.db',
      'pre-migrate-2026-10-05T03-00-00-000Z.db',
    ]) {
      expect(backupNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of ['../rooster.db', 'rooster.db', 'rooster-2026-10-05.db', 'x/manual-1.db']) {
      expect(BACKUP_NAME_REGEX.test(name), name).toBe(false);
    }
    expect(backupSchema.parse({ name: 'n', size: 1, createdAt: 2, kind: 'weekly' })).toMatchObject({
      kind: 'weekly',
    });
  });
});
