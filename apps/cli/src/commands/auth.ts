import { GRANT_SCOPES, type GrantScope } from '@rooster/core/grants';
import { defineCommand } from 'citty';
import { cliFetch, grantsApi, type Me, type Meta, RoosterApiError, unwrap } from '../api.ts';
import { normalizeServer } from '../config.ts';
import { CliError, EXIT } from '../errors.ts';
import { constraintLines, currentGrant, parseScopes, scopeSummary } from '../grant-info.ts';
import { isLocale, setLocale, t } from '../i18n.ts';
import { openableUrl } from '../launch.ts';
import { clean, paint } from '../output/color.ts';
import { styles } from '../output/theme.ts';
import { type Runtime, rt } from '../runtime.ts';
import { CLI_VERSION, majorOf } from '../version.ts';
import { multi } from './util.ts';

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
  const where = await runtime.secrets.set(profileName, token, server);
  const previous = runtime.profile;
  const wanted = orgFlag ?? (previous.server === server ? previous.org : undefined);
  const org =
    (wanted === undefined
      ? undefined
      : me.orgs.find((o) => o.slug === wanted || o.id === wanted)) ??
    me.orgs.find((o) => o.isPersonal) ??
    me.orgs[0];
  runtime.config.updateProfile(profileName, (profile) => ({
    ...profile,
    server,
    ...(org === undefined ? {} : { org: org.slug }),
    user: me.email,
  }));
  const config = runtime.config.read();
  if (config.default_profile === undefined && profileName !== 'default') {
    runtime.config.write({ ...config, default_profile: profileName });
  }
  runtime.state.setUserLocale(profileName, me.locale);
  if (!isLocale(previous.locale)) setLocale(me.locale);
  if (where === 'file' && runtime.globals.verbose) runtime.out.notice(t('auth.storedInFile'));
  return me;
}

function serverFrom(runtime: Runtime, flag: unknown): string {
  const raw = str(flag) ?? runtime.io.env.ROOSTER_SERVER ?? runtime.profile.server;
  if (raw === undefined || raw === '') throw new CliError(EXIT.usage, t('login.serverMissing'));
  return normalizeServer(raw);
}

export const loginCommand = defineCommand({
  meta: () => ({ name: 'login', description: t('cmd.login') }),
  args: () => ({
    server: { type: 'string', valueHint: 'url', description: t('login.arg.server') },
    'with-token': { type: 'boolean', description: t('login.arg.withToken') },
    browser: { type: 'boolean', default: true, negativeDescription: t('login.arg.noBrowser') },
    scope: { type: 'string', valueHint: 'scope,…', description: t('login.arg.scope') },
    org: { type: 'string', valueHint: 'slug', description: t('login.arg.org') },
  }),
  async run({ args, rawArgs }) {
    const runtime = rt();
    const { out } = runtime;
    const server = serverFrom(runtime, args.server);
    const orgs = multi(rawArgs, 'org');
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

    const meta = await fetchMeta(runtime, server);
    warnOnVersion(runtime, meta.version);
    const requested = multi(rawArgs, 'scope');
    const scopes = requested.length === 0 ? [...DEFAULT_LOGIN_SCOPES] : parseScopes(requested);
    const { status, data } = await authPost(runtime, server, '/device/code', {
      client_id: CLI_CLIENT_ID,
      scope: scopes.join(' '),
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
    const code = data as unknown as DeviceCode;
    const url = code.verification_uri_complete ?? code.verification_uri;
    out.notice(t('login.instructions', { url: code.verification_uri, code: code.user_code }));
    // The code goes to stdout on its own line too, so scripts and tests can read it.
    out.line(`${t('login.codeLabel')} ${paint(code.user_code, styles.accent, out.level)}`);
    if (args.browser !== false) {
      const href = openableUrl(url, server);
      if (href !== null) await runtime.io.openUrl(href);
      else out.notice(t('open.notOpened'));
    }
    out.notice(t('login.waiting'));
    const token = await pollForToken(runtime, server, code);
    const me = await finishLogin(runtime, server, token, orgFlag);
    if (out.json) out.data({ server, profile: runtime.profileName, user: me.email });
    else
      out.notice(
        t('login.done', { name: clean(me.name), email: me.email, profile: runtime.profileName }),
      );
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
    const token = await runtime.secrets.get(runtime.profileName);
    if (token === undefined) {
      out.notice(t('logout.notLoggedIn', { profile: runtime.profileName }));
      return;
    }
    // A device login is this CLI's own grant: revoke it. A PAT may be in use elsewhere
    // (CI), so it is only forgotten here; `rooster token revoke` ends it.
    let revoked = false;
    const server = runtime.serverOrNull();
    if (server !== null) {
      try {
        const grant = await currentGrant(runtime);
        if (grant !== null && grant.kind === 'device') {
          await grantsApi.remove(await runtime.api(), grant.id);
          revoked = true;
        } else if (grant !== null && grant.kind === 'pat') {
          out.notice(t('logout.patKept', { prefix: grant.tokenPrefix ?? grant.id }));
        }
      } catch {
        out.warn(t('logout.revokeFailed'));
      }
    }
    await runtime.secrets.delete(runtime.profileName);
    runtime.config.updateProfile(runtime.profileName, ({ user: _user, ...profile }) => profile);
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
  const token = server === null ? undefined : await runtime.token().catch(() => undefined);
  if (server !== null && token !== undefined) {
    serverVersion = await fetchMeta(runtime, server)
      .then((meta) => meta.version)
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
