import { describe, expect, test, vi } from 'vitest';
import type { SseState } from '../../state/sync-store';
import {
  compareVersions,
  type EventSourceLike,
  EventStream,
  invalidationKeys,
  serverIsNewer,
  sseLongBackoffMs,
  ssePauseHiddenMs,
  subscribeSseNotifications,
} from './events';

const org = '01900000-0000-7000-8000-0000000000aa';

describe('invalidation origin-skip (04 §4.5)', () => {
  const event = (origin: string | null) => ({
    org,
    keys: [
      ['my-list', org],
      ['task', 't1'],
    ],
    origin,
  });

  test("another client's change always invalidates", () => {
    expect(invalidationKeys(event('other'), 'me')).toHaveLength(2);
    expect(invalidationKeys(event(null), 'me')).toHaveLength(2);
  });

  test('our own change skips the keys the pipeline merged, even with ops queued', () => {
    expect(invalidationKeys(event('me'), 'me')).toEqual([]);
    const mixed = { ...event('me'), keys: [['tags', org], ['me'], ['org-members', org]] };
    expect(invalidationKeys(mixed, 'me')).toEqual([['me'], ['org-members', org]]);
  });
});

describe('version handshake', () => {
  test('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
  });

  test('a newer server, or another build of the same version, means update', () => {
    const bundle = { version: '1.2.0', gitSha: 'abc' };
    expect(serverIsNewer({ version: '1.3.0', gitSha: 'x' }, bundle)).toBe(true);
    expect(serverIsNewer({ version: '1.1.0', gitSha: 'x' }, bundle)).toBe(false);
    expect(serverIsNewer({ version: '1.2.0', gitSha: 'abc' }, bundle)).toBe(false);
    expect(serverIsNewer({ version: '1.2.0', gitSha: 'def' }, bundle)).toBe(true);
    expect(serverIsNewer({ version: '1.2.0', gitSha: 'dev' }, bundle)).toBe(false);
  });
});

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event('error'));
  }
}

function stream() {
  vi.useFakeTimers();
  FakeSource.all = [];
  const states: SseState[] = [];
  const handlers = {
    invalidate: vi.fn(),
    onConnect: vi.fn(),
    onHello: vi.fn(),
  };
  const events = new EventStream({
    clientId: 'me',
    ...handlers,
    onState: (s) => states.push(s),
    factory: (url) => new FakeSource(url),
  });
  events.start();
  const latest = () => FakeSource.all.at(-1) as FakeSource;
  return { events, handlers, states, latest };
}

describe('EventStream', () => {
  test('connects, reports hello and invalidates foreign changes', () => {
    const { handlers, latest, states } = stream();
    expect(latest().url).toBe('/api/v1/events');
    latest().open();
    expect(handlers.onConnect).toHaveBeenCalledOnce();
    expect(states).toEqual(['connecting', 'open']);
    latest().emit('hello', { version: '9.9.9', gitSha: 'x', serverTime: 1 });
    expect(handlers.onHello).toHaveBeenCalledWith({ version: '9.9.9', gitSha: 'x', serverTime: 1 });
    latest().emit('invalidate', { org, keys: [['my-list', org]], origin: 'other' });
    latest().emit('invalidate', { org, keys: [['tags', org]], origin: 'me' });
    latest().emit('invalidate', { nonsense: true });
    expect(handlers.invalidate.mock.calls).toEqual([[['my-list', org]]]);
    vi.useRealTimers();
  });

  test('a closed stream reconnects with backoff; a missing endpoint is retried rarely', () => {
    const { latest, handlers } = stream();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      latest().fail(true);
      const before = FakeSource.all.length;
      vi.advanceTimersByTime(30_000);
      expect(FakeSource.all.length).toBe(before + 1);
    }
    latest().fail(true);
    const before = FakeSource.all.length;
    vi.advanceTimersByTime(sseLongBackoffMs - 1);
    expect(FakeSource.all.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all.length).toBe(before + 1);
    // Once it opens, every reconnect counts as a (re)connect.
    latest().open();
    expect(handlers.onConnect).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test('a dropped connection the browser retries itself is not replaced', () => {
    const { latest } = stream();
    latest().open();
    latest().fail(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1);
    vi.useRealTimers();
  });

  test('pauses after 5 minutes hidden and reconnects when visible', () => {
    const { events, latest, states, handlers } = stream();
    latest().open();
    events.visibilityChanged(true);
    vi.advanceTimersByTime(ssePauseHiddenMs - 1);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(latest().closed).toBe(true);
    expect(states.at(-1)).toBe('paused');
    events.visibilityChanged(false);
    expect(FakeSource.all).toHaveLength(2);
    latest().open();
    expect(handlers.onConnect).toHaveBeenCalledTimes(2);

    // A short trip to the background keeps the stream.
    events.visibilityChanged(true);
    vi.advanceTimersByTime(60_000);
    events.visibilityChanged(false);
    vi.advanceTimersByTime(ssePauseHiddenMs);
    expect(latest().closed).toBe(false);
    events.stop();
    expect(latest().closed).toBe(true);
    vi.useRealTimers();
  });

  test('a notification updates the unread count, then invalidates the inbox', () => {
    const { handlers, latest } = stream();
    const seen: string[] = [];
    handlers.invalidate.mockImplementation((key: readonly string[]) => seen.push(key.join()));
    const unsubscribe = subscribeSseNotifications((event) =>
      seen.push(`count ${event.unreadCount}`),
    );
    latest().open();
    const notification = {
      id: '01900000-0000-7000-8000-000000000001',
      orgId: org,
      type: 'mention',
      taskId: '01900000-0000-7000-8000-000000000002',
      actorName: 'Anna',
      title: 'Write Q4 plan',
    };
    latest().emit('notification', { unreadCount: 3, notification });
    latest().emit('notification', { unreadCount: 2, notification: null });
    latest().emit('notification', { unreadCount: -1, notification: null });
    expect(seen).toEqual(['count 3', 'notifications', 'count 2', 'notifications']);
    unsubscribe();
    latest().emit('notification', { unreadCount: 1, notification: null });
    expect(seen.at(-1)).toBe('notifications');
    expect(seen).not.toContain('count 1');
    vi.useRealTimers();
  });
});
