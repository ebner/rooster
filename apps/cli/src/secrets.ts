import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GRANT_SCOPES, type GrantScope } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import { isBearerToken } from './api.ts';
import { readIfExists, writeFileAtomic } from './config.ts';
import { AUDIENCES, type Audience } from './oauth.ts';

/**
 * Where a profile's login lives (07 §2). Exactly one store per profile, chosen at login and
 * recorded in the profile (`credential_store`): the OS keychain when it works, else (only
 * when the keychain is provably absent) a file of its own. Reads use only the recorded store,
 * so there is nothing to merge between stores or processes.
 */
export type StoreKind = 'keychain' | 'file';

/**
 * A stored login: the token and the server origin it was issued by (sent only there).
 * - A bearer session from the legacy device flow, or a PAT (`login --with-token`): `token`
 *   alone, used as it is until revoked (the format of 1.7 and earlier, read unchanged).
 * - An OAuth login through the device grant (11 §9.6): `token` is the current access token,
 *   and `oauth` holds the rotating refresh token, the access token's expiry and the resource
 *   (audience) both are bound to.
 */
export interface StoredLogin {
  token: string;
  server: string;
  oauth?: OAuthLogin;
}

export interface OAuthLogin {
  refreshToken: string;
  /** Epoch ms when `token` expires. */
  expiresAt: number;
  audience: Audience;
  /** The exact `resource` the tokens were issued for (sent with every refresh). */
  resource: string;
  /** The capabilities granted, as the token endpoint reported them. */
  scopes: GrantScope[];
}

/** The recorded keychain can't be read (locked, denied, gone): never a fallback to a file. */
export class CredentialStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('The system keychain could not be read.', { cause });
    this.name = 'CredentialStoreUnavailable';
  }
}

/** A profile's login kept changing while it was read (other rooster processes); retryable. */
export class CredentialsChanging extends Error {
  constructor() {
    super('The stored login is being changed by another rooster process.');
    this.name = 'CredentialsChanging';
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

/**
 * The stored text. A bearer login keeps the 1.7 shape `{token, server}`; an OAuth login is
 * `{v: 2, kind: "oauth", token, server, refreshToken, expiresAt, audience, resource, scopes}`,
 * so an older CLI reading it still finds `token` (the access token) and fails cleanly once it
 * expires.
 */
export function encodeLogin(login: StoredLogin): string {
  if (login.oauth === undefined)
    return JSON.stringify({ token: login.token, server: login.server });
  const { refreshToken, expiresAt, audience, resource, scopes } = login.oauth;
  return JSON.stringify({
    v: 2,
    kind: 'oauth',
    token: login.token,
    server: login.server,
    refreshToken,
    expiresAt,
    audience,
    resource,
    scopes,
  });
}

function decodeOAuth(value: Record<string, unknown>): OAuthLogin | undefined {
  const { refreshToken, expiresAt, audience, resource, scopes } = value;
  if (
    typeof refreshToken !== 'string' ||
    !isBearerToken(refreshToken) ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    !AUDIENCES.includes(audience as Audience) ||
    typeof resource !== 'string' ||
    !Array.isArray(scopes)
  ) {
    return undefined;
  }
  return {
    refreshToken,
    expiresAt,
    audience: audience as Audience,
    resource,
    scopes: GRANT_SCOPES.filter((s) => scopes.includes(s)),
  };
}

export function decodeLogin(raw: string | undefined | null): StoredLogin | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.token !== 'string' || value.token === '' || typeof value.server !== 'string') {
      return undefined;
    }
    if (value.kind === undefined && value.v === undefined) {
      return { token: value.token, server: value.server };
    }
    // A newer format this CLI doesn't know, or a broken one: never guessed at.
    if (value.v !== 2 || value.kind !== 'oauth') return undefined;
    const oauth = decodeOAuth(value);
    return oauth === undefined ? undefined : { token: value.token, server: value.server, oauth };
  } catch {
    // Not ours: never sent anywhere.
  }
  return undefined;
}

function sameLogin(a: StoredLogin | undefined, b: StoredLogin): boolean {
  return a !== undefined && encodeLogin(a) === encodeLogin(b);
}

/** A stored login's exact identity: the store and the one ref (account or file) holding it. */
export interface CredentialRef {
  store: StoreKind;
  /** Keychain: the account `<profile>:<uuidv7>`. File: the name `<32 hex>-<uuidv7>`. */
  ref: string;
}

const FILE_REF = /^[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A fresh file name for one login generation of `profile`: the first 32 hex digits of the
 * name's SHA-256 (bounded, case-safe, no separators) and a UUIDv7. 69 characters, which
 * leaves room for the temp suffix of the atomic write.
 */
export function newFileRef(profile: string): string {
  return `${createHash('sha256').update(profile, 'utf8').digest('hex').slice(0, 32)}-${uuidv7()}`;
}

export function isFileRef(ref: string): boolean {
  return FILE_REF.test(ref);
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

  /** The file of a file ref; refs that aren't ours (a tampered config) never become paths. */
  pathOf(ref: string): string {
    if (!isFileRef(ref)) throw new Error(`Not a credential file ref: ${ref}`);
    return join(this.dir, ref);
  }

  private async factory(): Promise<KeyringFactory | null> {
    this.keyring ??= this.loadKeyringFn();
    return this.keyring;
  }

  /**
   * Login, staged: the new login gets a fresh ref of its own (a keychain account
   * `<profile>:<uuid>`, read back to verify, or a new file), so nothing active is touched
   * until the caller publishes the ref in the profile. The file is used only when the
   * keychain is provably absent (no addon, `ROOSTER_KEYRING=off`, or an allowlisted
   * error); a keychain that refuses is `KeychainRefused`.
   */
  async save(profile: string, login: StoredLogin): Promise<CredentialRef> {
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
          await entry.setPassword(encodeLogin(login));
          const back = decodeLogin(await entry.getPassword());
          if (!sameLogin(back, login)) {
            throw new Error('The keychain did not return the stored login.');
          }
          return { store: 'keychain', ref: account };
        } catch (error) {
          await this.discard({ store: 'keychain', ref: account });
          if (!isStoreAbsent(error, 'call')) throw new KeychainRefused(error);
        }
      }
    }
    const ref = newFileRef(profile);
    writeFileAtomic(this.pathOf(ref), `${encodeLogin(login)}\n`, 0o600);
    return { store: 'file', ref };
  }

  /**
   * Overwrites the login at an existing ref in place: a refresh storing the rotated tokens.
   * Only under the profile's lock (`profile-lock.ts`), after checking that the profile still
   * points at this ref. The keychain is read back; anything short of the new login stored is
   * an error, since the spent refresh token must not be the only one left.
   */
  async replace(
    credential: CredentialRef,
    login: StoredLogin,
    previous: StoredLogin,
  ): Promise<{ verified: boolean }> {
    if (credential.store === 'file') {
      // Atomic: on failure the previous file is untouched.
      writeFileAtomic(this.pathOf(credential.ref), `${encodeLogin(login)}\n`, 0o600);
      return { verified: true };
    }
    const factory = await this.factory();
    if (factory === null) throw new CredentialStoreUnavailable();
    let entry: KeyringEntry | undefined;
    try {
      entry = factory(SERVICE, credential.ref);
      await entry.setPassword(encodeLogin(login));
    } catch (error) {
      // The write failed: put the previous login back (best effort), so a rerun can still
      // redeem its refresh token within the server's grace period.
      await entry?.setPassword(encodeLogin(previous)).catch(() => {});
      throw new CredentialStoreUnavailable(error);
    }
    // The write succeeded. The read-back is only a check, tried twice: a store that answers
    // late (Secret Service `NoReply`) must never bring back the spent refresh token, so a
    // check that still fails keeps the new login and is only reported.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (sameLogin(decodeLogin(await entry.getPassword()), login)) return { verified: true };
      } catch {
        // Tried again below.
      }
    }
    return { verified: false };
  }

  /**
   * The login at an exact ref, or undefined when it holds none. A keychain that can't be
   * read is `CredentialStoreUnavailable`, never a fallback to a file.
   */
  async load(credential: CredentialRef): Promise<StoredLogin | undefined> {
    if (credential.store === 'file') {
      return isFileRef(credential.ref)
        ? decodeLogin(readIfExists(this.pathOf(credential.ref)))
        : undefined;
    }
    const factory = await this.factory();
    if (factory === null) throw new CredentialStoreUnavailable();
    try {
      return decodeLogin(await factory(SERVICE, credential.ref).getPassword());
    } catch (error) {
      throw new CredentialStoreUnavailable(error);
    }
  }

  /** Logout: removes exactly this ref, or throws `CredentialRemovalError`. Gone is fine. */
  async remove(credential: CredentialRef): Promise<void> {
    if (credential.store === 'file') {
      if (!isFileRef(credential.ref)) return;
      const path = this.pathOf(credential.ref);
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CredentialRemovalError(path, error);
        }
      }
      return;
    }
    const factory = await this.factory();
    if (factory === null) {
      throw new CredentialRemovalError('keychain', new Error('The keychain is not available.'));
    }
    try {
      await factory(SERVICE, credential.ref).deletePassword();
    } catch (error) {
      throw new CredentialRemovalError('keychain', error);
    }
  }

  /**
   * Best-effort removal of one exact ref that nothing references any more: a staged login
   * whose publication failed, or the previous generation after a new one was published.
   * False when it could not be confirmed (the caller warns). Never touches any other ref.
   */
  async discard(credential: CredentialRef): Promise<boolean> {
    try {
      await this.remove(credential);
      return true;
    } catch {
      return false;
    }
  }
}
