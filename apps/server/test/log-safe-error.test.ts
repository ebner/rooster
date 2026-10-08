import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { logSafeError } from '../src/lib/log-safe-error.ts';

describe('logged errors never carry query parameters', () => {
  it('redacts Drizzle query params but keeps the SQL, name, code and cause', () => {
    const cause = Object.assign(new Error('UNIQUE constraint failed: task.id'), {
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });
    const err = new DrizzleQueryError(
      'insert into "task" ("title") values (?)',
      ['Confidential: layoffs list'],
      cause,
    );
    const logged = JSON.stringify(logSafeError(err));
    expect(logged).not.toContain('layoffs');
    expect(logged).toContain('insert into');
    expect(logged).toContain('params: [redacted]');
    expect(logSafeError(err).cause).toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
  });

  it('handles non-errors and deep causes', () => {
    expect(logSafeError('boom')).toEqual({ name: 'string', message: '[non-error thrown]' });
    let e: Error = new Error('leaf');
    for (let i = 0; i < 10; i++) e = new Error(`level ${i}`, { cause: e });
    let depth = 0;
    for (let c = logSafeError(e).cause; c; c = c.cause) depth++;
    expect(depth).toBe(3);
  });
});
