import { describe, expect, it } from 'vitest';
import { registerJobs } from '../src/jobs/register.ts';
import { createScheduler } from '../src/jobs/scheduler.ts';
import { captureLogger, createTestDb } from './helpers.ts';

describe('scheduler', () => {
  it('registers the daily PRAGMA optimize job and runs it', async () => {
    const { logger, lines } = captureLogger();
    const scheduler = createScheduler(logger);
    const db = createTestDb();
    try {
      registerJobs(scheduler, { db });
      expect(scheduler.jobs()).toEqual(['pragma-optimize']);
      await scheduler.run('pragma-optimize');
      expect(lines.some((l) => l.job === 'pragma-optimize' && l.msg === 'job finished')).toBe(true);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('logs job failures instead of throwing', async () => {
    const { logger, lines } = captureLogger();
    const scheduler = createScheduler(logger);
    scheduler.register('broken', '0 0 1 1 *', () => {
      throw new Error('kaboom');
    });
    await scheduler.run('broken');
    scheduler.stop();
    const line = lines.find((l) => l.msg === 'job failed');
    expect(line).toMatchObject({ job: 'broken', level: 'error' });
  });

  it('rejects duplicate job names', () => {
    const scheduler = createScheduler(captureLogger().logger);
    scheduler.register('a', '0 4 * * *', () => {});
    expect(() => scheduler.register('a', '0 4 * * *', () => {})).toThrow(/already registered/);
    scheduler.stop();
  });
});
