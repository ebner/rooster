import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const key of [...PROFILE_KEYS, 'user', 'credential_origin'] as const) {
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

/** `config.toml` plus the profile resolution rules (07 §2: flag, env, file). */
export class ConfigStore {
  readonly path: string;
  private cached: Config | undefined;

  constructor(readonly dir: string) {
    this.path = join(dir, 'config.toml');
  }

  read(): Config {
    if (this.cached === undefined) {
      const text = readIfExists(this.path);
      this.cached = text === undefined ? { profiles: {} } : parseConfig(text, this.path);
    }
    return this.cached;
  }

  write(config: Config): void {
    writeFileAtomic(this.path, serializeConfig(config), 0o600);
    this.cached = config;
  }

  /**
   * Applies `change` to one profile (created when missing) and saves atomically. Reads the
   * file fresh first, so another process's change to another profile is kept.
   */
  updateProfile(name: string, change: (profile: Profile) => Profile): Profile {
    this.cached = undefined;
    const config = this.read();
    const next = change({ ...(config.profiles[name] ?? {}) });
    this.write({ ...config, profiles: { ...config.profiles, [name]: next } });
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
