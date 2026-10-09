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
 * Whether a keychain error proves there is no platform store to hold a login (an empty
 * keychain), as opposed to one that exists but can't be read now (unknown). `@napi-rs/keyring`
 * reports both as generic errors, so this matches exact message fragments on a strict
 * allowlist; refusals and anything unrecognised are unknown, which fails closed.
 * `KeyRevoked`/`KeyExpired` (Linux keyutils without a session keyring) count only when
 * creating the entry fails.
 */
export function isStoreAbsent(error: unknown, phase: 'construct' | 'call'): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  if (STORE_REFUSED.some((re) => re.test(message))) return false;
  if (phase === 'construct' && /\bKey(Revoked|Expired)\b/.test(message)) return true;
  return STORE_ABSENT.some((re) => re.test(message));
}

/** A store that exists but refuses or doesn't answer: never absent. */
const STORE_REFUSED = [
  /Secret Service: object locked/,
  /Secret Service: unlock prompt was dismissed/,
  /AccessDenied/,
  /Access is denied/i,
  /denied/i,
  /\bNoReply\b/,
  /\bDisconnected\b/,
  /time(d)? ?out/i,
];

/** The allowlist of "no store here" (Linux without a Secret Service or a D-Bus session). */
const STORE_ABSENT = [
  /org\.freedesktop\.DBus\.Error\.ServiceUnknown/,
  /org\.freedesktop\.DBus\.Error\.NameHasNoOwner/,
  /The name org\.freedesktop\.secrets was not provided by any \.service files/,
  /DBUS_SESSION_BUS_ADDRESS/,
  /Failed to connect to socket/,
  /org\.freedesktop\.DBus\.Error\.Spawn\.\w+/,
  /platform not supported/i,
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

/** The keychain for one profile: an entry, no store at all, or a store that can't be used now. */
type Opened =
  | { kind: 'entry'; entry: KeyringEntry }
  | { kind: 'absent' }
  | { kind: 'unknown'; error: unknown };

/**
 * Keychain first, file second, newest wins (a tie goes to the file, where logout tombstones
 * live). Every entry carries its write time. Reads never delete and fail closed when the
 * keychain's state is unknown. `onFallback` fires when a login has to use the file.
 *
 * Only permanent absence is cached for the process (no addon, `ROOSTER_KEYRING=off`); a
 * missing D-Bus or Secret Service is probed again on every read, so a store that comes back
 * is seen at once.
 */
export class LayeredSecretStore implements SecretStore {
  private keyring: Promise<KeyringFactory | null> | undefined;

  constructor(
    private readonly file: FileSecretStore,
    private readonly loadKeyringFn: () => Promise<KeyringFactory | null>,
    private readonly onFallback: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  private async open(profile: string): Promise<Opened> {
    this.keyring ??= this.loadKeyringFn();
    const factory = await this.keyring;
    if (factory === null) return { kind: 'absent' };
    try {
      return { kind: 'entry', entry: factory(SERVICE, profile) };
    } catch (error) {
      return isStoreAbsent(error, 'construct') ? { kind: 'absent' } : { kind: 'unknown', error };
    }
  }

  /** The keychain's entry: `undefined` when it holds none or there is no store; else `UNKNOWN`. */
  private async keychainEntry(profile: string): Promise<Entry | undefined | typeof UNKNOWN> {
    const opened = await this.open(profile);
    if (opened.kind === 'absent') return undefined;
    if (opened.kind === 'unknown') return UNKNOWN;
    let raw: string | undefined | null;
    try {
      raw = await opened.entry.getPassword();
    } catch (error) {
      return isStoreAbsent(error, 'call') ? undefined : UNKNOWN;
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

  /**
   * Login. To the keychain when there is one; to the file (with the notice) only when there
   * is provably no store. A store that exists but refuses (locked, denied, unrecognised)
   * would also refuse the reads that decide which login is current, so that is
   * `KeychainRefused` rather than a login no later command could use.
   */
  async set(profile: string, token: string, server: string): Promise<'keychain' | 'file'> {
    const credential: Credential = {
      token,
      server: serverOrigin(server),
      at: await this.nextAt(profile),
    };
    const opened = await this.open(profile);
    if (opened.kind === 'unknown') throw new KeychainRefused(opened.error);
    if (opened.kind === 'entry') {
      try {
        await opened.entry.setPassword(JSON.stringify(credential));
        // An older file entry (or tombstone) is outranked anyway; remove it so the secret
        // isn't kept twice, but never one written since by another process.
        this.tryRemoveFileOlderThan(profile, credential.at);
        return 'keychain';
      } catch (error) {
        if (!isStoreAbsent(error, 'call')) throw new KeychainRefused(error);
      }
    }
    this.onFallback();
    this.file.put(profile, credential);
    return 'file';
  }

  /**
   * Logout. A tombstone newer than every stored entry goes to the file first, so the login
   * stays gone even if a keychain entry this process can't delete (or can't see) comes back.
   * Then the keychain entry is deleted where possible. Succeeds only with a durable
   * tombstone, or a confirmed keychain delete and no credential left in the file; else
   * `CredentialRemovalError` (e.g. a read-only config directory).
   */
  async delete(profile: string): Promise<void> {
    const at = await this.nextAt(profile);
    let tombstoned = false;
    let failure: unknown;
    try {
      this.file.put(profile, { deleted: true, at });
      tombstoned = isTombstoneAtLeast(this.file.entry(profile), at);
    } catch (error) {
      failure = error;
    }
    const keychainCleared = await this.tryDeleteKeychain(profile);
    if (tombstoned) return;
    if (keychainCleared && !isCredential(this.file.entry(profile))) return;
    throw new CredentialRemovalError(this.file.path, failure ?? new Error('not removed'));
  }

  /**
   * True only when the keychain provably holds nothing afterwards: no store at all for good
   * (no addon, `ROOSTER_KEYRING=off`) or a delete that succeeded. A delete that fails for any
   * reason, a missing Secret Service included, is unconfirmed.
   */
  private async tryDeleteKeychain(profile: string): Promise<boolean> {
    this.keyring ??= this.loadKeyringFn();
    if ((await this.keyring) === null) return true;
    const opened = await this.open(profile);
    if (opened.kind !== 'entry') return false;
    try {
      await opened.entry.deletePassword();
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
