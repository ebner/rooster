import { describe, expect, test, vi } from 'vitest';
import { electLeader } from './leader';

/** A Web Locks stand-in: one holder per name, waiters in order. */
function fakeLocks() {
  const queue: (() => Promise<unknown>)[] = [];
  let held = false;
  const next = () => {
    const callback = queue.shift();
    if (!callback) return;
    held = true;
    void callback().finally(() => {
      held = false;
      next();
    });
  };
  return {
    request: (_name: string, callback: () => Promise<unknown>) => {
      queue.push(callback);
      if (!held) next();
      return Promise.resolve();
    },
  };
}

describe('leader election (Web Locks)', () => {
  test('exactly one tab leads; the next takes over when it lets go', async () => {
    const locks = fakeLocks();
    const onA = vi.fn();
    const onB = vi.fn();
    const a = electLeader(onA, locks);
    const b = electLeader(onB, locks);
    await Promise.resolve();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(onB).not.toHaveBeenCalled();
    a.release();
    await vi.waitFor(() => expect(b.isLeader()).toBe(true));
    expect(a.isLeader()).toBe(false);
    expect(onB).toHaveBeenCalledOnce();
  });

  test('without navigator.locks every tab leads (idempotency keeps that safe)', async () => {
    const onLeader = vi.fn();
    const tab = electLeader(onLeader, undefined);
    expect(tab.isLeader()).toBe(true);
    await Promise.resolve();
    expect(onLeader).toHaveBeenCalledOnce();
  });
});
