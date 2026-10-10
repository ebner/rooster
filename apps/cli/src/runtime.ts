import { AsyncLocalStorage } from 'node:async_hooks';
import type { GrantScope } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import {
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
import { Output } from './output/output.ts';
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
  async storedLogin(): Promise<{ login: StoredLogin; origin: string } | undefined> {
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
      return { login, origin: before.credential_origin };
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
   * to another origin: exit 3 instead.
   */
  async token(requestServer: string): Promise<string | undefined> {
    const env = this.io.env.ROOSTER_TOKEN;
    if (env !== undefined && env !== '') return this.wellFormed(env.trim());
    const stored = await this.storedLogin();
    if (stored === undefined) return undefined;
    const request = serverOrigin(requestServer);
    if (stored.login.server !== request) {
      throw new CliError(
        EXIT.auth,
        t('auth.otherServer', { stored: stored.login.server, server: request }),
      );
    }
    return this.wellFormed(stored.login.token);
  }

  /** `token` when it can be a bearer credential; exit 3 otherwise, without quoting it. */
  private wellFormed(token: string): string {
    this.usedTokens.add(token);
    if (!isBearerToken(token)) throw new CliError(EXIT.auth, t('login.tokenRejected'));
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
      this.client = this.clientFor(server, token);
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
