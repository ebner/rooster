import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deferSignals,
  ProfileLockTimeout,
  profileLockPath,
  takeOver,
  withProfileLock,
} from '../src/profile-lock.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rooster-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = () => profileLockPath(dir, 'agent');
function plant(content: string, ageMs = 0): void {
  mkdirSync(dirname(lockPath()), { recursive: true });
  writeFileSync(lockPath(), content);
  if (ageMs > 0) {
    const then = (Date.now() - ageMs) / 1000;
    utimesSync(lockPath(), then, then);
  }
}
const holder = (pid: number, host: string, at = Date.now()) =>
  JSON.stringify({ pid, host, at, id: 'x' });

describe('the per-profile refresh lock', () => {
  it('one holder at a time within a process; released afterwards', async () => {
    const spans: [number, number][] = [];
    const hold = () =>
      withProfileLock(dir, 'agent', async () => {
        const start = performance.now();
        await new Promise((r) => setTimeout(r, 15));
        spans.push([start, performance.now()]);
      });
    await Promise.all([hold(), hold(), hold()]);
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]?.[0]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] ?? 0);
    }
    expect(() => readFileSync(lockPath())).toThrow();
  });

  it('different profiles do not wait for each other', async () => {
    expect(profileLockPath(dir, 'a')).not.toBe(profileLockPath(dir, 'b'));
    let inner = false;
    await withProfileLock(dir, 'a', async () => {
      await withProfileLock(dir, 'b', async () => {
        inner = true;
      });
    });
    expect(inner).toBe(true);
  });

  it('a lock left by a dead process on this host is taken over at once', async () => {
    plant(holder(999_999, hostname()));
    let ran = false;
    await withProfileLock(
      dir,
      'agent',
      async () => {
        ran = true;
      },
      { timeoutMs: 100, isAlive: () => false },
    );
    expect(ran).toBe(true);
  });

  it('a live holder (or one on another host) is waited for, then names its pid', async () => {
    plant(holder(4242, 'other-host'));
    const error = await withProfileLock(dir, 'agent', async () => {}, { timeoutMs: 150 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProfileLockTimeout);
    expect((error as ProfileLockTimeout).holderPid).toBe(4242);
    expect((error as ProfileLockTimeout).lockPath).toBe(lockPath());
    // Never removed by a waiter that gave up.
    expect(readFileSync(lockPath(), 'utf8')).toContain('4242');
  });

  it('a lock older than any holder could be is taken over, whoever held it', async () => {
    plant(holder(4242, 'other-host', Date.now() - 10 * 60_000));
    let ran = false;
    await withProfileLock(
      dir,
      'agent',
      async () => {
        ran = true;
      },
      { timeoutMs: 100 },
    );
    expect(ran).toBe(true);
  });

  it('a half-written lock is judged by its age', async () => {
    plant('');
    await expect(
      withProfileLock(dir, 'agent', async () => {}, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ProfileLockTimeout);
    plant('', 10 * 60_000);
    await withProfileLock(dir, 'agent', async () => {}, { timeoutMs: 100 });
  });

  it('a takeover that moved a newer lock puts it back', async () => {
    const live = holder(1, 'h');
    plant(live);
    await takeOver(lockPath(), holder(2, 'h'));
    expect(readFileSync(lockPath(), 'utf8')).toBe(live);
    await takeOver(lockPath(), readFileSync(lockPath(), 'utf8'));
    expect(() => readFileSync(lockPath())).toThrow();
  });

  it('release never removes a lock that is no longer ours', async () => {
    await withProfileLock(dir, 'agent', async () => {
      writeFileSync(lockPath(), holder(7, 'someone'));
    });
    expect(readFileSync(lockPath(), 'utf8')).toContain('someone');
  });

  it('three real processes never hold it at once', async () => {
    writeFileSync(join(dir, 'counter'), '0');
    const script = join(import.meta.dirname, 'support', 'lock-holder.ts');
    const count = 15;
    await Promise.all(
      [1, 2, 3].map(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['--import', 'tsx', script, dir, String(count)], {
              cwd: join(import.meta.dirname, '..'),
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let err = '';
            child.stderr?.on('data', (d: Buffer) => {
              err += d.toString();
            });
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
          }),
      ),
    );
    expect(Number(readFileSync(join(dir, 'counter'), 'utf8'))).toBe(3 * count);
  }, 60_000);
});

describe('deferSignals', () => {
  it('holds a termination signal until the critical section ends, then delivers it', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const order: string[] = [];
      await deferSignals(async () => {
        process.emit('SIGTERM', 'SIGTERM');
        order.push('stored');
      });
      order.push('after');
      expect(order).toEqual(['stored', 'after']);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(process.listenerCount('SIGTERM')).toBe(0);
    } finally {
      kill.mockRestore();
    }
  });

  it('delivers nothing when no signal came', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect(await deferSignals(async () => 42)).toBe(42);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
