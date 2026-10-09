import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { readIfExists, writeFileAtomic } from './config.ts';

/**
 * A stored login: the token, the server origin it belongs to (it is only ever sent there),
 * and when it was written, so the newer of keychain and file wins.
 */
export interface Credential {
  token: string;
  /** The server's origin, e.g. `https://rooster.example.com`. */
  server: string;
  /** ms epoch; higher is newer. */
  at: number;
}

/**
 * One store's view of a profile: a credential, or a logout tombstone (the logout could not
 * reach the other store, so this says "nothing, as of `at`").
 */
type Entry = Credential | { deleted: true; at: number };

const isCredential = (entry: Entry | undefined): entry is Credential =>
  entry !== undefined && !('deleted' in entry);

function isTombstoneAtLeast(entry: Entry | undefined, at: number): boolean {
  return entry !== undefined && 'deleted' in entry && entry.at >= at;
}

/** A logout that could not make the stored login unusable locally. */
export class CredentialRemovalError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super((cause as NodeJS.ErrnoException)?.message ?? String(cause), { cause });
    this.name = 'CredentialRemovalError';
  }
}

/** Where a profile's login is kept (07 §2). */
export interface SecretStore {
  get(profile: string): Promise<Credential | undefined>;
  set(profile: string, token: string, server: string): Promise<'keychain' | 'file'>;
  delete(profile: string): Promise<void>;
}

const SERVICE = 'rooster';
/** Snapshot re-reads before a credential read settles (see `get`). */
const READ_ATTEMPTS = 5;

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
type KeyringFactory = (service: string, account: string) => KeyringEntry;

/**
 * The OS keychain through `@napi-rs/keyring`, imported lazily: a compiled binary or a host
 * without a native build (or without a Secret Service, as in headless Linux and containers)
 * falls back to the credentials file. Null when the module cannot be loaded.
 */
export async function loadKeyring(): Promise<KeyringFactory | null> {
  try {
    const mod = await import('@napi-rs/keyring');
    return (service, account) => new mod.AsyncEntry(service, account);
  } catch {
    return null;
  }
}

/** The origin a credential is bound to (`https://host[:port]`). */
export function serverOrigin(server: string): string {
  return new URL(server).origin;
}

function parseEntry(value: unknown): Entry | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0;
  if (v.deleted === true) return { deleted: true, at };
  if (typeof v.token !== 'string' || v.token === '' || typeof v.server !== 'string') {
    return undefined;
  }
  return { token: v.token, server: v.server, at };
}

/** `credentials` next to `config.toml`, mode 0600: `[profiles.<name>] token, server, at`. */
export class FileSecretStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, 'credentials');
  }

  private read(): Record<string, Record<string, unknown>> {
    const text = readIfExists(this.path);
    if (text === undefined) return {};
    try {
      const raw = parse(text) as { profiles?: Record<string, Record<string, unknown>> };
      return raw.profiles ?? {};
    } catch {
      return {};
    }
  }

  private write(profiles: Record<string, Record<string, unknown>>): void {
    writeFileAtomic(this.path, `${stringify({ profiles })}\n`, 0o600);
  }

  entry(profile: string): Entry | undefined {
    return parseEntry(this.read()[profile]);
  }

  put(profile: string, entry: Entry): void {
    this.write({ ...this.read(), [profile]: { ...entry } });
  }

  remove(profile: string): void {
    const profiles = this.read();
    if (!(profile in profiles)) return;
    delete profiles[profile];
    this.write(profiles);
  }
}

/**
 * Keychain first, file second, newest wins. A login or logout that had to use the file while
 * the keychain was locked stays authoritative: every entry carries its write time, a logout
 * that cannot clear the keychain leaves a tombstone in the file, and a read removes the
 * stale side when it can. `onFallback` fires when a login had to use the file.
 */
export class LayeredSecretStore implements SecretStore {
  private keyring: Promise<KeyringFactory | null> | undefined;

  constructor(
    private readonly file: FileSecretStore,
    private readonly loadKeyringFn: () => Promise<KeyringFactory | null>,
    private readonly onFallback: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  private keychain(profile: string): Promise<KeyringEntry | null> {
    this.keyring ??= this.loadKeyringFn();
    return this.keyring.then((factory) => (factory === null ? null : factory(SERVICE, profile)));
  }

  /** The keychain's entry; `undefined` when empty, `'unavailable'` when it can't be read. */
  private async keychainEntry(profile: string): Promise<Entry | undefined | 'unavailable'> {
    try {
      const keychain = await this.keychain(profile);
      if (keychain === null) return 'unavailable';
      const raw = await keychain.getPassword();
      if (raw === undefined || raw === null || raw === '') return undefined;
      try {
        return parseEntry(JSON.parse(raw));
      } catch {
        // Not ours (or an unbound token): never sent anywhere.
        return undefined;
      }
    } catch {
      return 'unavailable';
    }
  }

  /**
   * The newest of keychain and file. Reads never delete: a cleanup here could race with a
   * login in another process and erase it. A stale entry is harmless, since it always loses
   * on time, and the next login or logout replaces or clears it.
   *
   * The two stores can't be read atomically, so a login in another process between the two
   * reads could yield an obsolete pair. Both are read again until two snapshots agree
   * (bounded); the newest entry of a stable snapshot wins.
   */
  async get(profile: string): Promise<Credential | undefined> {
    let snapshot = await this.snapshot(profile);
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const again = await this.snapshot(profile);
      if (again.key === snapshot.key) break;
      snapshot = again;
    }
    const { keychain, file } = snapshot;
    const winner =
      keychain !== undefined && (file === undefined || keychain.at > file.at) ? keychain : file;
    return isCredential(winner) ? winner : undefined;
  }

  private async snapshot(profile: string) {
    const fromKeychain = await this.keychainEntry(profile);
    const keychain = fromKeychain === 'unavailable' ? undefined : fromKeychain;
    const file = this.file.entry(profile);
    return { keychain, file, key: JSON.stringify([fromKeychain ?? null, file ?? null]) };
  }

  /** A write time newer than anything stored, even with a clock that went backwards. */
  private async nextAt(profile: string): Promise<number> {
    const keychain = await this.keychainEntry(profile);
    const file = this.file.entry(profile);
    const latest = Math.max(
      keychain === 'unavailable' || keychain === undefined ? 0 : keychain.at,
      file?.at ?? 0,
    );
    return Math.max(this.now(), latest + 1);
  }

  async set(profile: string, token: string, server: string): Promise<'keychain' | 'file'> {
    const credential: Credential = {
      token,
      server: serverOrigin(server),
      at: await this.nextAt(profile),
    };
    try {
      const keychain = await this.keychain(profile);
      if (keychain !== null) {
        await keychain.setPassword(JSON.stringify(credential));
        // An older file entry is outranked anyway; remove it so the secret isn't kept twice,
        // but never one written since by another process.
        this.tryRemoveFileOlderThan(profile, credential.at);
        return 'keychain';
      }
    } catch {
      // Fall through to the file.
    }
    this.onFallback();
    this.file.put(profile, credential);
    return 'file';
  }

  /**
   * Logout. Succeeds only when no read can return the login afterwards: the keychain entry
   * is gone and the file entry removed, or a tombstone that outranks both is written. Else it
   * throws `CredentialRemovalError` (e.g. a read-only config directory).
   */
  async delete(profile: string): Promise<void> {
    const at = await this.nextAt(profile);
    const cleared = await this.tryDeleteKeychain(profile);
    try {
      if (cleared) {
        const entry = this.file.entry(profile);
        // A newer login from another process is left alone.
        if (entry !== undefined && entry.at < at) this.file.remove(profile);
      } else {
        // The keychain may still hold the login: a tombstone outranks it until it can go.
        this.file.put(profile, { deleted: true, at });
      }
    } catch (error) {
      // If a tombstone did get written durably, reads return nothing: that's a logout.
      if (isTombstoneAtLeast(this.file.entry(profile), at)) return;
      throw new CredentialRemovalError(this.file.path, error);
    }
  }

  /** True when the keychain holds nothing for the profile afterwards. */
  private async tryDeleteKeychain(profile: string): Promise<boolean> {
    try {
      const keychain = await this.keychain(profile);
      if (keychain === null) return true;
      await keychain.deletePassword();
      return true;
    } catch {
      return false;
    }
  }

  private tryRemoveFileOlderThan(profile: string, at: number): void {
    try {
      const entry = this.file.entry(profile);
      if (entry !== undefined && entry.at < at) this.file.remove(profile);
    } catch {
      // A read-only home: the newer entry still wins on every read.
    }
  }
}
