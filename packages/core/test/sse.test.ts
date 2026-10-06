import { describe, expect, it } from 'vitest';
import { sseHelloSchema, sseInvalidateSchema } from '../src/schemas/events.ts';
import { parseSseHello, parseSseInvalidate } from '../src/sse.ts';

const org = '01900000-0000-7000-8000-000000000001';

const hellos: unknown[] = [
  { version: '1.0.0', gitSha: 'abc', serverTime: 1 },
  { version: '1.0.0', gitSha: 'abc', serverTime: 0, extra: true },
  { version: 1, gitSha: 'abc', serverTime: 1 },
  { version: '1', gitSha: null, serverTime: 1 },
  { version: '1', gitSha: 'x', serverTime: -1 },
  { version: '1', gitSha: 'x', serverTime: 1.5 },
  { version: '1', gitSha: 'x' },
  null,
  [],
  'hello',
];

const invalidations: unknown[] = [
  { org, keys: [['my-list', org]], origin: null },
  { org: null, keys: [['me']], origin: 'tab-1' },
  { org, keys: [['a', 'b', 'c', 'd']], origin: null, extra: 1 },
  { org, keys: [['a', 'b', 'c', 'd', 'e']], origin: null },
  { org, keys: [[]], origin: null },
  { org, keys: [], origin: null },
  { org, keys: [['x', 1]], origin: null },
  { org: 'not-a-uuid', keys: [['me']], origin: null },
  { org, keys: [['me']] },
  { org, keys: [['me']], origin: 7 },
  { keys: [['me']], origin: null },
  null,
  [['me']],
];

describe('SSE payload guards agree with the zod schemas', () => {
  it.each(hellos.map((v) => [JSON.stringify(v), v]))('hello %s', (_label, value) => {
    const zod = sseHelloSchema.safeParse(value);
    expect(parseSseHello(value)).toEqual(zod.success ? zod.data : null);
  });

  it.each(invalidations.map((v) => [JSON.stringify(v), v]))('invalidate %s', (_label, value) => {
    const zod = sseInvalidateSchema.safeParse(value);
    expect(parseSseInvalidate(value)).toEqual(zod.success ? zod.data : null);
  });
});
