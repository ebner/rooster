import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';
import type { Io } from './io.ts';

/** One `[profiles.<name>]` table (07 §2). */
export interface Profile {
  server?: string;
  /** Default org slug. */
  org?: string;
  /** `en` or `sv`; falls back to the server user setting, then `$LANG`. */
  locale?: string;
  /** Who the stored credential belongs to, for display only. */
  user?: string;
  /** Where this profile's login is stored (set by login, cleared by logout). */
  credential_store?: 'keychain' | 'file';
  /** The server origin the login was issued by; it is only ever sent there. */
  credential_origin?: string;
  /** The keychain account holding the login (`<profile>:<uuid>`), with `credential_store = "keychain"`. */
  credential_account?: string;
}

export interface Config {
  default_profile?: string;
  profiles: Record<string, Profile>;
}

export const PROFILE_KEYS = ['server', 'org', 'locale'] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export const DEFAULT_PROFILE = 'default';

type Env = Io['env'];

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** `$XDG_CONFIG_HOME/rooster`, `~/.config/rooster`, or `%APPDATA%\rooster` on Windows. */
export function configDir(env: Env, platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') {
    return join(nonEmpty(env.APPDATA) ?? join(home, 'AppData', 'Roaming'), 'rooster');
  }
  return join(nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, '.config'), 'rooster');
}

/** Small mutable state (`@last`, notices): `$XDG_STATE_HOME/rooster` (`%LOCALAPPDATA%`). */
export function stateDir(env: Env, platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') {
    return join(nonEmpty(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local'), 'rooster');
  }
  return join(nonEmpty(env.XDG_STATE_HOME) ?? join(home, '.local', 'state'), 'rooster');
}

/** Disposable caches (completion names): `$XDG_CACHE_HOME/rooster`. */
export function cacheDir(env: Env, platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') {
    return join(nonEmpty(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local'), 'rooster', 'cache');
  }
  return join(nonEmpty(env.XDG_CACHE_HOME) ?? join(home, '.cache'), 'rooster');
}

/**
 * Writes `path` atomically: a sibling temp file with the final mode, then a rename, so a
 * reader never sees half a file and a secret is never briefly world-readable.
 */
export function writeFileAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Reads a file, or undefined when it does not exist. */
export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function asProfile(value: unknown): Profile {
  const out: Profile = {};
  if (value === null || typeof value !== 'object') return out;
  const record = value as Record<string, unknown>;
  for (const key of [...PROFILE_KEYS, 'user', 'credential_origin', 'credential_account'] as const) {
    if (typeof record[key] === 'string') out[key] = record[key];
  }
  if (record.credential_store === 'keychain' || record.credential_store === 'file') {
    out.credential_store = record.credential_store;
  }
  return out;
}

export function parseConfig(text: string, path: string): Config {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new CliError(EXIT.usage, `${path}: ${(error as Error).message}`);
  }
  const profiles: Record<string, Profile> = {};
  const table = raw.profiles;
  if (table !== null && typeof table === 'object') {
    for (const [name, value] of Object.entries(table)) profiles[name] = asProfile(value);
  }
  return {
    ...(typeof raw.default_profile === 'string' ? { default_profile: raw.default_profile } : {}),
    profiles,
  };
}

export function serializeConfig(config: Config): string {
  const profiles: Record<string, Profile> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    const clean = Object.fromEntries(
      Object.entries(profile).filter(([, v]) => v !== undefined && v !== ''),
    );
    profiles[name] = clean;
  }
  return `${stringify({
    ...(config.default_profile === undefined ? {} : { default_profile: config.default_profile }),
    profiles,
  })}\n`;
}

export interface LockOptions {
  /** How long to wait for another process's lock before giving up. */
  timeoutMs?: number;
  /** A lock older than this whose process is gone is taken over. */
  staleMs?: number;
}

/** Another rooster process holds the config lock (or left it behind, still running). */
export class ConfigLockedError extends Error {
  constructor(readonly lockPath: string) {
    super(`Locked: ${lockPath}`);
    this.name = 'ConfigLockedError';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock left by a process that is gone, older than `staleMs`. */
function isStale(content: string | undefined, lockPath: string, staleMs: number): boolean {
  const [pidText, timeText] = (content ?? '').split(' ');
  const pid = Number(pidText);
  let time = Number(timeText);
  if (!Number.isFinite(time)) {
    try {
      time = statSync(lockPath).mtimeMs;
    } catch {
      return false;
    }
  }
  if (Date.now() - time < staleMs) return false;
  return !(Number.isInteger(pid) && pid > 0 && processAlive(pid));
}

/**
 * Runs `fn` holding an interprocess lock on `path`: `<path>.lock`, created exclusively
 * (`O_EXCL`) with this process's pid and the time, waited for with a bounded retry, taken
 * over when stale (its process gone, older than `staleMs`), and always released.
 */
export function withFileLock<T>(path: string, fn: () => T, options: LockOptions = {}): T {
  const lockPath = `${path}.lock`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 10_000;
  const id = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      writeFileSync(lockPath, id, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const seen = readIfExists(lockPath);
    if (isStale(seen, lockPath, staleMs)) {
      // Take over by moving the stale lock aside, then check it was the one judged stale;
      // if another process replaced it meanwhile, put that one back.
      const aside = `${lockPath}.${process.pid}.${Date.now()}.stale`;
      try {
        renameSync(lockPath, aside);
        if (readIfExists(aside) !== seen) {
          try {
            linkSync(aside, lockPath);
          } catch {
            // Someone holds the lock again; we keep waiting below.
          }
        }
        rmSync(aside, { force: true });
      } catch {
        // Gone already: try again.
      }
      continue;
    }
    if (Date.now() > deadline) throw new ConfigLockedError(lockPath);
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
  try {
    return fn();
  } finally {
    try {
      if (readIfExists(lockPath) === id) rmSync(lockPath, { force: true });
    } catch {
      // Released enough: a lock that isn't ours is never removed.
    }
  }
}

/** `config.toml` plus the profile resolution rules (07 §2: flag, env, file). */
export class ConfigStore {
  readonly path: string;
  private cached: Config | undefined;

  constructor(
    readonly dir: string,
    private readonly lockOptions: LockOptions = {},
  ) {
    this.path = join(dir, 'config.toml');
  }

  read(): Config {
    if (this.cached === undefined) {
      const text = readIfExists(this.path);
      this.cached = text === undefined ? { profiles: {} } : parseConfig(text, this.path);
    }
    return this.cached;
  }

  /** Re-reads the file now (another process may have changed it). */
  reload(): Config {
    this.cached = undefined;
    return this.read();
  }

  /**
   * Read-modify-write under the interprocess lock: the file is read fresh inside the lock,
   * changed, and written atomically, so concurrent rooster processes never lose each other's
   * updates. Keep `change` small and free of I/O.
   */
  update(change: (config: Config) => Config): Config {
    return withFileLock(
      this.path,
      () => {
        const next = change(this.reload());
        writeFileAtomic(this.path, serializeConfig(next), 0o600);
        this.cached = next;
        return next;
      },
      this.lockOptions,
    );
  }

  /** `update` for one profile (created when missing). */
  updateProfile(name: string, change: (profile: Profile) => Profile): Profile {
    let next: Profile = {};
    this.update((config) => {
      next = change({ ...(config.profiles[name] ?? {}) });
      return { ...config, profiles: { ...config.profiles, [name]: next } };
    });
    return next;
  }
}

/** `--profile`, then `ROOSTER_PROFILE`, then `default_profile`, then `default`. */
export function resolveProfileName(flag: string | undefined, env: Env, config: Config): string {
  return (
    nonEmpty(flag) ?? nonEmpty(env.ROOSTER_PROFILE) ?? config.default_profile ?? DEFAULT_PROFILE
  );
}

/** A server URL without a trailing slash; http(s) only. */
export function normalizeServer(input: string): string {
  const text = input.trim();
  const bad = () => new CliError(EXIT.usage, t('config.badServer', { value: input }));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) throw bad();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw bad();
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw bad();
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
