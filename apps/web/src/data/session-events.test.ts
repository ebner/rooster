import { describe, expect, test, vi } from 'vitest';
import { onSessionDataCleared, sessionDataCleared, sessionScope } from './session-events';

describe('session scopes', () => {
  test('a request outliving its session is aborted and reads as stale', () => {
    const abort = vi.fn();
    const scope = sessionScope(abort);
    expect(scope.stale()).toBe(false);
    sessionDataCleared();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(scope.stale()).toBe(true);
    scope.done();
  });

  test('a settled request lets go of its abort', () => {
    const abort = vi.fn();
    const scope = sessionScope(abort);
    scope.done();
    sessionDataCleared();
    expect(abort).not.toHaveBeenCalled();
  });

  test('listeners can unsubscribe', () => {
    const listener = vi.fn();
    const stop = onSessionDataCleared(listener);
    stop();
    sessionDataCleared();
    expect(listener).not.toHaveBeenCalled();
  });
});
