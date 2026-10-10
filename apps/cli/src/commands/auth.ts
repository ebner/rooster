import { ADMIN_SCOPE, GRANT_SCOPES, type GrantScope } from '@rooster/core/grants';
import { defineCommand } from 'citty';
import { cliFetch, grantsApi, type Me, type Meta, RoosterApiError, unwrap } from '../api.ts';
import { normalizeServer, type Profile } from '../config.ts';
import { CliError, EXIT } from '../errors.ts';
import { constraintLines, currentGrant, parseScopes, scopeSummary } from '../grant-info.ts';
import { isLocale, setLocale, t } from '../i18n.ts';
import { openableUrl } from '../launch.ts';
import { clean, paint } from '../output/color.ts';
import { styles } from '../output/theme.ts';
import { credentialOf, type Runtime, rt } from '../runtime.ts';
import { CredentialRemovalError, serverOrigin } from '../secrets.ts';
import { CLI_VERSION, majorOf } from '../version.ts';
import { readOptions, stringOptions } from './util.ts';

/** The pre-registered client of the device flow (11 §4.2). */
export const CLI_CLIENT_ID = 'rooster-cli';

/**
 * What `rooster login` asks for by default: every capability, `tasks:delete` included, since
 * it is the user's own terminal (07 §2) and `rm` is a CLI command. The user can still narrow
 * it on the `/device` page, and `--scope` asks for less.
 */
export const DEFAULT_LOGIN_SCOPES: readonly GrantScope[] = GRANT_SCOPES;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * A device flow user code as the CLI prints it (RFC 8628 §6.1: short, typed by hand). Anything
 * else from the server is refused before it reaches the terminal.
 */
const USER_CODE_RE = /^[A-Za-z0-9-]{4,32}$/;

/** A server version as printed: semver-like and short, else unknown (never raw text). */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

function serverVersionOf(meta: Pick<Meta, 'version'>): string | null {
  const version: unknown = meta.version;
  return typeof version === 'string' && VERSION_RE.test(version) ? version : null;
}

async function fetchMeta(runtime: Runtime, server: string): Promise<Meta> {
  try {
    return await unwrap(runtime.clientFor(server, undefined).GET('/api/v1/meta'));
  } catch (error) {
    if (error instanceof RoosterApiError) {
      throw new CliError(EXIT.network, t('auth.notRooster', { server }));
    }
    throw error;
  }
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/** better-auth's device endpoints (RFC 8628) live outside `/api/v1`, so they are called directly. */
async function authPost(runtime: Runtime, server: string, path: string, body: unknown) {
  const request = new Request(`${server}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await cliFetch({ io: runtime.io, verbose: runtime.globals.verbose, server })(
    request,
  );
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data };
}

/** Polls the token endpoint until the user approves, denies or the code expires. */
async function pollForToken(runtime: Runtime, server: string, code: DeviceCode): Promise<string> {
  let interval = Math.max(1, code.interval ?? 5) * 1000;
  const deadline = runtime.io.now() + code.expires_in * 1000;
  while (runtime.io.now() < deadline) {
    await runtime.io.sleep(interval);
    const { status, data } = await authPost(runtime, server, '/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: CLI_CLIENT_ID,
    });
    if (status === 200 && typeof data.access_token === 'string') return data.access_token;
    switch (data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5000;
        continue;
      case 'access_denied':
        throw new CliError(EXIT.auth, t('login.denied'));
      case 'expired_token':
        throw new CliError(EXIT.auth, t('login.expired'));
      default:
        throw new CliError(
          EXIT.auth,
          t('login.failed', { error: String(data.error_description ?? data.error ?? status) }),
        );
    }
  }
  throw new CliError(EXIT.auth, t('login.expired'));
}

/** Stores the credential, then fills the profile from `/me` (default org, user). */
async function finishLogin(
  runtime: Runtime,
  server: string,
  token: string,
  orgFlag: string | undefined,
  options: { makeDefault?: boolean } = {},
): Promise<Me> {
  const client = runtime.clientFor(server, token);
  let me: Me;
  try {
    me = await unwrap(client.GET('/api/v1/me'));
  } catch (error) {
    if (error instanceof RoosterApiError && (error.status === 401 || error.status === 403)) {
      throw new CliError(EXIT.auth, t('login.tokenRejected'));
    }
    throw error;
  }
  const profileName = runtime.profileName;
  const origin = serverOrigin(server);
  // 1. Stage the new login under a fresh ref of its own; nothing active is touched yet.
  const saved = await runtime.credentials.save(profileName, { token, server: origin });
  if (saved.store === 'file' && !runtime.keyringOff && runtime.state.takeKeychainNotice()) {
    runtime.out.notice(t('auth.keychainFallback', { path: runtime.credentials.pathOf(saved.ref) }));
  }
  // 2. Publish it: one locked swap of the profile (and the default profile). If that fails,
  // the staged ref is discarded and the active login stays as it was.
  let previous: Profile = {};
  try {
    runtime.config.update((config) => {
      previous = config.profiles[profileName] ?? {};
      const wanted = orgFlag ?? (previous.server === server ? previous.org : undefined);
      const org =
        (wanted === undefined
          ? undefined
          : me.orgs.find((o) => o.slug === wanted || o.id === wanted)) ??
        me.orgs.find((o) => o.isPersonal) ??
        me.orgs[0];
      const profile: Profile = {
        ...previous,
        server,
        ...(org === undefined ? {} : { org: org.slug }),
        user: me.email,
        credential_store: saved.store,
        credential_ref: saved.ref,
        credential_origin: origin,
      };
      const makeDefault =
        options.makeDefault !== false &&
        config.default_profile === undefined &&
        profileName !== 'default';
      return {
        ...config,
        ...(makeDefault ? { default_profile: profileName } : {}),
        profiles: { ...config.profiles, [profileName]: profile },
      };
    });
  } catch (error) {
    if (!(await runtime.credentials.discard(saved))) runtime.out.warn(t('login.stagedKept'));
    throw error;
  }
  // 3. Drop exactly the previous ref the swap replaced; no other ref, no reusable path.
  const before = credentialOf(previous);
  if (before !== undefined && before.ref !== saved.ref) {
    if (!(await runtime.credentials.discard(before))) runtime.out.warn(t('login.previousKept'));
  }
  runtime.state.setUserLocale(profileName, me.locale);
  if (!isLocale(previous.locale)) setLocale(me.locale);
  return me;
}

export function serverFrom(runtime: Runtime, flag: unknown): string {
  const raw = str(flag) ?? runtime.io.env.ROOSTER_SERVER ?? runtime.profile.server;
  if (raw === undefined || raw === '') throw new CliError(EXIT.usage, t('login.serverMissing'));
  return normalizeServer(raw);
}

export interface DeviceLoginOptions {
  server: string;
  scopes: readonly GrantScope[];
  orgFlag?: string | undefined;
  /** Open the verification page in the browser (`--no-browser` turns it off). */
  browser: boolean;
  /** Make this the default profile when there is none yet (`rooster mcp setup` doesn't). */
  makeDefault?: boolean;
}

/**
 * The device flow (07 §2) for the runtime's profile: validates the server, asks for a code
 * with `scopes`, shows it, polls until approval, then stores the login (ADR 0039 §7).
 */
export async function deviceLogin(runtime: Runtime, options: DeviceLoginOptions): Promise<Me> {
  const { out } = runtime;
  const { server } = options;
  const meta = await fetchMeta(runtime, server);
  const serverVersion = serverVersionOf(meta);
  if (serverVersion !== null) warnOnVersion(runtime, serverVersion);
  const { status, data } = await authPost(runtime, server, '/device/code', {
    client_id: CLI_CLIENT_ID,
    scope: options.scopes.join(' '),
  });
  if (
    status !== 200 ||
    typeof data.device_code !== 'string' ||
    typeof data.user_code !== 'string'
  ) {
    throw new CliError(
      EXIT.auth,
      t('login.failed', { error: String(data.error_description ?? data.error ?? status) }),
    );
  }
  if (!USER_CODE_RE.test(data.user_code)) {
    throw new CliError(EXIT.auth, t('login.failed', { error: 'invalid_user_code' }));
  }
  const code = data as unknown as DeviceCode;
  const url = code.verification_uri_complete ?? code.verification_uri;
  out.notice(t('login.instructions', { url: code.verification_uri, code: code.user_code }));
  // The code goes to stdout on its own line too, so scripts and tests can read it.
  out.line(`${t('login.codeLabel')} ${paint(code.user_code, styles.accent, out.level)}`);
  if (options.browser) {
    const href = openableUrl(url, server);
    if (href !== null) await runtime.io.openUrl(href);
    else out.notice(t('open.notOpened'));
  }
  out.notice(t('login.waiting'));
  const token = await pollForToken(runtime, server, code);
  return finishLogin(runtime, server, token, options.orgFlag, {
    ...(options.makeDefault === undefined ? {} : { makeDefault: options.makeDefault }),
  });
}

const loginArgs = () =>
  ({
    server: { type: 'string', valueHint: 'url', description: t('login.arg.server') },
    'with-token': { type: 'boolean', description: t('login.arg.withToken') },
    browser: { type: 'boolean', default: true, negativeDescription: t('login.arg.noBrowser') },
    scope: { type: 'string', valueHint: 'scope,…', description: t('login.arg.scope') },
    admin: { type: 'boolean', description: t('login.arg.admin') },
    org: { type: 'string', valueHint: 'slug', description: t('login.arg.org') },
  }) as const;

export const loginCommand = defineCommand({
  meta: () => ({ name: 'login', description: t('cmd.login') }),
  args: loginArgs,
  async run({ args, rawArgs }) {
    // The requested scopes shape the grant: a value that looks like another option is
    // refused, never read as one.
    const given = readOptions(rawArgs, stringOptions(loginArgs()));
    const runtime = rt();
    const { out } = runtime;
    const server = serverFrom(runtime, args.server);
    const orgs = given.values.get('org') ?? [];
    const orgFlag = orgs[0];

    if (args['with-token'] === true) {
      const token = (await runtime.io.readStdin()).trim();
      if (token === '') throw new CliError(EXIT.usage, t('login.tokenMissing'));
      await fetchMeta(runtime, server);
      const me = await finishLogin(runtime, server, token, orgFlag);
      if (out.json) out.data({ server, profile: runtime.profileName, user: me.email });
      else
        out.notice(
          t('login.done', { name: clean(me.name), email: me.email, profile: runtime.profileName }),
        );
      return;
    }

    const requested = [...(given.values.get('scope') ?? [])];
    const scopes = requested.length === 0 ? [...DEFAULT_LOGIN_SCOPES] : parseScopes(requested);
    if (args.admin === true && !scopes.includes(ADMIN_SCOPE)) scopes.push(ADMIN_SCOPE);
    const me = await deviceLogin(runtime, {
      server,
      scopes,
      orgFlag,
      browser: args.browser !== false,
    });
    if (out.json) out.data({ server, profile: runtime.profileName, user: me.email });
    else
      out.notice(
        t('login.done', { name: clean(me.name), email: me.email, profile: runtime.profileName }),
      );
    // The device page offers `admin` only to instance admins and drops it for anyone else
    // (ADR 0042 §1), so say when the login came back without it.
    if (scopes.includes(ADMIN_SCOPE)) {
      const grant = await currentGrant(runtime);
      if (!me.isAdmin || (grant !== null && !grant.scopes.includes(ADMIN_SCOPE))) {
        out.warn(t('login.adminDropped'));
      }
    }
  },
});

function warnOnVersion(runtime: Runtime, serverVersion: string): void {
  const ours = majorOf(CLI_VERSION);
  const theirs = majorOf(serverVersion);
  if (ours !== null && theirs !== null && ours !== theirs) {
    runtime.out.warn(t('version.mismatch', { cli: CLI_VERSION, server: serverVersion }));
  }
}

export const logoutCommand = defineCommand({
  meta: () => ({ name: 'logout', description: t('cmd.logout') }),
  async run() {
    const runtime = rt();
    const { out } = runtime;
    if (runtime.tokenFromEnv()) {
      out.warn(t('logout.envToken'));
      return;
    }
    const snapshot = runtime.config.peek().profiles[runtime.profileName] ?? {};
    const captured = credentialOf(snapshot);
    if (captured === undefined) {
      out.notice(t('logout.notLoggedIn', { profile: runtime.profileName }));
      return;
    }
    // A device login is this CLI's own grant: revoke it. A PAT may be in use elsewhere
    // (CI), so it is only forgotten here; `rooster token revoke` ends it. The lookup and the
    // revocation use the captured login's own token and origin, read once: never a newer
    // login that another process may publish meanwhile.
    let revoked = false;
    try {
      const login = await runtime.credentials.load(captured);
      const origin = snapshot.credential_origin;
      const server = snapshot.server === undefined ? undefined : normalizeServer(snapshot.server);
      if (
        login !== undefined &&
        origin !== undefined &&
        login.server === origin &&
        server !== undefined &&
        serverOrigin(server) === origin
      ) {
        const client = runtime.clientFor(server, login.token);
        const grant = (await grantsApi.list(client)).find((g) => g.current) ?? null;
        if (grant !== null && grant.kind === 'device') {
          await grantsApi.remove(client, grant.id);
          revoked = true;
        } else if (grant !== null && grant.kind === 'pat') {
          out.notice(t('logout.patKept', { prefix: grant.tokenPrefix ?? grant.id }));
        }
      }
    } catch {
      out.warn(t('logout.revokeFailed'));
    }
    // Delete exactly the captured ref, confirmed, before the profile lets go of it.
    try {
      await runtime.credentials.remove(captured);
    } catch (error) {
      if (error instanceof CredentialRemovalError) {
        const where =
          error.where === 'keychain'
            ? t('logout.keychainWhere', { profile: runtime.profileName })
            : error.where;
        throw new CliError(
          EXIT.unexpected,
          t('logout.removeFailed', { path: where, reason: error.message }),
        );
      }
      throw error;
    }
    // Clear the profile only if it still points at what was deleted: a login that completed
    // meanwhile is newer and stays.
    let replaced = false;
    runtime.config.update((config) => {
      const current = config.profiles[runtime.profileName] ?? {};
      const now = credentialOf(current);
      if (now === undefined || now.store !== captured.store || now.ref !== captured.ref) {
        replaced = now !== undefined;
        return config;
      }
      const {
        user: _user,
        credential_store: _store,
        credential_ref: _ref,
        credential_origin: _origin,
        ...profile
      } = current;
      return { ...config, profiles: { ...config.profiles, [runtime.profileName]: profile } };
    });
    if (replaced) {
      throw new CliError(EXIT.conflict, t('logout.replaced', { profile: runtime.profileName }));
    }
    runtime.state.forgetProfile(runtime.profileName);
    if (out.json) out.data({ profile: runtime.profileName, revoked });
    else out.notice(t('logout.done', { profile: runtime.profileName }));
  },
});

export const whoamiCommand = defineCommand({
  meta: () => ({ name: 'whoami', description: t('cmd.whoami') }),
  async run() {
    const runtime = rt();
    const { out } = runtime;
    const me = await runtime.me();
    const server = runtime.server();
    const grant = await currentGrant(runtime);
    if (out.json) {
      out.data({ user: me, server, profile: runtime.profileName, org: runtime.orgRef(), grant });
      return;
    }
    if (out.quiet) {
      out.line(clean(me.email));
      return;
    }
    const rows: [string, string][] = [
      [t('whoami.server'), server],
      [t('whoami.profile'), runtime.profileName],
      [t('whoami.org'), runtime.orgRef()],
    ];
    if (grant !== null) {
      rows.push([t('whoami.access'), `${t(`grant.kind.${grant.kind}`)} · ${clean(grant.label)}`]);
      rows.push([t('whoami.scopes'), scopeSummary(grant.scopes)]);
      const lines = await constraintLines(runtime, grant.constraints);
      for (const [i, line] of lines.entries()) rows.push([i === 0 ? t('whoami.where') : '', line]);
      rows.push([
        t('whoami.expires'),
        grant.expiresAt === null
          ? t('grant.never')
          : new Date(grant.expiresAt).toISOString().slice(0, 10),
      ]);
    } else if (runtime.tokenFromEnv()) {
      rows.push([t('whoami.access'), t('whoami.envToken')]);
    }
    out.line(`${paint(clean(me.name), styles.heading, out.level)} <${clean(me.email)}>`);
    const width = Math.max(...rows.map(([k]) => k.length));
    for (const [key, value] of rows) {
      out.line(`  ${paint(key.padEnd(width), styles.muted, out.level)}  ${value}`);
    }
  },
});

/** `rooster --version`: the CLI, plus the server's when logged in (07 §1). */
export async function printVersion(runtime: Runtime): Promise<void> {
  const { out } = runtime;
  const server = runtime.serverOrNull();
  let serverVersion: string | null = null;
  // A login for another server only means no server version here, not an error.
  const token = server === null ? undefined : await runtime.token(server).catch(() => undefined);
  if (server !== null && token !== undefined) {
    serverVersion = await fetchMeta(runtime, server)
      .then(serverVersionOf)
      .catch(() => null);
  }
  if (out.json) {
    out.data({ cli: CLI_VERSION, server: serverVersion });
    return;
  }
  out.line(
    serverVersion === null
      ? `rooster ${CLI_VERSION}`
      : `rooster ${CLI_VERSION} (${t('version.server', { version: serverVersion })})`,
  );
  if (serverVersion !== null) warnOnVersion(runtime, serverVersion);
}
