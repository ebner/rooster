import { describe, expect, it } from 'vitest';
import {
  sseHelloSchema,
  sseInvalidateSchema,
  sseNotificationSchema,
} from '../src/schemas/events.ts';
import { parseSseHello, parseSseInvalidate, parseSseNotification } from '../src/sse.ts';

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

const task = '01900000-0000-7000-8000-000000000002';
const preview = {
  id: task,
  orgId: org,
  type: 'assigned',
  taskId: task,
  actorName: 'Anna',
  title: 'T',
};
const notifications: unknown[] = [
  { unreadCount: 3, notification: preview },
  { unreadCount: 0, notification: null },
  { unreadCount: 1, notification: { ...preview, taskId: null, actorName: null, title: null } },
  { unreadCount: 1, notification: { ...preview, extra: 1 }, extra: 2 },
  { unreadCount: -1, notification: null },
  { unreadCount: 1.5, notification: null },
  { unreadCount: '1', notification: null },
  { unreadCount: 1 },
  { unreadCount: 1, notification: { ...preview, id: 'x' } },
  { unreadCount: 1, notification: { ...preview, orgId: null } },
  { unreadCount: 1, notification: { ...preview, type: 3 } },
  { unreadCount: 1, notification: { ...preview, taskId: 'x' } },
  { unreadCount: 1, notification: { ...preview, actorName: 1 } },
  { unreadCount: 1, notification: { ...preview, title: undefined } },
  { unreadCount: 1, notification: [] },
  null,
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

  it.each(notifications.map((v) => [JSON.stringify(v), v]))('notification %s', (_label, value) => {
    const zod = sseNotificationSchema.safeParse(value);
    expect(parseSseNotification(value)).toEqual(zod.success ? zod.data : null);
  });
});
