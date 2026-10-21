import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A per-profile lock across processes, held while an OAuth login's refresh token is spent
 * and its successor stored (11 §9.6: reuse revokes the grant), and while a login or logout
 * retires that secret. `<configDir>/locks/<first 32 hex of sha256(profile)>.lock`, created
 * exclusively (`O_EXCL`) with this process's pid, host, time and a nonce.
 *
 * Unlike `config.toml.lock`, which is held for microseconds and never taken over, this one is
 * held across a network request, so an abandoned lock is taken over: when its holder on this
 * host is gone, or when it is older than any holder could legitimately be (`staleMs`). The
 * takeover moves the lock aside under a unique name and checks that what it moved is the
 * lock it judged; if a live lock was moved instead (it replaced the stale one meanwhile), it
 * is put back with `link`, which never overwrites. Holders still re-read the stored login
 * after acquiring, so a refresh already done by another process is used, never repeated.
 */

export interface ProfileLockOptions {
  /** How long to wait for a live holder before giving up. */
  timeoutMs?: number;
  /** A lock older than this was abandoned (longer than any holder needs). */
  staleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a process of this host is running (`kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  host?: string;
}

/** The lock stayed held by a live process until the deadline. */
export class ProfileLockTimeout extends Error {
  constructor(
    readonly lockPath: string,
    readonly holderPid: number | null,
  ) {
    super(`Locked: ${lockPath}`);
    this.name = 'ProfileLockTimeout';
  }
}

/** Waiting longer than a holder may legitimately hold (one request plus a store write). */
export const DEFAULT_LOCK_TIMEOUT_MS = 45_000;
export const DEFAULT_LOCK_STALE_MS = 120_000;

export function profileLockPath(configDir: string, profile: string): string {
  const name = createHash('sha256').update(profile, 'utf8').digest('hex').slice(0, 32);
  return join(configDir, 'locks', `${name}.lock`);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Holder {
  pid: number;
  host: string;
  at: number;
}

function parseHolder(text: string): Holder | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.pid === 'number' &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.host === 'string' &&
      typeof value.at === 'number' &&
      Number.isFinite(value.at)
    ) {
      return { pid: value.pid, host: value.host, at: value.at };
    }
  } catch {
    // Being written right now, or not ours: judged by its age.
  }
  return null;
}

async function readLock(path: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(path, 'utf8'), fs.stat(path)]);
    return { text, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function createExclusive(path: string, content: string): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return true;
}

/** Moves a judged-stale lock aside; a live lock moved by mistake is put back. */
export async function takeOver(path: string, judged: string): Promise<void> {
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    await fs.rename(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await fs.readFile(aside, 'utf8').catch(() => null);
  if (moved !== judged) {
    // Not the lock that was judged: restore it unless a new lock exists by now.
    await fs.link(aside, path).catch(() => {});
  }
  await fs.rm(aside, { force: true });
}

/** Runs `fn` holding the profile's lock; always released (only if still ours). */
export async function withProfileLock<T>(
  configDir: string,
  profile: string,
  fn: () => Promise<T>,
  options: ProfileLockOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const isAlive = options.isAlive ?? defaultIsAlive;
  const host = options.host ?? hostname();
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const path = profileLockPath(configDir, profile);
  const record = JSON.stringify({ pid: process.pid, host, at: now(), id: randomUUID() });
  const deadline = now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    if (await createExclusive(path, record)) break;
    const seen = await readLock(path);
    if (seen === null) continue;
    const holder = parseHolder(seen.text);
    const age = now() - (holder?.at ?? seen.mtimeMs);
    const stale =
      Math.abs(age) > staleMs ||
      (holder !== null &&
        holder.host === host &&
        holder.pid !== process.pid &&
        !isAlive(holder.pid));
    if (stale) {
      await takeOver(path, seen.text);
      continue;
    }
    if (now() >= deadline) throw new ProfileLockTimeout(path, holder?.pid ?? null);
    await sleep(25 + Math.floor(Math.random() * 50));
  }
  try {
    return await fn();
  } finally {
    const current = await fs.readFile(path, 'utf8').catch(() => null);
    if (current === record) await fs.rm(path, { force: true }).catch(() => {});
  }
}

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/**
 * Runs `fn` with termination signals held back until it ends, then delivers the first one.
 * A refresh spends the old refresh token on the server: a process killed between that and
 * storing the new one (an MCP client's helper timeout, Ctrl-C) would leave only a spent token
 * behind, whose next use revokes the grant.
 */
export async function deferSignals<T>(fn: () => Promise<T>): Promise<T> {
  let received: NodeJS.Signals | null = null;
  const hold = (signal: NodeJS.Signals) => {
    received ??= signal;
  };
  for (const signal of SIGNALS) process.on(signal, hold);
  try {
    return await fn();
  } finally {
    for (const signal of SIGNALS) process.off(signal, hold);
    if (received !== null) process.kill(process.pid, received);
  }
}
