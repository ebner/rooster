import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRoosterClient, type RoosterClient } from '@rooster/api-client';
import type { GrantScope } from '@rooster/core/grants';
import { createRoosterMcpServer, listedTools } from '@rooster/mcp';
import { defineCommand } from 'citty';
import { cliFetch, grantsApi } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { currentGrant } from '../grant-info.ts';
import { t } from '../i18n.ts';
import {
  ConfigFormatError,
  claudeCodeCommand,
  clientConfigPath,
  configSnippet,
  launchCommand,
  MCP_CLIENTS,
  type McpClient,
  type McpServerEntry,
  mergeMcpEntry,
  PROFILE_NAME_RE,
  SourceLaunchError,
  serverKey,
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
        io.stderr.write(`${clean(t('mcp.toolFailed', { tool, error: String(error) }))}\n`);
        if (runtime.globals.verbose && error instanceof Error && error.stack) {
          io.stderr.write(`${clean(error.stack)}\n`);
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
    if (error instanceof UnsafePathError) {
      throw fail(`mcp.setup.unsafe.${error.reason}`, { path: error.path });
    }
    if (error instanceof ConfigFormatError) throw fail(`mcp.setup.badConfig.${error.reason}`);
    throw error;
  }
}

function reportSetup(runtime: Runtime, result: SetupResult): void {
  const { out } = runtime;
  if (out.json) {
    out.data(result);
    return;
  }
  const platform = runtime.io.platform;
  switch (result.client) {
    case 'claude-code':
      out.notice(t('mcp.setup.claudeCode'));
      out.line(claudeCodeCommand(result.key, result.entry, platform));
      break;
    case 'print':
      out.notice(t('mcp.setup.printJson'));
      out.line(configSnippet(result.key, result.entry));
      out.notice(t('mcp.setup.claudeCode'));
      out.line(claudeCodeCommand(result.key, result.entry, platform));
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
    // Before signing in: a command that cannot start would make the login useless.
    const entry = launchEntry(runtime, profile);
    const allowDelete = args['allow-delete'] === true;
    const agent = runtime.forProfile(profile);
    await withRuntime(agent, async () => {
      const explicit =
        typeof args.server === 'string' && args.server !== '' ? args.server : undefined;
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
function launchEntry(runtime: Runtime, profile: string): McpServerEntry {
  try {
    return launchCommand(
      {
        execPath: process.execPath,
        compiled: typeof process.versions.bun === 'string',
        script: process.argv[1],
        env: runtime.io.env,
        platform: runtime.io.platform,
      },
      profile,
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
  const grant = await currentGrant(agent);
  if (grant === null) return false;
  return grant.scopes.includes('tasks:delete') === allowDelete;
}

export const mcpCommand = defineCommand({
  meta: () => ({ name: 'mcp', description: t('cmd.mcp') }),
  args: () => ({
    'read-only': { type: 'boolean', description: t('mcp.arg.readOnly') },
  }),
  subCommands: { setup: setupCommand },
  async run({ args }) {
    // citty runs this after a subcommand too; `setup` has done its work by then.
    if (positionals(args)[0] === 'setup') return;
    await serveOnStdio(rt(), { readOnly: args['read-only'] === true });
  },
});
