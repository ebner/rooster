import { describe, expect, test, vi } from 'vitest';
import { fakeLocks } from './fake-locks';
import { electLeader } from './leader';

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

  test('a follower steals the lock from an unresponsive leader, which then waits in line', async () => {
    const locks = fakeLocks();
    const a = { onLeader: vi.fn(), onLost: vi.fn() };
    const b = { onLeader: vi.fn(), onLost: vi.fn() };
    const tabA = electLeader(a, locks);
    const tabB = electLeader(b, locks);
    await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));

    tabB.steal();
    await vi.waitFor(() => expect(tabB.isLeader()).toBe(true));
    expect(tabA.isLeader()).toBe(false);
    expect(a.onLost).toHaveBeenCalledOnce();
    expect(b.onLeader).toHaveBeenCalledOnce();
    // The stealing tab's own queued request was withdrawn: one holder, A waiting.
    expect(locks.holders()).toBe(1);

    // Stealing while leading does nothing.
    tabB.steal();
    expect(b.onLeader).toHaveBeenCalledOnce();

    // A queued up again: it leads once B goes.
    tabB.release();
    await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));
    expect(a.onLeader).toHaveBeenCalledTimes(2);
    expect(b.onLost).not.toHaveBeenCalled();
  });

  test('a released tab neither leads again nor steals', async () => {
    const locks = fakeLocks();
    const a = electLeader(() => {}, locks);
    const onB = vi.fn();
    const b = electLeader(onB, locks);
    await vi.waitFor(() => expect(a.isLeader()).toBe(true));
    b.release();
    b.steal();
    a.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onB).not.toHaveBeenCalled();
    expect(locks.holders()).toBe(0);
  });

  test('without navigator.locks every tab leads (idempotency keeps that safe)', async () => {
    const onLeader = vi.fn();
    const tab = electLeader(onLeader, undefined);
    expect(tab.isLeader()).toBe(true);
    await Promise.resolve();
    expect(onLeader).toHaveBeenCalledOnce();
  });
});
