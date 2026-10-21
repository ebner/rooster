import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { clean } from './output/color.ts';

/** The MCP clients `rooster mcp setup --client` knows (07 §4). */
export const MCP_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'print'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** A profile name that is safe as a config key and as a shell word. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * What an MCP client runs: only the command and its arguments, never a token. The token
 * stays in the profile's credential store (ADR 0039 §7).
 */
export interface McpServerEntry {
  command: string;
  args: string[];
}

/** The key in `mcpServers`: `rooster` for the default `agent` profile, else `rooster-<profile>`. */
export function serverKey(profile: string): string {
  return profile === 'agent' ? 'rooster' : `rooster-${profile}`;
}

export interface LaunchContext {
  /** `process.execPath`: node, or the single-file binary itself. */
  execPath: string;
  /**
   * `process.argv[1]`: the script node (or Bun) runs. In a Bun single-file binary it is a path
   * in Bun's virtual file system, which is how such a binary is recognised, whatever its file
   * is called: `process.versions.bun` alone also exists when Bun runs an ordinary script.
   */
  script: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  realpath?: (path: string) => string;
  isExecutable?: (path: string) => boolean;
}

const defaultRealpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const defaultIsExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Bun's virtual file system, where a compiled binary's own script lives. */
const BUNFS_RE = /^(\/\$bunfs\/|[A-Z]:\\~BUN\\)/i;
/** TypeScript run through a loader (tsx: `pnpm --filter @rooster/cli dev`). */
const SOURCE_RE = /\.[cm]?tsx?$/i;

/**
 * The CLI runs from TypeScript sources through a loader that a client's plain `node` would not
 * have: setup refuses rather than write a command that cannot start.
 */
export class SourceLaunchError extends Error {
  constructor(readonly script: string) {
    super(script);
    this.name = 'SourceLaunchError';
  }
}

/**
 * The absolute command that starts this CLI again, for an MCP client's config:
 * - a single-file binary runs itself, under whatever name it has;
 * - from TypeScript sources (a dev run), `SourceLaunchError`;
 * - a `rooster` on `PATH` that resolves to the running script (an npm install) is used by
 *   its absolute path, which survives the node binary moving;
 * - otherwise node plus the absolute script.
 * Absolute paths, so the client never resolves `rooster` through its own (different) PATH.
 */
export function launchCommand(
  ctx: LaunchContext,
  profile: string,
  /** Words after `mcp`: none for the stdio server, `header` for the header helper. */
  sub: readonly string[] = [],
): McpServerEntry {
  const realpath = ctx.realpath ?? defaultRealpath;
  const isExecutable = ctx.isExecutable ?? defaultIsExecutable;
  const args = ['mcp', ...sub, '--profile', profile];
  if (ctx.script !== undefined && BUNFS_RE.test(ctx.script)) {
    return { command: ctx.execPath, args };
  }
  if (ctx.script !== undefined && SOURCE_RE.test(ctx.script))
    throw new SourceLaunchError(ctx.script);
  const script =
    ctx.script !== undefined && isAbsolute(ctx.script) ? realpath(ctx.script) : undefined;
  if (script !== undefined && ctx.platform !== 'win32') {
    for (const dir of (ctx.env.PATH ?? '').split(delimiter)) {
      if (dir === '' || !isAbsolute(dir)) continue;
      const candidate = join(dir, 'rooster');
      if (isExecutable(candidate) && realpath(candidate) === script) {
        return { command: candidate, args };
      }
    }
  }
  if (script === undefined) return { command: ctx.execPath, args };
  return { command: ctx.execPath, args: [script, ...args] };
}

/**
 * Where a client keeps its MCP servers, for the clients whose config file `setup` edits.
 * Claude Code has an official command (`claude mcp add`), so setup prints that instead.
 */
export function clientConfigPath(
  client: 'claude-desktop' | 'cursor',
  ctx: {
    homedir: string;
    platform: NodeJS.Platform;
    env: Readonly<Record<string, string | undefined>>;
  },
): string {
  if (client === 'cursor') return join(ctx.homedir, '.cursor', 'mcp.json');
  if (ctx.platform === 'darwin') {
    return join(
      ctx.homedir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA || join(ctx.homedir, 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  const config = ctx.env.XDG_CONFIG_HOME || join(ctx.homedir, '.config');
  return join(config, 'Claude', 'claude_desktop_config.json');
}

/** A config file that is not the JSON object an MCP client expects: left untouched. */
export class ConfigFormatError extends Error {
  constructor(readonly reason: 'json' | 'shape') {
    super(reason);
    this.name = 'ConfigFormatError';
  }
}

export type MergeStatus = 'added' | 'updated' | 'unchanged';

function sameEntry(a: unknown, b: McpServerEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The config text with `mcpServers[key]` set to `entry`, every other key kept as it was (in
 * order). `existing` null is a new file. Indentation follows the file (two spaces when new).
 */
export function mergeMcpEntry(
  existing: string | null,
  key: string,
  entry: McpServerEntry,
): { text: string; status: MergeStatus; previous: unknown } {
  let root: Record<string, unknown> = {};
  let indent: string | number = 2;
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new ConfigFormatError('json');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigFormatError('shape');
    }
    root = parsed as Record<string, unknown>;
    const match = /\n([ \t]+)"/.exec(existing);
    if (match?.[1] !== undefined) indent = match[1];
  }
  const servers = root.mcpServers ?? {};
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new ConfigFormatError('shape');
  }
  const current = Object.hasOwn(servers, key)
    ? (servers as Record<string, unknown>)[key]
    : undefined;
  if (current !== undefined && sameEntry(current, entry)) {
    return { text: existing ?? '', status: 'unchanged', previous: current };
  }
  // `defineProperty`, not assignment: a key such as `__proto__` stays a plain data key.
  const nextServers: Record<string, unknown> = { ...(servers as Record<string, unknown>) };
  Object.defineProperty(nextServers, key, {
    value: { command: entry.command, args: [...entry.args] },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const next = { ...root, mcpServers: nextServers };
  return {
    text: `${JSON.stringify(next, null, indent)}\n`,
    status: current === undefined ? 'added' : 'updated',
    previous: current,
  };
}

/** A Windows word that needs no quotes in PowerShell or in cmd. */
const WIN_BARE_RE = /^[A-Za-z0-9_.:\\/-]+$/;
/**
 * What double quotes do not make literal in both Windows shells: `$` and the backtick expand in
 * PowerShell (which also ends a string at “ ” „), `%` and `!` expand in cmd, and a trailing
 * backslash escapes the closing quote for the program's own argument parsing. Control and bidi
 * characters are refused too (`clean`).
 */
const WIN_UNSAFE_RE = /[$`%!"“”„\n\t]|\\$/;

/**
 * One argument for a POSIX shell (single quotes), or for Windows, where the same line must be
 * literal whether it is pasted into PowerShell or cmd: double quotes, and null for a word no
 * quoting makes literal in both (the caller then offers the JSON config instead).
 */
export function shellQuote(word: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') {
    if (WIN_BARE_RE.test(word)) return word;
    return WIN_UNSAFE_RE.test(word) || clean(word) !== word ? null : `"${word}"`;
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Claude Code's official way to add a server (user scope, so it works in every project), or
 * null when a word cannot be quoted safely for the platform's shells.
 */
export function claudeCodeCommand(
  key: string,
  entry: McpServerEntry,
  platform: NodeJS.Platform,
): string | null {
  const words = [
    'claude',
    'mcp',
    'add',
    '--scope',
    'user',
    key,
    '--',
    entry.command,
    ...entry.args,
  ];
  const quoted: string[] = [];
  for (const word of words) {
    const q = shellQuote(word, platform);
    if (q === null) return null;
    quoted.push(q);
  }
  return quoted.join(' ');
}

/** The JSON snippet for clients configured by hand. */
export function configSnippet(key: string, entry: McpServerEntry): string {
  return JSON.stringify({ mcpServers: { [key]: entry } }, null, 2);
}

// --- the remote endpoint (11 §9.6) ---------------------------------------------------------

/**
 * Claude Code's entry for the remote endpoint: Streamable HTTP (`type: "http"`) with a
 * `headersHelper`, a command Claude Code runs in a shell on every connection (and again after
 * a 401/403), whose stdout must be a JSON object of header names to strings. Never a token.
 */
export interface RemoteServerEntry {
  type: 'http';
  url: string;
  headersHelper: string;
}

/**
 * `rooster mcp header --profile <p>` as one shell command line, every word quoted for the
 * platform's shells; null when a word can't be quoted safely there.
 */
export function headersHelperCommand(
  entry: McpServerEntry,
  platform: NodeJS.Platform,
): string | null {
  const quoted: string[] = [];
  for (const word of [entry.command, ...entry.args]) {
    const q = shellQuote(word, platform);
    if (q === null) return null;
    quoted.push(q);
  }
  return quoted.join(' ');
}

export function remoteEntry(server: string, headersHelper: string): RemoteServerEntry {
  return { type: 'http', url: `${server}/mcp`, headersHelper };
}

/**
 * Claude Code's official command for a JSON entry (`claude mcp add-json`, user scope), so its
 * private files are never edited (ADR 0044 §5); null when the line can't be quoted safely
 * (Windows shells can't take the JSON literally).
 */
export function claudeCodeAddJson(
  key: string,
  entry: RemoteServerEntry,
  platform: NodeJS.Platform,
): string | null {
  const words = ['claude', 'mcp', 'add-json', '--scope', 'user', key, JSON.stringify(entry)];
  const quoted: string[] = [];
  for (const word of words) {
    const q = shellQuote(word, platform);
    if (q === null) return null;
    quoted.push(q);
  }
  return quoted.join(' ');
}

/** The JSON snippet of a remote entry (Claude Code's `.mcp.json` format). */
export function remoteConfigSnippet(key: string, entry: RemoteServerEntry): string {
  return JSON.stringify({ mcpServers: { [key]: entry } }, null, 2);
}

/** A placeholder, never a real token: the user pastes their MCP token there. */
export const MCP_TOKEN_PLACEHOLDER = '<MCP token>';

/**
 * The static-header form for clients without a header helper (11 §9.7). `type: "http"` is
 * Claude Code's spelling; Cursor infers the transport from `url`.
 */
export function staticHeaderSnippet(
  key: string,
  server: string,
  options: { type: boolean } = { type: true },
): string {
  return JSON.stringify(
    {
      mcpServers: {
        [key]: {
          ...(options.type ? { type: 'http' } : {}),
          url: `${server}/mcp`,
          headers: { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}
