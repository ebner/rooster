import { UUIDV7_REGEX } from './ids.ts';
import type { SseHello, SseInvalidate, SseNotification } from './schemas/events.ts';

/**
 * Zod-free validators for the SSE payloads (`schemas/events.ts`), for the web client: the SSE
 * stream starts with the app, and the zod runtime would add ~26 KB gzip to the initial bundle
 * (10 §4). `test/sse.test.ts` keeps them in agreement with the zod schemas.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSseHello(value: unknown): SseHello | null {
  if (!isObject(value)) return null;
  const { version, gitSha, serverTime } = value;
  if (typeof version !== 'string' || typeof gitSha !== 'string') return null;
  if (typeof serverTime !== 'number' || !Number.isInteger(serverTime) || serverTime < 0) {
    return null;
  }
  return { version, gitSha, serverTime };
}

const isQueryKey = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((s) => typeof s === 'string');

export function parseSseInvalidate(value: unknown): SseInvalidate | null {
  if (!isObject(value)) return null;
  const { org, keys, origin } = value;
  if (org !== null && (typeof org !== 'string' || !UUIDV7_REGEX.test(org))) return null;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isQueryKey)) return null;
  if (origin !== null && typeof origin !== 'string') return null;
  return { org, keys: keys.map((k) => [...k]), origin };
}

const isId = (v: unknown): v is string => typeof v === 'string' && UUIDV7_REGEX.test(v);
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

export function parseSseNotification(value: unknown): SseNotification | null {
  if (!isObject(value)) return null;
  const { unreadCount, notification } = value;
  if (typeof unreadCount !== 'number' || !Number.isInteger(unreadCount) || unreadCount < 0) {
    return null;
  }
  if (notification === null) return { unreadCount, notification: null };
  if (!isObject(notification)) return null;
  const { id, orgId, type, taskId, actorName, title } = notification;
  if (!isId(id) || !isId(orgId) || typeof type !== 'string') return null;
  if (taskId !== null && !isId(taskId)) return null;
  if (!isNullableString(actorName) || !isNullableString(title)) return null;
  return { unreadCount, notification: { id, orgId, type, taskId, actorName, title } };
}
