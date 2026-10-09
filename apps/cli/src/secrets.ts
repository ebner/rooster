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

/**
 * The keychain could not be read (locked, or its service is down), so whether it holds a
 * newer login is unknown. Reads fail closed rather than guess; retryable once it unlocks,
 * or with `ROOSTER_KEYRING=off` to use only the credentials file.
 */
export class CredentialStoreUnavailable extends Error {
  constructor() {
    super('The system keychain could not be read.');
    this.name = 'CredentialStoreUnavailable';
  }
}

/** Keychain and file kept changing while being read (another rooster process); retryable. */
export class CredentialsChanging extends Error {
  constructor() {
    super('Credentials are being changed by another rooster process.');
    this.name = 'CredentialsChanging';
  }
}

/** A keychain that exists but refused to store a login (locked, access denied). */
export class KeychainRefused extends Error {
  constructor(cause: unknown) {
    super((cause as Error)?.message ?? String(cause), { cause });
    this.name = 'KeychainRefused';
  }
}

/**
 * Whether a keychain error means there is no usable platform store at all (the backend
 * service can't be reached or isn't supported), as opposed to a store that refuses access.
 * `@napi-rs/keyring` reports both as generic errors, so this reads the message; anything not
 * recognised counts as a refusal, which fails closed.
 */
export function isStoreUnreachable(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return STORE_UNREACHABLE.some((re) => re.test(message));
}

const STORE_UNREACHABLE = [
  /org\.freedesktop\.DBus\.Error\.(ServiceUnknown|NoServer|NameHasNoOwner|NotSupported|Spawn\.\w+|NoReply|Disconnected|FileNotFound|BadAddress)/,
  /secret service/i,
  /org\.freedesktop\.secrets/,
  /D-?Bus (session )?(bus )?(is )?(not available|unavailable)|no D-?Bus/i,
  /DBUS_SESSION_BUS_ADDRESS/,
  /platform (is )?not supported|not supported on this platform/i,
  /\bKeyRevoked\b|\bKeyExpired\b/,
];

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
/** A keychain that exists but could not be read. */
const UNKNOWN: unique symbol = Symbol('unknown');

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
  /** This process found no usable platform store (see `keychain`). */
  private noStore = false;

  constructor(
    private readonly file: FileSecretStore,
    private readonly loadKeyringFn: () => Promise<KeyringFactory | null>,
    private readonly onFallback: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The profile's keychain entry, or null when there is no usable platform store: the addon
   * is missing, its backend can't be initialised (creating the entry throws, e.g. Linux
   * keyutils or Secret Service unavailable), or an earlier call in this process found it
   * unreachable. Remembered per process, so reads and writes agree.
   */
  private async keychain(profile: string): Promise<KeyringEntry | null> {
    if (this.noStore) return null;
    this.keyring ??= this.loadKeyringFn();
    const factory = await this.keyring;
    if (factory === null) return null;
    try {
      return factory(SERVICE, profile);
    } catch {
      this.noStore = true;
      return null;
    }
  }

  /**
   * The keychain's entry: `undefined` when it holds none, or when there is no keychain at all
   * (no native module, `ROOSTER_KEYRING=off`); `UNKNOWN` when a keychain exists but could
   * not be read. Unknown is never treated as empty.
   */
  private async keychainEntry(profile: string): Promise<Entry | undefined | typeof UNKNOWN> {
    let keychain: KeyringEntry | null;
    try {
      keychain = await this.keychain(profile);
    } catch {
      return UNKNOWN;
    }
    if (keychain === null) return undefined;
    let raw: string | undefined | null;
    try {
      raw = await keychain.getPassword();
    } catch (error) {
      if (isStoreUnreachable(error)) {
        this.noStore = true;
        return undefined;
      }
      // A store that exists but refuses this read (locked, denied): unknown, never empty.
      return UNKNOWN;
    }
    if (raw === undefined || raw === null || raw === '') return undefined;
    try {
      return parseEntry(JSON.parse(raw));
    } catch {
      // Not ours (or an unbound token): never sent anywhere.
      return undefined;
    }
  }

  /**
   * The newest of keychain and file. Reads never delete: a cleanup here could race with a
   * login in another process and erase it. A stale entry is harmless, since it always loses
   * on time, and the next login or logout replaces or clears it.
   *
   * The two stores can't be read atomically, so a login in another process between the two
   * reads could yield an obsolete pair: both are read again until two consecutive snapshots
   * agree. Fails closed: `CredentialsChanging` when they never settle, and
   * `CredentialStoreUnavailable` when the settled keychain state is unknown.
   */
  async get(profile: string): Promise<Credential | undefined> {
    let snapshot = await this.snapshot(profile);
    let settled = false;
    for (let attempt = 0; attempt < READ_ATTEMPTS && !settled; attempt++) {
      const again = await this.snapshot(profile);
      settled = again.key === snapshot.key;
      snapshot = again;
    }
    if (!settled) throw new CredentialsChanging();
    const { keychain, file } = snapshot;
    if (keychain === UNKNOWN) throw new CredentialStoreUnavailable();
    const winner =
      keychain !== undefined && (file === undefined || keychain.at > file.at) ? keychain : file;
    return isCredential(winner) ? winner : undefined;
  }

  private async snapshot(profile: string): Promise<{
    keychain: Entry | undefined | typeof UNKNOWN;
    file: Entry | undefined;
    key: string;
  }> {
    const keychain = await this.keychainEntry(profile);
    const file = this.file.entry(profile);
    const key = JSON.stringify([keychain === UNKNOWN ? '?' : (keychain ?? null), file ?? null]);
    return { keychain, file, key };
  }

  /** A write time newer than anything stored, even with a clock that went backwards. */
  private async nextAt(profile: string): Promise<number> {
    const keychain = await this.keychainEntry(profile);
    const file = this.file.entry(profile);
    const latest = Math.max(
      keychain === UNKNOWN || keychain === undefined ? 0 : keychain.at,
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
    const keychain = await this.keychain(profile);
    if (keychain !== null) {
      try {
        await keychain.setPassword(JSON.stringify(credential));
        // An older file entry is outranked anyway; remove it so the secret isn't kept twice,
        // but never one written since by another process.
        this.tryRemoveFileOlderThan(profile, credential.at);
        return 'keychain';
      } catch (error) {
        // A keychain that exists but refuses the write (locked, denied) would also refuse the
        // reads that decide which login is current: report it instead of a login no later
        // command could use.
        if (!isStoreUnreachable(error)) throw new KeychainRefused(error);
        this.noStore = true;
      }
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
    } catch (error) {
      // An unreachable store holds nothing this process could have written.
      if (isStoreUnreachable(error)) {
        this.noStore = true;
        return true;
      }
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
