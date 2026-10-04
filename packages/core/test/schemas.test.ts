import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.ts';
import {
  dateFormatSchema,
  idSchema,
  isoDateSchema,
  localeSchema,
  metaSchema,
  problemSchema,
  timeFormatSchema,
  timeSchema,
  timestampSchema,
  weekStartSchema,
} from '../src/schemas.ts';

describe('common schemas', () => {
  it('idSchema accepts only UUIDv7', () => {
    expect(idSchema.safeParse(uuidv7()).success).toBe(true);
    expect(idSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(false);
    expect(idSchema.safeParse(123).success).toBe(false);
  });

  it.each([
    ['2026-10-04', true],
    ['2024-02-29', true],
    ['2026-02-29', false],
    ['2026-10-4', false],
    ['04/10/2026', false],
  ])('isoDateSchema %s → %s', (value, ok) => {
    expect(isoDateSchema.safeParse(value).success).toBe(ok);
  });

  it.each([
    ['00:00', true],
    ['23:59', true],
    ['24:00', false],
    ['7:00', false],
    ['07:60', false],
  ])('timeSchema %s → %s', (value, ok) => {
    expect(timeSchema.safeParse(value).success).toBe(ok);
  });

  it('timestampSchema is a non-negative integer', () => {
    expect(timestampSchema.safeParse(1_759_600_000_000).success).toBe(true);
    expect(timestampSchema.safeParse(-1).success).toBe(false);
    expect(timestampSchema.safeParse(1.5).success).toBe(false);
    expect(timestampSchema.safeParse('1').success).toBe(false);
  });

  it('enum schemas', () => {
    expect(localeSchema.options).toEqual(['en', 'sv']);
    expect(localeSchema.safeParse('de').success).toBe(false);
    expect(dateFormatSchema.safeParse('d MMM').success).toBe(true);
    expect(timeFormatSchema.safeParse('12h').success).toBe(true);
    expect(weekStartSchema.safeParse(1).success).toBe(true);
    expect(weekStartSchema.safeParse(2).success).toBe(false);
  });

  it('problemSchema follows RFC 9457 plus code and errors', () => {
    const problem = {
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: 'Validation failed',
      code: 'validation_failed',
      errors: [{ path: 'dueDate', message: 'Expected a calendar date (YYYY-MM-DD)' }],
    };
    expect(problemSchema.parse(problem)).toEqual(problem);
    expect(
      problemSchema.safeParse({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
      }).success,
    ).toBe(true);
    expect(problemSchema.safeParse({ ...problem, code: undefined }).success).toBe(false);
    expect(problemSchema.safeParse({ ...problem, status: 99 }).success).toBe(false);
  });

  it('metaSchema', () => {
    const meta = {
      version: '0.1.0',
      gitSha: 'abc1234',
      providers: [{ id: 'google', name: 'Google' }],
      features: { email: true, push: false, s3: false },
    };
    expect(metaSchema.parse(meta)).toEqual(meta);
    expect(metaSchema.safeParse({ ...meta, features: { email: true } }).success).toBe(false);
  });
});
