import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRoosterClient, type RoosterClient } from '@rooster/api-client';
import type { GrantScope } from '@rooster/core/grants';
import { createRoosterMcpServer, listedTools } from '@rooster/mcp';
import { defineCommand } from 'citty';
import { cliFetch, grantsApi } from '../api.ts';
import { normalizeServer } from '../config.ts';
import { safeDiagnostic } from '../diagnostics.ts';
import { CliError, EXIT } from '../errors.ts';
import { currentGrant } from '../grant-info.ts';
import { t } from '../i18n.ts';
import {
  ConfigFormatError,
  claudeCodeAddJson,
  claudeCodeCommand,
  clientConfigPath,
  configSnippet,
  headersHelperCommand,
  launchCommand,
  MCP_CLIENTS,
  MCP_TOKEN_PLACEHOLDER,
  type McpClient,
  type McpServerEntry,
  mergeMcpEntry,
  PROFILE_NAME_RE,
  type RemoteServerEntry,
  remoteConfigSnippet,
  remoteEntry,
  SourceLaunchError,
  serverKey,
  staticHeaderSnippet,
} from '../mcp-config.ts';
import { clean } from '../output/color.ts';
import { type Runtime, rt, withRuntime } from '../runtime.ts';
import { readRegularFile, UnsafePathError, writeFileAtomic } from '../safe-write.ts';
import { CLI_VERSION } from '../version.ts';
import { deviceLogin, serverFrom } from './auth.ts';
import { confirmOrAbort, positionals } from './util.ts';

/** `X-Rooster-Client` for MCP traffic, so activity shows `via: mcp` (06 §1). */
export const MCP_CLIENT_NAME = `mcp/${CLI_VERSION}`;

/**
 * What `rooster mcp setup` asks for (11 §5.1, ADR 0041): enough to plan, capture, triage and
 * comment, but not to assign others; deleting only with `--allow-delete`.
 */
export const MCP_SETUP_SCOPES: readonly GrantScope[] = [
  'tasks:read',
  'tasks:write',
  'comments:write',
  'notifications:read',
  'groups:write',
];

/** The default profile of `rooster mcp setup` (07 §4). */
export const MCP_DEFAULT_PROFILE = 'agent';

/** An API client for MCP: the profile's credential, read per request, labelled `mcp/<v>`. */
export function mcpApiClient(runtime: Runtime, server: string): RoosterClient {
  return createRoosterClient({
    baseUrl: server,
    // Read per request, like every CLI call: a newer login is used, a logout ends access, and
    // the token is never sent to another origin (ADR 0039 §7).
    token: () => runtime.token(server),
    clientName: MCP_CLIENT_NAME,
    clientId: runtime.clientId,
    fetch: cliFetch({ io: runtime.io, verbose: runtime.globals.verbose, server }),
  });
}

export interface McpServeOptions {
  readOnly: boolean;
}

/**
 * The factory `rooster mcp` serves: one MCP server over the profile's credential, listing the
 * tools its grant allows (`granted`, ADR 0042 §6). Fails before serving when there is no
 * login or its grant can't be read.
 */
export async function mcpServerFactory(
  runtime: Runtime,
  options: McpServeOptions,
): Promise<{ factory: () => McpServer; scopes: readonly GrantScope[] }> {
  const server = runtime.server();
  if ((await runtime.token(server)) === undefined) {
    throw new CliError(EXIT.auth, t('auth.notLoggedIn'));
  }
  const client = mcpApiClient(runtime, server);
  const grant = (await grantsApi.list(client)).find((g) => g.current) ?? null;
  if (grant === null) throw new CliError(EXIT.auth, t('mcp.noGrant'));
  const scopes = grant.scopes;
  const io = runtime.io;
  const factory = () =>
    createRoosterMcpServer({
      client,
      listing: { mode: 'granted', scopes },
      readOnly: options.readOnly,
      defaultOrg: runtime.orgRef(),
      instanceUrl: server,
      version: CLI_VERSION,
      now: () => io.now(),
      onError: (error, tool) => {
        // stderr only: stdout belongs to the protocol.
        io.stderr.write(
          `${clean(t('mcp.toolFailed', { tool, error: safeDiagnostic(String(error), runtime) }))}\n`,
        );
        if (runtime.globals.verbose && error instanceof Error && error.stack) {
          io.stderr.write(`${safeDiagnostic(error.stack, runtime)}\n`);
        }
      },
    });
  return { factory, scopes };
}

/**
 * `rooster mcp`: serves the tools on this process's stdin/stdout until stdin closes. Nothing
 * else may write to stdout, so console output is sent to stderr while serving.
 */
async function serveOnStdio(runtime: Runtime, options: McpServeOptions): Promise<void> {
  const { factory, scopes } = await mcpServerFactory(runtime, options);
  if (
    listedTools({ listing: { mode: 'granted', scopes }, readOnly: options.readOnly }).length === 0
  ) {
    runtime.out.warn(t('mcp.noTools'));
  }
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  const closed = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  const handle = serveStdio(factory, {
    onerror: (error) =>
      process.stderr.write(`${clean(t('mcp.transportError', { error: String(error) }))}\n`),
  });
  await closed;
  await handle.close();
}

// --- setup ---------------------------------------------------------------------------------

interface SetupResult {
  client: McpClient;
  key: string;
  entry: McpServerEntry;
  file?: string;
  status?: 'added' | 'updated' | 'unchanged';
  backup?: string | null;
}

/**
 * Adds rooster to a client's JSON config (11 §5.1): merged, never clobbered; the previous file
 * kept as a backup; written atomically with its own permissions; never through a symlink; only
 * the command and arguments, never a token.
 */
export async function writeClientConfig(
  runtime: Runtime,
  client: 'claude-desktop' | 'cursor',
  key: string,
  entry: McpServerEntry,
): Promise<SetupResult> {
  const io = runtime.io;
  const file = clientConfigPath(client, {
    homedir: io.homedir,
    platform: io.platform,
    env: io.env,
  });
  const fail = (key: string, extra: Record<string, string> = {}) =>
    new CliError(EXIT.conflict, t(key, { path: file, ...extra }));
  try {
    const previous = readRegularFile(file);
    const merged = mergeMcpEntry(previous?.text ?? null, key, entry);
    if (merged.status === 'unchanged') return { client, key, entry, file, status: 'unchanged' };
    if (merged.status === 'updated') {
      await confirmOrAbort(runtime, t('mcp.setup.confirmReplace', { key, path: file }));
    }
    const { backup } = writeFileAtomic(file, merged.text, {
      previous,
      newMode: 0o600,
      backup: true,
      now: io.now(),
    });
    return { client, key, entry, file, status: merged.status, backup };
  } catch (error) {
    if (error instanceof UnsafePathError)
      throw new CliError(EXIT.conflict, unsafePathMessage(error));
    if (error instanceof ConfigFormatError) throw fail(`mcp.setup.badConfig.${error.reason}`);
    throw error;
  }
}

/** Why a file was not written, plus any files the attempt had to leave behind. */
export function unsafePathMessage(error: UnsafePathError): string {
  const reason = t(`mcp.setup.unsafe.${error.reason}`, { path: error.path });
  if (error.leftovers.length === 0) return reason;
  return `${reason} ${t('mcp.setup.leftovers', { paths: error.leftovers.join(', ') })}`;
}

function reportSetup(runtime: Runtime, result: SetupResult): void {
  const { out } = runtime;
  if (out.json) {
    out.data(result);
    return;
  }
  const platform = runtime.io.platform;
  // Null when the command path cannot be pasted safely into the platform's shells: the JSON
  // config, which no shell reads, is offered instead.
  const command = claudeCodeCommand(result.key, result.entry, platform);
  switch (result.client) {
    case 'claude-code':
      if (command === null) {
        out.notice(t('mcp.setup.printJson'));
        out.line(configSnippet(result.key, result.entry));
      } else {
        out.notice(t('mcp.setup.claudeCode'));
        out.line(command);
      }
      break;
    case 'print':
      out.notice(t('mcp.setup.printJson'));
      out.line(configSnippet(result.key, result.entry));
      if (command !== null) {
        out.notice(t('mcp.setup.claudeCode'));
        out.line(command);
      }
      break;
    default: {
      const app = t(`mcp.setup.app.${result.client}`);
      if (result.status === 'unchanged')
        out.notice(t('mcp.setup.unchanged', { app, path: result.file ?? '' }));
      else out.notice(t('mcp.setup.written', { app, path: result.file ?? '' }));
      if (result.backup) out.notice(t('mcp.setup.backup', { path: result.backup }));
      if (result.status !== 'unchanged') out.notice(t('mcp.setup.restart', { app }));
    }
  }
  out.notice(t('mcp.setup.skillHint'));
}

const setupCommand = defineCommand({
  meta: () => ({ name: 'setup', description: t('mcp.cmd.setup') }),
  args: () => ({
    client: {
      type: 'string',
      valueHint: MCP_CLIENTS.join('|'),
      description: t('mcp.arg.client'),
    },
    remote: { type: 'boolean', description: t('mcp.arg.remote') },
    'allow-delete': { type: 'boolean', description: t('mcp.arg.allowDelete') },
    relogin: { type: 'boolean', description: t('mcp.arg.relogin') },
    server: { type: 'string', valueHint: 'url', description: t('login.arg.server') },
    browser: { type: 'boolean', default: true, negativeDescription: t('login.arg.noBrowser') },
  }),
  async run({ args }) {
    const runtime = rt();
    const client = (
      typeof args.client === 'string' && args.client !== '' ? args.client : 'print'
    ) as McpClient;
    if (!MCP_CLIENTS.includes(client)) {
      throw new CliError(
        EXIT.usage,
        t('mcp.setup.badClient', { client, clients: MCP_CLIENTS.join(', ') }),
      );
    }
    // A dedicated profile, so the agent never inherits the user's own CLI login (11 §5.1).
    const profile = runtime.globals.profile ?? MCP_DEFAULT_PROFILE;
    if (!PROFILE_NAME_RE.test(profile)) {
      throw new CliError(EXIT.usage, t('mcp.setup.badProfile', { profile }));
    }
    if (runtime.tokenFromEnv()) throw new CliError(EXIT.usage, t('mcp.setup.envToken'));
    const allowDelete = args['allow-delete'] === true;
    const explicit =
      typeof args.server === 'string' && args.server !== '' ? args.server : undefined;
    if (args.remote === true) {
      await remoteSetup(runtime, {
        client,
        profile,
        allowDelete,
        relogin: args.relogin === true,
        server: explicit,
        browser: args.browser !== false,
      });
      return;
    }
    // Before signing in: a command that cannot start would make the login useless.
    const entry = launchEntry(runtime, profile);
    const agent = runtime.forProfile(profile);
    await withRuntime(agent, async () => {
      const server = serverFrom(
        agent,
        explicit ?? agent.profile.server ?? runtime.serverOrNull() ?? undefined,
      );
      const reuse = args.relogin !== true && (await reusableLogin(agent, server, allowDelete));
      if (reuse) agent.out.notice(t('mcp.setup.reusing', { profile }));
      else {
        agent.out.notice(t('mcp.setup.signingIn', { profile }));
        const scopes: GrantScope[] = [
          ...MCP_SETUP_SCOPES,
          ...(allowDelete ? (['tasks:delete'] as const) : []),
        ];
        await deviceLogin(agent, {
          server,
          scopes,
          browser: args.browser !== false,
          makeDefault: false,
        });
      }
      const key = serverKey(profile);
      const result =
        client === 'claude-desktop' || client === 'cursor'
          ? await writeClientConfig(agent, client, key, entry)
          : { client, key, entry };
      reportSetup(agent, result);
    });
  },
});

/** The client's command for this CLI; a run from sources is refused (exit 2). */
function launchEntry(
  runtime: Runtime,
  profile: string,
  sub: readonly string[] = [],
): McpServerEntry {
  try {
    return launchCommand(
      {
        execPath: process.execPath,
        script: process.argv[1],
        env: runtime.io.env,
        platform: runtime.io.platform,
      },
      profile,
      sub,
    );
  } catch (error) {
    if (error instanceof SourceLaunchError) {
      throw new CliError(EXIT.usage, t('mcp.setup.fromSource', { script: error.script }));
    }
    throw error;
  }
}

/**
 * An existing login of the profile on the same server whose grant matches what was asked for
 * (with or without deleting) is kept; anything else signs in again.
 */
async function reusableLogin(
  agent: Runtime,
  server: string,
  allowDelete: boolean,
): Promise<boolean> {
  const stored = await agent.storedLogin().catch(() => undefined);
  if (stored === undefined || agent.serverOrNull() !== server) return false;
  // A login for the remote endpoint can't serve the stdio server, which calls the API.
  if (stored.login.oauth !== undefined && stored.login.oauth.audience !== 'api') return false;
  const grant = await currentGrant(agent);
  if (grant === null) return false;
  return grant.scopes.includes('tasks:delete') === allowDelete;
}

// --- the remote endpoint (11 §9.6) ---------------------------------------------------------

/**
 * `rooster mcp header` answers with an access token valid at least this long: Claude Code
 * keeps the header for the whole connection and runs the helper again only on reconnect or
 * after a 401/403.
 */
export const HEADER_MIN_VALIDITY_MS = 5 * 60_000;
/**
 * Claude Code gives a header helper 10 seconds; waiting for another process's refresh of the
 * same profile ends well before that, with an error rather than a kill.
 */
export const HEADER_LOCK_TIMEOUT_MS = 6_000;

interface RemoteSetupOptions {
  client: McpClient;
  profile: string;
  allowDelete: boolean;
  relogin: boolean;
  server: string | undefined;
  browser: boolean;
}

/**
 * `rooster mcp setup --remote`: clients that run a header helper (Claude Code) get the agent
 * profile signed in through the device grant for `/mcp`, and an entry that connects to
 * `<server>/mcp` with `rooster mcp header` as its helper. Clients without one get MCP tokens
 * explained instead (11 §9.7), with no login.
 */
async function remoteSetup(runtime: Runtime, options: RemoteSetupOptions): Promise<void> {
  const { client, profile } = options;
  const key = serverKey(profile);
  if (client === 'claude-desktop' || client === 'cursor') {
    const server = serverFrom(runtime, options.server ?? runtime.serverOrNull() ?? undefined);
    explainMcpTokens(runtime, client, key, server);
    return;
  }
  const agent = runtime.forProfile(profile);
  await withRuntime(agent, async () => {
    const server = serverFrom(
      agent,
      options.server ?? agent.profile.server ?? runtime.serverOrNull() ?? undefined,
    );
    // The helper names the server it is for: if the profile is later signed in to another
    // server, this client's helper refuses rather than hand that server's token to this one.
    // Built before signing in: a helper command that cannot start would make the login useless.
    const helper = headersHelperCommand(
      launchEntry(runtime, profile, ['header', '--server', server]),
      runtime.io.platform,
    );
    if (helper === null) throw new CliError(EXIT.usage, t('mcp.remote.unquotable'));
    const reuse = !options.relogin && (await reusableRemoteLogin(agent, server, options));
    if (reuse) agent.out.notice(t('mcp.setup.reusing', { profile }));
    else {
      const previous = await agent.storedLogin().catch(() => undefined);
      if (previous !== undefined && previous.login.oauth?.audience !== 'mcp') {
        agent.out.warn(t('mcp.remote.replacesLogin', { profile }));
      }
      agent.out.notice(t('mcp.setup.signingIn', { profile }));
      await deviceLogin(agent, {
        server,
        scopes: [...MCP_SETUP_SCOPES, ...(options.allowDelete ? (['tasks:delete'] as const) : [])],
        browser: options.browser,
        makeDefault: false,
        audience: 'mcp',
      });
    }
    reportRemote(agent, client, key, remoteEntry(server, helper));
  });
}

/**
 * An existing `/mcp` login of the profile on the same server, with or without deleting as
 * asked, whose grant still works (a refresh is tried when due).
 */
async function reusableRemoteLogin(
  agent: Runtime,
  server: string,
  options: RemoteSetupOptions,
): Promise<boolean> {
  const stored = await agent.storedLogin().catch(() => undefined);
  const oauth = stored?.login.oauth;
  if (oauth === undefined || oauth.audience !== 'mcp' || agent.serverOrNull() !== server) {
    return false;
  }
  if (oauth.scopes.includes('tasks:delete') !== options.allowDelete) return false;
  try {
    return (await agent.token(server, { audience: 'mcp', ignoreEnv: true })) !== undefined;
  } catch {
    return false;
  }
}

function reportRemote(
  runtime: Runtime,
  client: McpClient,
  key: string,
  entry: RemoteServerEntry,
): void {
  const { out } = runtime;
  if (out.json) {
    out.data({ client, key, entry });
    return;
  }
  const command = claudeCodeAddJson(key, entry, runtime.io.platform);
  if (client === 'claude-code' && command !== null) {
    out.notice(t('mcp.setup.claudeCode'));
    out.line(command);
  } else {
    out.notice(t('mcp.remote.printJson'));
    out.line(remoteConfigSnippet(key, entry));
    if (command !== null) {
      out.notice(t('mcp.setup.claudeCode'));
      out.line(command);
    }
  }
  out.notice(t('mcp.remote.helperNote', { profile: runtime.profileName }));
  if (client === 'print') out.notice(t('mcp.remote.otherClients', { url: entry.url }));
  out.notice(t('mcp.setup.skillHint'));
}

/** For clients without a header helper: MCP tokens (11 §9.7), or the browser sign-in. */
function explainMcpTokens(
  runtime: Runtime,
  client: 'claude-desktop' | 'cursor',
  key: string,
  server: string,
): void {
  const { out } = runtime;
  const url = `${server}/mcp`;
  const app = t(`mcp.setup.app.${client}`);
  if (client === 'claude-desktop') {
    if (out.json) out.data({ client, key, url });
    else out.notice(t('mcp.remote.desktop', { app, url }));
    return;
  }
  const snippet = staticHeaderSnippet(key, server, { type: false });
  if (out.json) {
    out.data({ client, key, url, config: JSON.parse(snippet) as unknown });
    return;
  }
  out.notice(t('mcp.remote.noHelper', { app }));
  out.line(snippet);
  out.notice(t('mcp.remote.tokenHint', { placeholder: MCP_TOKEN_PLACEHOLDER, url }));
}

const headerCommand = defineCommand({
  meta: () => ({ name: 'header', description: t('mcp.cmd.header') }),
  args: () => ({
    server: { type: 'string', valueHint: 'url', description: t('mcp.arg.headerServer') },
  }),
  /**
   * The header helper (11 §9.6): stdout is exactly `{"Authorization":"Bearer <token>"}`, the
   * JSON object of strings Claude Code's `headersHelper` expects, with a `/mcp` access token
   * of the profile's own login (refreshed under the profile's lock when due). Anything else
   * goes to stderr, and a failure exits non-zero with nothing on stdout.
   */
  async run({ args }) {
    const runtime = rt();
    const profile = runtime.globals.profile ?? MCP_DEFAULT_PROFILE;
    const expected =
      typeof args.server === 'string' && args.server !== '' ? normalizeServer(args.server) : null;
    if (!PROFILE_NAME_RE.test(profile)) {
      throw new CliError(EXIT.usage, t('mcp.setup.badProfile', { profile }));
    }
    const agent = runtime.forProfile(profile);
    const token = await withRuntime(agent, async () => {
      // The profile's own server and login: `ROOSTER_SERVER`/`ROOSTER_TOKEN` in the client's
      // environment never replace them.
      const configured = agent.profile.server;
      if (configured === undefined) {
        throw new CliError(EXIT.auth, t('auth.notRemoteProfile', { profile }));
      }
      const server = normalizeServer(configured);
      // The client's helper is for one server: never another server's token.
      if (expected !== null && expected !== server) {
        throw new CliError(EXIT.auth, t('mcp.header.otherServer', { profile, expected, server }));
      }
      return agent.token(server, {
        audience: 'mcp',
        minValidityMs: HEADER_MIN_VALIDITY_MS,
        ignoreEnv: true,
        lockTimeoutMs: HEADER_LOCK_TIMEOUT_MS,
      });
    });
    if (token === undefined) throw new CliError(EXIT.auth, t('auth.notRemoteProfile', { profile }));
    runtime.io.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
  },
});

export const mcpCommand = defineCommand({
  meta: () => ({ name: 'mcp', description: t('cmd.mcp') }),
  args: () => ({
    'read-only': { type: 'boolean', description: t('mcp.arg.readOnly') },
  }),
  subCommands: { setup: setupCommand, header: headerCommand },
  async run({ args }) {
    // citty runs this after a subcommand too; the subcommand has done its work by then.
    const sub = positionals(args)[0];
    if (sub === 'setup' || sub === 'header') return;
    await serveOnStdio(rt(), { readOnly: args['read-only'] === true });
  },
});
