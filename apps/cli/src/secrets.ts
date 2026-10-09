import { rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { readIfExists, writeFileAtomic } from './config.ts';

/**
 * Where a profile's login lives (07 §2). Exactly one store per profile, chosen at login and
 * recorded in the profile (`credential_store`): the OS keychain when it works, else (only
 * when the keychain is provably absent) a file of its own. Reads use only the recorded store,
 * so there is nothing to merge between stores or processes.
 */
export type StoreKind = 'keychain' | 'file';

/** A stored login: the token and the server origin it was issued by (sent only there). */
export interface StoredLogin {
  token: string;
  server: string;
}

/** The recorded keychain can't be read (locked, denied, gone): never a fallback to a file. */
export class CredentialStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('The system keychain could not be read.', { cause });
    this.name = 'CredentialStoreUnavailable';
  }
}

/** A keychain that exists but would not store (or return) a login at login time. */
export class KeychainRefused extends Error {
  constructor(cause: unknown) {
    super((cause as Error)?.message ?? String(cause), { cause });
    this.name = 'KeychainRefused';
  }
}

/** A logout that could not remove the login from its store. `where` names the store. */
export class CredentialRemovalError extends Error {
  constructor(
    readonly where: string,
    cause: unknown,
  ) {
    super((cause as Error)?.message ?? String(cause), { cause });
    this.name = 'CredentialRemovalError';
  }
}

/**
 * Whether a keychain error proves there is no platform store at all, so a login may use a
 * file instead. Decided only at login. A strict allowlist of exact message fragments, checked
 * after the refusals; anything else (a locked or denied store, a bus outage, an unknown
 * message) is not absence. `KeyRevoked`/`KeyExpired` (Linux keyutils without a session
 * keyring) count only when creating the entry fails.
 */
export function isStoreAbsent(error: unknown, phase: 'construct' | 'call'): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  if (STORE_REFUSED.some((re) => re.test(message))) return false;
  if (phase === 'construct' && /\bKey(Revoked|Expired)\b/.test(message)) return true;
  return STORE_ABSENT.some((re) => re.test(message));
}

const STORE_REFUSED = [
  /Secret Service: object locked/,
  /Secret Service: unlock prompt was dismissed/,
  /AccessDenied/,
  /Access is denied/i,
  /denied/i,
  /\bNoReply\b/,
  /\bDisconnected\b/,
  /time(d)? ?out/i,
  /Connection refused/i,
];

const STORE_ABSENT = [
  /org\.freedesktop\.DBus\.Error\.ServiceUnknown/,
  /org\.freedesktop\.DBus\.Error\.NameHasNoOwner/,
  /The name org\.freedesktop\.secrets was not provided by any \.service files/,
  /DBUS_SESSION_BUS_ADDRESS/,
  /org\.freedesktop\.DBus\.Error\.Spawn\.\w+/,
  /platform not supported/i,
];

const SERVICE = 'rooster';

interface KeyringEntry {
  getPassword(): Promise<string | undefined | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export type KeyringFactory = (service: string, account: string) => KeyringEntry;

/**
 * The OS keychain through `@napi-rs/keyring`, imported lazily: a compiled binary or a host
 * without the native build gets null (no keychain).
 */
export async function loadKeyring(): Promise<KeyringFactory | null> {
  try {
    const mod = await import('@napi-rs/keyring');
    return (service, account) => new mod.AsyncEntry(service, account);
  } catch {
    return null;
  }
}

/** The origin a login is bound to (`https://host[:port]`). */
export function serverOrigin(server: string): string {
  return new URL(server).origin;
}

function encode(login: StoredLogin): string {
  return JSON.stringify({ token: login.token, server: login.server });
}

function decode(raw: string | undefined | null): StoredLogin | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.token === 'string' && value.token !== '' && typeof value.server === 'string') {
      return { token: value.token, server: value.server };
    }
  } catch {
    // Not ours: never sent anywhere.
  }
  return undefined;
}

/** A profile name as a file name: no separators, no `.`/`..`. */
function fileNameOf(profile: string): string {
  return encodeURIComponent(profile).replace(/\./g, '%2E');
}

export class CredentialStore {
  readonly dir: string;
  private keyring: Promise<KeyringFactory | null> | undefined;

  constructor(
    readonly configDir: string,
    private readonly loadKeyringFn: () => Promise<KeyringFactory | null>,
  ) {
    this.dir = join(configDir, 'credentials.d');
  }

  /** `<config dir>/credentials.d/<profile>`: one file per profile, so profiles never collide. */
  pathOf(profile: string): string {
    return join(this.dir, fileNameOf(profile));
  }

  private async factory(): Promise<KeyringFactory | null> {
    this.keyring ??= this.loadKeyringFn();
    return this.keyring;
  }

  /**
   * Login: the keychain when a write and its read-back succeed; the file only when the
   * keychain is provably absent (no addon, `ROOSTER_KEYRING=off`, or an allowlisted error);
   * otherwise `KeychainRefused`. Returns the store to record in the profile.
   */
  async save(profile: string, login: StoredLogin): Promise<StoreKind> {
    const factory = await this.factory();
    if (factory !== null) {
      let entry: KeyringEntry | undefined;
      try {
        entry = factory(SERVICE, profile);
      } catch (error) {
        if (!isStoreAbsent(error, 'construct')) throw new KeychainRefused(error);
      }
      if (entry !== undefined) {
        try {
          await entry.setPassword(encode(login));
          const back = decode(await entry.getPassword());
          if (back?.token !== login.token || back.server !== login.server) {
            throw new Error('The keychain did not return the stored login.');
          }
          // A login from an earlier file-backed session must not linger on disk.
          this.removeFileQuietly(profile);
          return 'keychain';
        } catch (error) {
          if (!isStoreAbsent(error, 'call')) throw new KeychainRefused(error);
        }
      }
    }
    writeFileAtomic(this.pathOf(profile), `${encode(login)}\n`, 0o600);
    return 'file';
  }

  /**
   * The login in the recorded store, or undefined when that store holds none. A keychain
   * that can't be read is an error (`CredentialStoreUnavailable`), never a fallback.
   */
  async load(profile: string, kind: StoreKind): Promise<StoredLogin | undefined> {
    if (kind === 'file') return decode(readIfExists(this.pathOf(profile)));
    const factory = await this.factory();
    if (factory === null) throw new CredentialStoreUnavailable();
    try {
      return decode(await factory(SERVICE, profile).getPassword());
    } catch (error) {
      throw new CredentialStoreUnavailable(error);
    }
  }

  /** Logout: removes the login from the recorded store, or throws `CredentialRemovalError`. */
  async remove(profile: string, kind: StoreKind): Promise<void> {
    if (kind === 'file') {
      try {
        unlinkSync(this.pathOf(profile));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CredentialRemovalError(this.pathOf(profile), error);
        }
      }
      return;
    }
    const factory = await this.factory();
    if (factory === null) {
      throw new CredentialRemovalError('keychain', new Error('The keychain is not available.'));
    }
    try {
      await factory(SERVICE, profile).deletePassword();
    } catch (error) {
      throw new CredentialRemovalError('keychain', error);
    }
  }

  private removeFileQuietly(profile: string): void {
    try {
      unlinkSync(this.pathOf(profile));
    } catch {
      // Not there, or unwritable: the profile records the keychain, so it is never read.
    }
  }

  /**
   * The shared `credentials` file of earlier builds (`[profiles.<name>] token, server`):
   * moves every login into its own file and deletes the old file. Idempotent, so two
   * processes migrating at once write the same files. Returns this profile's login, if any.
   */
  migrateLegacy(profile: string): StoredLogin | undefined {
    const legacy = join(this.configDir, 'credentials');
    const text = readIfExists(legacy);
    if (text === undefined) return undefined;
    let profiles: Record<string, Record<string, unknown>> = {};
    try {
      profiles = ((parse(text) as { profiles?: typeof profiles }).profiles ??
        {}) as typeof profiles;
    } catch {
      // Unreadable: nothing to migrate.
    }
    let mine: StoredLogin | undefined;
    for (const [name, value] of Object.entries(profiles)) {
      const login =
        typeof value.token === 'string' && value.token !== '' && typeof value.server === 'string'
          ? { token: value.token, server: serverOrigin(value.server) }
          : undefined;
      if (login === undefined) continue;
      if (readIfExists(this.pathOf(name)) === undefined) {
        writeFileAtomic(this.pathOf(name), `${encode(login)}\n`, 0o600);
      }
      if (name === profile) mine = login;
    }
    rmSync(legacy, { force: true });
    return mine;
  }
}
