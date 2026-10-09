import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from '@rooster/core/ids';
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

/**
 * A profile name as a file name: `p-` plus the lowercase hex of its UTF-8 bytes. Never a
 * separator or `.`/`..`, and `home` and `Home` stay apart on case-insensitive file systems.
 */
export function fileNameOf(profile: string): string {
  return `p-${Buffer.from(profile, 'utf8').toString('hex')}`;
}

/** Where a login was stored: what the profile records to find it again. */
export type SavedLogin = { store: 'keychain'; account: string } | { store: 'file' };

export class CredentialStore {
  readonly dir: string;
  private keyring: Promise<KeyringFactory | null> | undefined;

  constructor(
    readonly configDir: string,
    private readonly loadKeyringFn: () => Promise<KeyringFactory | null>,
  ) {
    this.dir = join(configDir, 'credentials.d');
  }

  /** `<config dir>/credentials.d/p-<hex>`: one file per profile, so profiles never collide. */
  pathOf(profile: string): string {
    return join(this.dir, fileNameOf(profile));
  }

  private async factory(): Promise<KeyringFactory | null> {
    this.keyring ??= this.loadKeyringFn();
    return this.keyring;
  }

  /**
   * Login. In the keychain, the new login is staged under a fresh account
   * (`<profile>:<uuid>`) and read back, so a refused login never touches the active one; the
   * caller publishes the account in the profile and then drops the previous one. The file is
   * used only when the keychain is provably absent (no addon, `ROOSTER_KEYRING=off`, or an
   * allowlisted error); a keychain that refuses is `KeychainRefused`.
   */
  async save(profile: string, login: StoredLogin): Promise<SavedLogin> {
    const factory = await this.factory();
    if (factory !== null) {
      const account = `${profile}:${uuidv7()}`;
      let entry: KeyringEntry | undefined;
      try {
        entry = factory(SERVICE, account);
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
          return { store: 'keychain', account };
        } catch (error) {
          await this.discardAccount(account);
          if (!isStoreAbsent(error, 'call')) throw new KeychainRefused(error);
        }
      }
    }
    writeFileAtomic(this.pathOf(profile), `${encode(login)}\n`, 0o600);
    return { store: 'file' };
  }

  /**
   * The login in the recorded store (the keychain account the profile records), or undefined
   * when it holds none. A keychain that can't be read is `CredentialStoreUnavailable`, never
   * a fallback to the file.
   */
  async load(
    profile: string,
    kind: StoreKind,
    account: string | undefined,
  ): Promise<StoredLogin | undefined> {
    if (kind === 'file') return decode(readIfExists(this.pathOf(profile)));
    if (account === undefined) return undefined;
    const factory = await this.factory();
    if (factory === null) throw new CredentialStoreUnavailable();
    try {
      return decode(await factory(SERVICE, account).getPassword());
    } catch (error) {
      throw new CredentialStoreUnavailable(error);
    }
  }

  /** Logout: removes the login from the recorded store, or throws `CredentialRemovalError`. */
  async remove(profile: string, kind: StoreKind, account: string | undefined): Promise<void> {
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
    if (account === undefined) return;
    const factory = await this.factory();
    if (factory === null) {
      throw new CredentialRemovalError('keychain', new Error('The keychain is not available.'));
    }
    try {
      await factory(SERVICE, account).deletePassword();
    } catch (error) {
      throw new CredentialRemovalError('keychain', error);
    }
  }

  /**
   * After a new login is published: removes what the profile pointed at before (another
   * keychain account, or the profile's file when the new login is in the keychain). False
   * when something could not be removed (the caller warns; it is no longer referenced).
   */
  async dropPrevious(
    profile: string,
    previous: { store?: StoreKind; account?: string },
    current: SavedLogin,
  ): Promise<boolean> {
    let ok = true;
    if (previous.store === 'keychain' && previous.account !== undefined) {
      const same = current.store === 'keychain' && current.account === previous.account;
      if (!same) ok = (await this.discardAccount(previous.account)) && ok;
    }
    if (current.store === 'keychain') {
      try {
        unlinkSync(this.pathOf(profile));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ok = false;
      }
    }
    return ok;
  }

  private async discardAccount(account: string): Promise<boolean> {
    try {
      const factory = await this.factory();
      if (factory === null) return false;
      await factory(SERVICE, account).deletePassword();
      return true;
    } catch {
      return false;
    }
  }
}
