import { AsyncLocalStorage } from 'node:async_hooks';
import type { GrantScope } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import {
  cliFetch,
  createApi,
  type Group,
  isBearerToken,
  type Me,
  type Member,
  type MyList,
  type Org,
  type RoosterClient,
  type Tag,
  unwrap,
} from './api.ts';
import {
  type Config,
  ConfigStore,
  cacheDir,
  configDir,
  normalizeServer,
  type Profile,
  resolveProfileName,
  stateDir,
} from './config.ts';
import { CliError, EXIT } from './errors.ts';
import { isLocale, setLocale, t } from './i18n.ts';
import type { Io } from './io.ts';
import { type Audience, GrantEndedError, isLostRefresh, refreshTokens } from './oauth.ts';
import { Output } from './output/output.ts';
import { deferSignals, type ProfileLockOptions, withProfileLock } from './profile-lock.ts';
import {
  type CredentialRef,
  CredentialStore,
  CredentialsChanging,
  type KeyringFactory,
  loadKeyring,
  type StoredLogin,
  serverOrigin,
} from './secrets.ts';
import { StateStore } from './state.ts';

/** Fresh re-reads of a profile's credential ref before giving up (see `storedLogin`). */
const REF_ATTEMPTS = 3;

/** An OAuth access token is refreshed when less than this is left (clock skew, slow calls). */
export const REFRESH_MARGIN_MS = 60_000;

/** The pause before sending a lost refresh again, well inside the server's 60 s grace. */
export const REFRESH_RETRY_MS = 1_000;

/** What a credential is needed for (`token`). */
export interface TokenOptions {
  /** Where it will be sent: the REST API (default) or the remote MCP endpoint. */
  audience?: Audience;
  /** Refresh an OAuth access token unless it stays valid at least this long. */
  minValidityMs?: number;
  /** Use the profile's own login even when `ROOSTER_TOKEN` is set (`rooster mcp header`). */
  ignoreEnv?: boolean;
  /** How long to wait for another process refreshing the same profile. */
  lockTimeoutMs?: number;
}

/** A stored login as read: the login, the origin the profile records, and its exact ref. */
export interface StoredCredential {
  login: StoredLogin;
  origin: string;
  credential: CredentialRef;
}

/** The exact credential a profile points at, or undefined when it has no login. */
export function credentialOf(profile: Profile): CredentialRef | undefined {
  const { credential_store: store, credential_ref: ref } = profile;
  return store === undefined || ref === undefined ? undefined : { store, ref };
}

/** Resolves to the caller's personal org wherever an org is accepted (05 §2). */
export const PERSONAL_ORG_ALIAS = 'personal';

/** The flags every command accepts (07 §4). */
export interface Globals {
  json: boolean;
  quiet: boolean;
  noColor: boolean;
  yes: boolean;
  verbose: boolean;
  profile?: string;
  org?: string;
}

export const NO_GLOBALS: Globals = {
  json: false,
  quiet: false,
  noColor: false,
  yes: false,
  verbose: false,
};

/** Per-invocation state: config, credentials, the API client and cached reads. */
export class Runtime {
  readonly config: ConfigStore;
  readonly state: StateStore;
  readonly credentials: CredentialStore;
  /** `ROOSTER_KEYRING=off`: logins go to a file and the keychain is never touched. */
  readonly keyringOff: boolean;
  readonly out: Output;
  readonly cacheDir: string;
  /** `X-Rooster-Client-Id`: one per process (06 §1). */
  readonly clientId = uuidv7();
  /** Every credential this invocation used, so diagnostics can redact them (`run.ts`). */
  readonly usedTokens = new Set<string>();
  /** The capability the running command needs, for explaining `forbidden_scope`. */
  requiredScope: GrantScope | undefined;
  private client: RoosterClient | undefined;
  /** The refresh in flight in this process, so parallel requests share it (`refreshed`). */
  private refreshing: Promise<StoredLogin> | undefined;
  private pinnedProfile: string | undefined;
  private pinnedSettings: Profile | undefined;
  private meCache: Promise<Me> | undefined;
  private readonly listCache = new Map<string, Promise<MyList>>();
  private readonly tagCache = new Map<string, Promise<Tag[]>>();
  private readonly memberCache = new Map<string, Promise<Member[]>>();

  constructor(
    readonly io: Io,
    readonly globals: Globals,
    private readonly options: { loadKeyring?: () => Promise<KeyringFactory | null> } = {},
  ) {
    const dir = configDir(io.env, io.platform, io.homedir);
    this.config = new ConfigStore(dir);
    this.state = new StateStore(stateDir(io.env, io.platform, io.homedir));
    this.cacheDir = cacheDir(io.env, io.platform, io.homedir);
    this.keyringOff = ['0', 'off', 'false', 'no'].includes(
      (io.env.ROOSTER_KEYRING ?? '').toLowerCase(),
    );
    this.credentials = new CredentialStore(
      dir,
      this.keyringOff ? async () => null : (options.loadKeyring ?? loadKeyring),
    );
    this.out = new Output(io, globals);
  }

  /**
   * The same invocation for another profile, pinned afresh: `rooster mcp setup` signs in its
   * dedicated profile while the command itself started under the default one.
   */
  forProfile(profile: string): Runtime {
    return new Runtime(this.io, { ...this.globals, profile }, this.options);
  }

  get configData(): Config {
    return this.config.read();
  }

  /**
   * The profile this invocation works with, resolved once (flag, env, then the config's
   * `default_profile`) and pinned: a concurrent change of `default_profile` never moves a
   * running command to another profile, its token or its org.
   */
  get profileName(): string {
    this.pinnedProfile ??= resolveProfileName(this.globals.profile, this.io.env, this.configData);
    return this.pinnedProfile;
  }

  /**
   * The pinned profile's settings (server, org, locale, …) as first read in this invocation.
   * Later config reads (credential refreshes, other processes' edits) never change them, so
   * a command keeps the server and org it started with. Credentials are not taken from here:
   * `storedLogin` reads them fresh.
   */
  get profile(): Profile {
    this.pinnedSettings ??= { ...(this.configData.profiles[this.profileName] ?? {}) };
    return this.pinnedSettings;
  }

  /** `ROOSTER_SERVER`, then the profile's server. */
  serverOrNull(): string | null {
    const raw = this.io.env.ROOSTER_SERVER || this.profile.server;
    return raw ? normalizeServer(raw) : null;
  }

  server(): string {
    const server = this.serverOrNull();
    if (server === null) throw new CliError(EXIT.auth, t('auth.notLoggedIn'));
    return server;
  }

  /**
   * The profile's stored login. The ref is taken from a fresh read of `config.toml` (not
   * this invocation's cached copy), and the config is read again after the secret: if the
   * ref changed meanwhile (another login or logout), it starts over, a few times, then
   * gives up (`CredentialsChanging`). A recorded keychain that can't be read is an error,
   * never a fallback.
   */
  async storedLogin(): Promise<StoredCredential | undefined> {
    const pinned = this.profile;
    for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
      // `peek`, not `reload`: only the credential fields are taken from the fresh file.
      const before = this.config.peek().profiles[this.profileName] ?? {};
      this.checkSameServer(pinned, before);
      const credential = credentialOf(before);
      if (credential === undefined || before.credential_origin === undefined) return undefined;
      const login = await this.credentials.load(credential);
      const after = this.config.peek().profiles[this.profileName] ?? {};
      this.checkSameServer(pinned, after);
      const still = credentialOf(after);
      if (
        still?.store !== credential.store ||
        still.ref !== credential.ref ||
        after.credential_origin !== before.credential_origin
      ) {
        continue;
      }
      if (login === undefined || login.server !== before.credential_origin) return undefined;
      return { login, origin: before.credential_origin, credential };
    }
    throw new CredentialsChanging();
  }

  /** A profile whose server moved to another origin since this invocation started: exit 3. */
  private checkSameServer(pinned: Profile, fresh: Profile): void {
    if (pinned.server === undefined || fresh.server === undefined) return;
    const was = serverOrigin(normalizeServer(pinned.server));
    const now = serverOrigin(normalizeServer(fresh.server));
    if (was !== now) {
      throw new CliError(EXIT.auth, t('auth.otherServer', { stored: now, server: was }));
    }
  }

  /**
   * The token for a request to `requestServer` (the origin the caller will actually send
   * to): `ROOSTER_TOKEN` (explicit, 07 §2), else the profile's stored login, only when the
   * stored origin, the profile's origin and the request origin are one. A login is never sent
   * to another origin: exit 3 instead. An OAuth login must be for `audience`, and its access
   * token is refreshed first when it is about to expire.
   */
  async token(requestServer: string, options: TokenOptions = {}): Promise<string | undefined> {
    const env = this.io.env.ROOSTER_TOKEN;
    if (options.ignoreEnv !== true && env !== undefined && env !== '') {
      return this.wellFormed(env.trim());
    }
    const stored = await this.storedLogin();
    if (stored === undefined) return undefined;
    const request = serverOrigin(requestServer);
    const sameOrigin = (login: StoredLogin) => {
      if (login.server !== request) {
        throw new CliError(
          EXIT.auth,
          t('auth.otherServer', { stored: login.server, server: request }),
        );
      }
    };
    sameOrigin(stored.login);
    const audience = options.audience ?? 'api';
    let login = stored.login;
    this.checkAudience(login, audience);
    if (
      login.oauth !== undefined &&
      login.oauth.expiresAt - this.io.now() <= (options.minValidityMs ?? REFRESH_MARGIN_MS)
    ) {
      login = await this.refreshed(options, requestServer);
      sameOrigin(login);
      this.checkAudience(login, audience);
    }
    return this.wellFormed(login.token);
  }

  /** An OAuth login works only at its audience; a bearer login only at the API. */
  private checkAudience(login: StoredLogin, audience: Audience): void {
    if (login.oauth !== undefined) this.usedTokens.add(login.oauth.refreshToken);
    const has = login.oauth?.audience ?? 'api';
    if (has === audience) return;
    throw new CliError(
      EXIT.auth,
      t(audience === 'mcp' ? 'auth.notRemoteProfile' : 'auth.remoteOnlyProfile', {
        profile: this.profileName,
      }),
    );
  }

  /** Runs `fn` holding this profile's cross-process lock (refresh, logout, retiring a login). */
  withProfileLock<T>(fn: () => Promise<T>, options: ProfileLockOptions = {}): Promise<T> {
    return withProfileLock(this.config.dir, this.profileName, fn, options);
  }

  /**
   * The profile's OAuth login with a fresh access token: one refresh per process at a time,
   * and across processes under the profile's lock. Inside the lock the login is read again
   * (ref and secret), since another process may have refreshed it already: its tokens are
   * used and the spent refresh token is never sent twice (reuse revokes the grant, 11 §2.4).
   */
  private refreshed(options: TokenOptions, server: string): Promise<StoredLogin> {
    this.refreshing ??= this.withProfileLock(() => this.refreshLocked(options, server), {
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
    }).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** `server`: the base URL the caller sends to, on the login's own origin (checked). */
  private async refreshLocked(options: TokenOptions, server: string): Promise<StoredLogin> {
    const stored = await this.storedLogin();
    if (stored === undefined) throw new CliError(EXIT.auth, t('auth.notLoggedIn'));
    const { login, credential } = stored;
    const margin = options.minValidityMs ?? REFRESH_MARGIN_MS;
    if (login.oauth === undefined || login.oauth.expiresAt - this.io.now() > margin) return login;
    const oauth = login.oauth;
    // The refresh token goes only to the authorization server on the login's own origin.
    if (serverOrigin(server) !== login.server) {
      throw new CliError(EXIT.auth, t('auth.otherServer', { stored: login.server, server }));
    }
    const base = server;
    try {
      return await deferSignals(async () => {
        const attempt = () =>
          refreshTokens(
            cliFetch({ io: this.io, verbose: this.globals.verbose, server: base }),
            base,
            oauth.refreshToken,
            oauth.resource,
            () => this.io.now(),
          );
        let tokens: Awaited<ReturnType<typeof attempt>>;
        try {
          tokens = await attempt();
        } catch (error) {
          // The server may have rotated without the answer arriving: the same refresh once
          // more, at once, lands in its grace period. Never after a refusal.
          if (!isLostRefresh(error)) throw error;
          await this.io.sleep(REFRESH_RETRY_MS);
          tokens = await attempt();
        }
        this.usedTokens.add(tokens.accessToken);
        this.usedTokens.add(tokens.refreshToken);
        const next: StoredLogin = {
          token: tokens.accessToken,
          server: login.server,
          oauth: {
            ...oauth,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes.length > 0 ? tokens.scopes : oauth.scopes,
          },
        };
        // Stored before anything else happens: the old refresh token is spent now. If that
        // fails, the previous login stays stored, and a rerun within a minute redeems it again.
        let stored: { verified: boolean };
        try {
          stored = await this.credentials.replace(credential, next, login);
        } catch (error) {
          throw new CliError(
            EXIT.auth,
            t('auth.refreshNotStored', {
              profile: this.profileName,
              reason: (error as Error).message,
            }),
          );
        }
        if (!stored.verified) {
          this.out.warn(t('auth.refreshUnverified', { profile: this.profileName }));
        }
        return next;
      });
    } catch (error) {
      if (error instanceof GrantEndedError) {
        throw new CliError(
          EXIT.auth,
          t(oauth.audience === 'mcp' ? 'auth.remoteLoginEnded' : 'auth.loginEnded', {
            profile: this.profileName,
          }),
          'invalid_grant',
        );
      }
      throw error;
    }
  }

  /** `token` when it can be a bearer credential; exit 3 otherwise, without quoting it. */
  private wellFormed(token: string): string {
    this.usedTokens.add(token);
    if (!isBearerToken(token)) throw new CliError(EXIT.auth, t('login.tokenMalformed'));
    return token;
  }

  tokenFromEnv(): boolean {
    return (this.io.env.ROOSTER_TOKEN ?? '') !== '';
  }

  /** The authenticated client; exit 3 when there is no credential. */
  async api(): Promise<RoosterClient> {
    if (this.client === undefined) {
      const server = this.server();
      // The token is chosen for this exact origin, the one the client will send to.
      const token = await this.token(server);
      if (token === undefined) throw new CliError(EXIT.auth, t('auth.notLoggedIn'));
      // Read per request: a long command (the TUI, `rooster mcp`) refreshes as it goes.
      this.client = createApi({
        server,
        token: async () => this.token(server),
        io: this.io,
        clientId: this.clientId,
        verbose: this.globals.verbose,
      });
    }
    return this.client;
  }

  /** A client for `server` with an explicit token (login) or none (public routes). */
  clientFor(server: string, token: string | undefined): RoosterClient {
    if (token !== undefined) this.wellFormed(token);
    return createApi({
      server,
      token,
      io: this.io,
      clientId: this.clientId,
      verbose: this.globals.verbose,
    });
  }

  async me(): Promise<Me> {
    this.meCache ??= (async () => {
      const me = await unwrap((await this.api()).GET('/api/v1/me'));
      this.state.setUserLocale(this.profileName, me.locale);
      if (!isLocale(this.profile.locale)) setLocale(me.locale);
      return me;
    })();
    return this.meCache;
  }

  /** `--org`, `ROOSTER_ORG`, the profile's org, else the personal org. */
  orgRef(): string {
    return this.globals.org || this.io.env.ROOSTER_ORG || this.profile.org || PERSONAL_ORG_ALIAS;
  }

  /** Finds one of the user's orgs by ID, slug or `personal`; exit 4 otherwise. */
  async findOrg(ref: string): Promise<Org> {
    const me = await this.me();
    const org =
      ref === PERSONAL_ORG_ALIAS
        ? me.orgs.find((o) => o.isPersonal)
        : me.orgs.find((o) => o.slug === ref || o.id === ref);
    if (org === undefined) throw new CliError(EXIT.notFound, t('org.notFound', { org: ref }));
    return org;
  }

  async org(): Promise<Org> {
    return this.findOrg(this.orgRef());
  }

  async orgById(id: string): Promise<Org | undefined> {
    return (await this.me()).orgs.find((o) => o.id === id);
  }

  /**
   * My list (cached per org): open tasks plus those completed in the server's default window
   * (14 days), or every completed task with `allCompleted`.
   */
  async myList(orgId: string, allCompleted = false): Promise<MyList> {
    const key = `${orgId}:${allCompleted}`;
    let list = this.listCache.get(key);
    if (list === undefined) {
      list = (async () =>
        unwrap(
          (await this.api()).GET('/api/v1/orgs/{orgId}/my-list', {
            params: { path: { orgId }, query: allCompleted ? { completedSince: 0 } : {} },
          }),
        ))();
      this.listCache.set(key, list);
    }
    return list;
  }

  async groups(orgId: string): Promise<Group[]> {
    return (await this.myList(orgId)).groups;
  }

  async tags(orgId: string): Promise<Tag[]> {
    let tags = this.tagCache.get(orgId);
    if (tags === undefined) {
      tags = (async () =>
        unwrap(
          (await this.api()).GET('/api/v1/orgs/{orgId}/tags', { params: { path: { orgId } } }),
        ))();
      this.tagCache.set(orgId, tags);
    }
    return tags;
  }

  forgetTags(orgId: string): void {
    this.tagCache.delete(orgId);
  }

  async members(orgId: string): Promise<Member[]> {
    let members = this.memberCache.get(orgId);
    if (members === undefined) {
      members = (async () =>
        unwrap(
          (await this.api()).GET('/api/v1/orgs/{orgId}/members', {
            params: { path: { orgId } },
          }),
        ))();
      this.memberCache.set(orgId, members);
    }
    return members;
  }
}

const store = new AsyncLocalStorage<Runtime>();

export function withRuntime<T>(runtime: Runtime, fn: () => T): T {
  return store.run(runtime, fn);
}

/** The runtime of the current invocation. */
export function rt(): Runtime {
  const runtime = store.getStore();
  if (runtime === undefined) throw new Error('rooster: no runtime');
  return runtime;
}
