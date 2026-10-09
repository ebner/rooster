import { AsyncLocalStorage } from 'node:async_hooks';
import type { GrantScope } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import {
  createApi,
  type Group,
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
  FileSecretStore,
  LayeredSecretStore,
  loadKeyring,
  type SecretStore,
  serverOrigin,
} from './secrets.ts';
import { StateStore } from './state.ts';

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
  readonly secrets: SecretStore;
  readonly out: Output;
  readonly cacheDir: string;
  /** `X-Rooster-Client-Id`: one per process (06 §1). */
  readonly clientId = uuidv7();
  /** The capability the running command needs, for explaining `forbidden_scope`. */
  requiredScope: GrantScope | undefined;
  private client: RoosterClient | undefined;
  private meCache: Promise<Me> | undefined;
  private readonly listCache = new Map<string, Promise<MyList>>();
  private readonly tagCache = new Map<string, Promise<Tag[]>>();
  private readonly memberCache = new Map<string, Promise<Member[]>>();

  constructor(
    readonly io: Io,
    readonly globals: Globals,
    options: { loadKeyring?: typeof loadKeyring } = {},
  ) {
    const dir = configDir(io.env, io.platform, io.homedir);
    this.config = new ConfigStore(dir);
    this.state = new StateStore(stateDir(io.env, io.platform, io.homedir));
    this.cacheDir = cacheDir(io.env, io.platform, io.homedir);
    const file = new FileSecretStore(dir);
    const keyringOff = ['0', 'off', 'false', 'no'].includes(
      (io.env.ROOSTER_KEYRING ?? '').toLowerCase(),
    );
    this.secrets = new LayeredSecretStore(
      file,
      keyringOff ? async () => null : (options.loadKeyring ?? loadKeyring),
      () => {
        if (this.state.takeKeychainNotice()) {
          this.out.notice(t('auth.keychainFallback', { path: file.path }));
        }
      },
    );
    this.out = new Output(io, globals);
  }

  get configData(): Config {
    return this.config.read();
  }

  get profileName(): string {
    return resolveProfileName(this.globals.profile, this.io.env, this.configData);
  }

  get profile(): Profile {
    return this.configData.profiles[this.profileName] ?? {};
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
   * The token to send to `server()`: `ROOSTER_TOKEN` (explicit, 07 §2), else the profile's
   * stored login, but only when it was issued by that same server. A login is never sent to
   * another origin (`ROOSTER_SERVER` or a changed `server` setting): exit 3 instead.
   */
  async token(): Promise<string | undefined> {
    const env = this.io.env.ROOSTER_TOKEN;
    if (env !== undefined && env !== '') return env.trim();
    const credential = await this.secrets.get(this.profileName);
    if (credential === undefined) return undefined;
    const server = this.server();
    if (credential.server !== serverOrigin(server)) {
      throw new CliError(
        EXIT.auth,
        t('auth.otherServer', { stored: credential.server, server: serverOrigin(server) }),
      );
    }
    return credential.token;
  }

  tokenFromEnv(): boolean {
    return (this.io.env.ROOSTER_TOKEN ?? '') !== '';
  }

  /** The authenticated client; exit 3 when there is no credential. */
  async api(): Promise<RoosterClient> {
    if (this.client === undefined) {
      const server = this.server();
      const token = await this.token();
      if (token === undefined) throw new CliError(EXIT.auth, t('auth.notLoggedIn'));
      this.client = this.clientFor(server, token);
    }
    return this.client;
  }

  /** A client for `server` with an explicit token (login) or none (public routes). */
  clientFor(server: string, token: string | undefined): RoosterClient {
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
