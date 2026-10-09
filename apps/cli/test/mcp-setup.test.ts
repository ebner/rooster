import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigFormatError,
  claudeCodeCommand,
  clientConfigPath,
  launchCommand,
  mergeMcpEntry,
  SourceLaunchError,
  serverKey,
  shellQuote,
} from '../src/mcp-config.ts';
import { readRegularFile, UnsafePathError, writeAll, writeFileAtomic } from '../src/safe-write.ts';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer } from './support/rooster-server.ts';

describe('launchCommand', () => {
  const base = {
    compiled: false,
    env: { PATH: '/usr/local/bin:/usr/bin' },
    platform: 'linux' as const,
    realpath: (p: string) => (p === '/usr/local/bin/rooster' ? '/opt/rooster/dist/rooster.mjs' : p),
  };

  it('a single-file binary runs itself', () => {
    expect(
      launchCommand(
        { ...base, execPath: '/home/a/bin/rooster', script: '/$bunfs/root/rooster' },
        'agent',
      ),
    ).toEqual({ command: '/home/a/bin/rooster', args: ['mcp', '--profile', 'agent'] });
  });

  it('a compiled binary runs itself whatever it is called, never with its virtual script', () => {
    expect(
      launchCommand(
        {
          ...base,
          compiled: true,
          execPath: '/dl/rooster-1.2.0-linux-x64',
          script: '/$bunfs/root/rooster-1.2.0-linux-x64',
        },
        'agent',
      ),
    ).toEqual({ command: '/dl/rooster-1.2.0-linux-x64', args: ['mcp', '--profile', 'agent'] });
    // Recognised by Bun's virtual paths too, on POSIX and Windows.
    for (const script of ['/$bunfs/root/x', 'B:\\~BUN\\root\\x.exe']) {
      expect(launchCommand({ ...base, execPath: '/dl/x', script }, 'agent').args).toEqual([
        'mcp',
        '--profile',
        'agent',
      ]);
    }
  });

  it('a run from TypeScript sources (tsx) is refused rather than writing a command that fails', () => {
    for (const script of ['/repo/apps/cli/src/main.ts', '/repo/x.mts', '/repo/x.tsx']) {
      expect(() => launchCommand({ ...base, execPath: '/usr/bin/node', script }, 'agent')).toThrow(
        SourceLaunchError,
      );
    }
  });

  it('an npm install is found on PATH by its real path', () => {
    expect(
      launchCommand(
        {
          ...base,
          execPath: '/usr/bin/node',
          script: '/opt/rooster/dist/rooster.mjs',
          isExecutable: () => true,
        },
        'agent',
      ),
    ).toEqual({ command: '/usr/local/bin/rooster', args: ['mcp', '--profile', 'agent'] });
  });

  it('otherwise node plus the absolute script', () => {
    expect(
      launchCommand(
        {
          ...base,
          execPath: '/usr/bin/node',
          script: '/src/rooster/dist/rooster.mjs',
          isExecutable: () => false,
        },
        'work',
      ),
    ).toEqual({
      command: '/usr/bin/node',
      args: ['/src/rooster/dist/rooster.mjs', 'mcp', '--profile', 'work'],
    });
  });

  it('ignores relative PATH entries', () => {
    const seen: string[] = [];
    launchCommand(
      {
        ...base,
        env: { PATH: '.:bin:/usr/local/bin' },
        execPath: '/usr/bin/node',
        script: '/x.mjs',
        isExecutable: (p) => {
          seen.push(p);
          return false;
        },
      },
      'agent',
    );
    expect(seen).toEqual(['/usr/local/bin/rooster']);
  });
});

describe('client config helpers', () => {
  it('names the server rooster for the agent profile, rooster-<profile> otherwise', () => {
    expect(serverKey('agent')).toBe('rooster');
    expect(serverKey('work')).toBe('rooster-work');
  });

  it('finds each client config file per platform', () => {
    const env = {};
    expect(clientConfigPath('cursor', { homedir: '/h', platform: 'linux', env })).toBe(
      '/h/.cursor/mcp.json',
    );
    expect(clientConfigPath('claude-desktop', { homedir: '/h', platform: 'darwin', env })).toBe(
      '/h/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(
      clientConfigPath('claude-desktop', {
        homedir: '/h',
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/c' },
      }),
    ).toBe('/c/Claude/claude_desktop_config.json');
  });

  it('quotes shell words', () => {
    expect(shellQuote('/usr/bin/node', 'linux')).toBe('/usr/bin/node');
    expect(shellQuote("/Users/o'neil/My Apps/rooster", 'darwin')).toBe(
      `'/Users/o'\\''neil/My Apps/rooster'`,
    );
    expect(shellQuote('C:\\Program Files\\rooster.exe', 'win32')).toBe(
      '"C:\\Program Files\\rooster.exe"',
    );
    expect(
      claudeCodeCommand('rooster', { command: '/a b/node', args: ['/x.mjs', 'mcp'] }, 'linux'),
    ).toBe("claude mcp add --scope user rooster -- '/a b/node' /x.mjs mcp");
  });

  it('merges without touching other keys, keeping the indentation', () => {
    const existing =
      '{\n    "theme": "dark",\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}\n';
    const entry = { command: '/bin/rooster', args: ['mcp'] };
    const merged = mergeMcpEntry(existing, 'rooster', entry);
    expect(merged.status).toBe('added');
    expect(JSON.parse(merged.text)).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'x' }, rooster: entry },
    });
    expect(merged.text).toContain('\n    "theme"');
    expect(mergeMcpEntry(merged.text, 'rooster', entry).status).toBe('unchanged');
    expect(mergeMcpEntry(merged.text, 'rooster', { ...entry, args: ['mcp', '-x'] }).status).toBe(
      'updated',
    );
  });

  it('refuses what is not a JSON object with an mcpServers object', () => {
    const entry = { command: 'r', args: [] };
    expect(() => mergeMcpEntry('{ "a": 1, // comment\n}', 'rooster', entry)).toThrow(
      ConfigFormatError,
    );
    expect(() => mergeMcpEntry('[]', 'rooster', entry)).toThrow(ConfigFormatError);
    expect(() => mergeMcpEntry('{"mcpServers": []}', 'rooster', entry)).toThrow(ConfigFormatError);
    expect(mergeMcpEntry(null, 'rooster', entry).status).toBe('added');
    expect(mergeMcpEntry('  ', 'rooster', entry).status).toBe('added');
  });

  it('a __proto__ key stays a plain key', () => {
    const merged = mergeMcpEntry('{}', '__proto__', { command: 'r', args: [] });
    expect(Object.keys(JSON.parse(merged.text).mcpServers)).toEqual(['__proto__']);
  });
});

describe('rooster mcp setup from sources', () => {
  it('exits 2 before signing in, naming the built CLI', () => {
    const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const cli = cliHarness();
    try {
      const run = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          join(cliDir, 'src/main.ts'),
          'mcp',
          'setup',
          '--server',
          'https://rooster.test',
        ],
        {
          cwd: cliDir,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: cli.home,
            XDG_CONFIG_HOME: join(cli.home, 'config'),
            ROOSTER_KEYRING: 'off',
            LANG: 'en_US.UTF-8',
          },
        },
      );
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('TypeScript sources');
      expect(run.stdout).not.toContain('Code:');
    } finally {
      cli.cleanup();
    }
  });
});

describe('writeAll', () => {
  let cli: CliHarness;
  beforeAll(() => {
    cli = cliHarness();
  });
  afterAll(() => cli.cleanup());

  it('keeps writing after short writes', () => {
    const file = join(cli.home, 'short.txt');
    const fd = openSync(file, 'w');
    const data = Buffer.from('x'.repeat(4204));
    try {
      writeAll(fd, data, (f, b, o, l) => writeSync(f, b, o, Math.min(l, 1000)));
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, 'utf8')).toBe(data.toString());
  });

  it('fails when nothing more can be written', () => {
    let calls = 0;
    expect(() =>
      writeAll(0, Buffer.from('abc'), () => {
        calls++;
        return calls === 1 ? 1 : 0;
      }),
    ).toThrow('short write');
  });
});

describe('writeFileAtomic', () => {
  let cli: CliHarness;
  beforeAll(() => {
    cli = cliHarness();
  });
  afterAll(() => cli.cleanup());

  it('keeps the permissions and a backup, and leaves no temp files', () => {
    const file = join(cli.home, 'keep', 'config.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'old\n');
    chmodSync(file, 0o640);
    const previous = readRegularFile(file);
    const { backup } = writeFileAtomic(file, 'new\n', {
      previous,
      newMode: 0o600,
      backup: true,
      now: 0,
    });
    expect(readFileSync(file, 'utf8')).toBe('new\n');
    expect(lstatSync(file).mode & 0o777).toBe(0o640);
    expect(backup).not.toBeNull();
    expect(readFileSync(backup ?? '', 'utf8')).toBe('old\n');
    expect(lstatSync(backup ?? '').mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a new file gets the new mode, regardless of the umask', () => {
    const file = join(cli.home, 'new', 'config.json');
    writeFileAtomic(file, '{}\n', { previous: null, newMode: 0o600, backup: true, now: 0 });
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it('writes nothing when the file changed after it was read', () => {
    const file = join(cli.home, 'race', 'config.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'one');
    const previous = readRegularFile(file);
    writeFileSync(file, 'someone else wrote this');
    expect(() =>
      writeFileAtomic(file, 'mine', { previous, newMode: 0o600, backup: true, now: 0 }),
    ).toThrow(UnsafePathError);
    expect(readFileSync(file, 'utf8')).toBe('someone else wrote this');
    expect(readdirSync(dirname(file))).toEqual(['config.json']);
  });

  it('writes nothing when a file appeared that was not there', () => {
    const file = join(cli.home, 'appeared', 'config.json');
    mkdirSync(dirname(file), { recursive: true });
    const previous = readRegularFile(file);
    writeFileSync(file, 'new arrival');
    expect(() =>
      writeFileAtomic(file, 'mine', { previous, newMode: 0o600, backup: false, now: 0 }),
    ).toThrow(UnsafePathError);
    expect(readFileSync(file, 'utf8')).toBe('new arrival');
  });

  it('refuses a write after a chmod, and removes the backup it made', () => {
    const file = join(cli.home, 'chmod', 'config.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'secret');
    chmodSync(file, 0o644);
    const previous = readRegularFile(file);
    chmodSync(file, 0o600);
    expect(() =>
      writeFileAtomic(file, 'mine', { previous, newMode: 0o600, backup: true, now: 0 }),
    ).toThrow(UnsafePathError);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(file))).toEqual(['config.json']);

    // The same change between the backup and the rename: refused, and no 0644 copy is left.
    chmodSync(file, 0o644);
    const again = readRegularFile(file);
    expect(() =>
      writeFileAtomic(file, 'mine', {
        previous: again,
        newMode: 0o600,
        backup: true,
        now: 0,
        beforeCommit: () => chmodSync(file, 0o600),
      }),
    ).toThrow(UnsafePathError);
    expect(readFileSync(file, 'utf8')).toBe('secret');
    expect(readdirSync(dirname(file))).toEqual(['config.json']);
  });

  it('noLinksBelow: a directory swapped for a link before the rename is caught', () => {
    const project = join(cli.home, 'project');
    const outside = join(cli.home, 'outside');
    mkdirSync(outside, { recursive: true });
    const file = join(project, '.agents', 'skills', 'rooster', 'SKILL.md');
    expect(() =>
      writeFileAtomic(file, 'skill', {
        previous: null,
        newMode: 0o644,
        backup: false,
        now: 0,
        noLinksBelow: project,
        beforeCommit: () => {
          const dir = dirname(file);
          renameSync(dir, `${dir}-moved`);
          symlinkSync(outside, dir);
        },
      }),
    ).toThrow(UnsafePathError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('noLinksBelow: a link already on the way is refused before anything is written', () => {
    const project = join(cli.home, 'project2');
    const outside = join(cli.home, 'outside2');
    mkdirSync(join(project, '.agents'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(project, '.agents', 'skills'));
    const file = join(project, '.agents', 'skills', 'rooster', 'SKILL.md');
    expect(() =>
      writeFileAtomic(file, 'skill', {
        previous: null,
        newMode: 0o644,
        backup: false,
        now: 0,
        noLinksBelow: project,
      }),
    ).toThrow(UnsafePathError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a config directory swapped before the rename is caught (links allowed, identity pinned)', () => {
    const real = join(cli.home, 'dotfiles-cursor');
    const outside = join(cli.home, 'outside3');
    mkdirSync(real, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const linked = join(cli.home, '.cursor');
    symlinkSync(real, linked);
    const file = join(linked, 'mcp.json');
    // Through a dotfiles link: fine.
    writeFileAtomic(file, '{}\n', { previous: null, newMode: 0o600, backup: false, now: 0 });
    expect(readFileSync(join(real, 'mcp.json'), 'utf8')).toBe('{}\n');
    const previous = readRegularFile(file);
    expect(() =>
      writeFileAtomic(file, '{"x":1}\n', {
        previous,
        newMode: 0o600,
        backup: false,
        now: 0,
        beforeCommit: () => {
          renameSync(linked, `${linked}-old`);
          symlinkSync(outside, linked);
        },
      }),
    ).toThrow(UnsafePathError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to read through a symlink', () => {
    const target = join(cli.home, 'target.json');
    writeFileSync(target, '{}');
    const link = join(cli.home, 'link.json');
    symlinkSync(target, link);
    expect(() => readRegularFile(link)).toThrow(UnsafePathError);
  });
});

describe('rooster mcp setup (writing client configs)', () => {
  let server: RoosterServer;
  let cli: CliHarness;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server?.close();
  });
  afterEach(() => cli?.cleanup());

  /** A home whose `agent` profile is already signed in, so setup reuses it. */
  async function agentHome(email: string) {
    const user = await server.user(email);
    const { token } = await user.token({
      scopes: ['tasks:write', 'comments:write', 'groups:write', 'notifications:read'],
    });
    cli = cliHarness();
    const login = await cli.run(
      ['login', '--with-token', '--server', server.url, '--profile', 'agent'],
      {
        stdin: token,
      },
    );
    expect(login.code).toBe(0);
    return { token, desktop: join(cli.home, 'config', 'Claude', 'claude_desktop_config.json') };
  }

  it('writes a new Claude Desktop config: 0600, only the command and arguments', async () => {
    const { token, desktop } = await agentHome('setup-new@example.com');
    const run = await cli.run(['mcp', 'setup', '--client', 'claude-desktop']);
    expect(run.stderr).toContain('existing login of profile agent');
    expect(run.code).toBe(0);
    const text = readFileSync(desktop, 'utf8');
    const config = JSON.parse(text) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(['rooster']);
    const entry = config.mcpServers.rooster;
    expect(Object.keys(entry ?? {})).toEqual(['command', 'args']);
    expect(entry?.command.startsWith('/')).toBe(true);
    expect(entry?.args.slice(-3)).toEqual(['mcp', '--profile', 'agent']);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/rooster_pat_|token|Bearer/i);
    expect(lstatSync(desktop).mode & 0o777).toBe(0o600);
    expect(run.stderr).toContain('Restart Claude Desktop');
  });

  it('merges into an existing config, keeps a backup and the permissions; a rerun changes nothing', async () => {
    const { desktop } = await agentHome('setup-merge@example.com');
    mkdirSync(dirname(desktop), { recursive: true });
    const original =
      '{\n  "globalShortcut": "Ctrl+Space",\n  "mcpServers": {\n    "files": { "command": "npx", "args": ["fs"] }\n  }\n}\n';
    writeFileSync(desktop, original);
    chmodSync(desktop, 0o644);
    expect((await cli.run(['mcp', 'setup', '--client', 'claude-desktop'])).code).toBe(0);
    const merged = JSON.parse(readFileSync(desktop, 'utf8'));
    expect(merged.globalShortcut).toBe('Ctrl+Space');
    expect(merged.mcpServers.files).toEqual({ command: 'npx', args: ['fs'] });
    expect(merged.mcpServers.rooster.args.slice(-3)).toEqual(['mcp', '--profile', 'agent']);
    expect(lstatSync(desktop).mode & 0o777).toBe(0o644);
    const backups = readdirSync(dirname(desktop)).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(desktop), backups[0] ?? ''), 'utf8')).toBe(original);

    const again = await cli.run(['mcp', 'setup', '--client', 'claude-desktop']);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain('already set up');
    expect(readdirSync(dirname(desktop)).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
  });

  it('asks before replacing a different rooster entry (--yes replaces it)', async () => {
    const { desktop } = await agentHome('setup-replace@example.com');
    mkdirSync(dirname(desktop), { recursive: true });
    const custom = '{"mcpServers":{"rooster":{"command":"/my/own/rooster","args":["mcp"]}}}';
    writeFileSync(desktop, custom);
    const refused = await cli.run(['mcp', 'setup', '--client', 'claude-desktop']);
    expect(refused.code).toBe(2);
    expect(readFileSync(desktop, 'utf8')).toBe(custom);
    const replaced = await cli.run(['mcp', 'setup', '--client', 'claude-desktop', '--yes']);
    expect(replaced.code).toBe(0);
    expect(JSON.parse(readFileSync(desktop, 'utf8')).mcpServers.rooster.command).not.toBe(
      '/my/own/rooster',
    );
  });

  it('refuses a symlinked config and leaves its target alone', async () => {
    const { desktop } = await agentHome('setup-link@example.com');
    mkdirSync(dirname(desktop), { recursive: true });
    const target = join(cli.home, 'elsewhere.json');
    writeFileSync(target, '{}');
    symlinkSync(target, desktop);
    const run = await cli.run(['mcp', 'setup', '--client', 'claude-desktop']);
    expect(run.code).toBe(5);
    expect(run.stderr).toContain('symbolic link');
    expect(readFileSync(target, 'utf8')).toBe('{}');
    expect(lstatSync(desktop).isSymbolicLink()).toBe(true);
  });

  it('leaves a config that is not valid JSON untouched', async () => {
    const { desktop } = await agentHome('setup-json@example.com');
    mkdirSync(dirname(desktop), { recursive: true });
    writeFileSync(desktop, '{ broken');
    const run = await cli.run(['mcp', 'setup', '--client', 'claude-desktop']);
    expect(run.code).toBe(5);
    expect(run.stderr).toContain('isn’t valid JSON');
    expect(readFileSync(desktop, 'utf8')).toBe('{ broken');
  });

  it('cursor writes ~/.cursor/mcp.json; claude-code only prints the official command', async () => {
    await agentHome('setup-clients@example.com');
    expect((await cli.run(['mcp', 'setup', '--client', 'cursor'])).code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(cli.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.rooster,
    ).toBeDefined();
    const code = await cli.run(['mcp', 'setup', '--client', 'claude-code']);
    expect(code.code).toBe(0);
    expect(code.stdout).toMatch(/^claude mcp add --scope user rooster -- \S+/m);
    expect(existsSync(join(cli.home, '.claude.json'))).toBe(false);
  });

  it('rejects an unknown client, an unsafe profile name and ROOSTER_TOKEN', async () => {
    cli = cliHarness();
    expect((await cli.run(['mcp', 'setup', '--client', 'vim'])).code).toBe(2);
    expect((await cli.run(['mcp', 'setup', '--profile', 'a b'])).code).toBe(2);
    const env = await cli.run(['mcp', 'setup'], { env: { ROOSTER_TOKEN: 'x' } });
    expect(env.code).toBe(2);
    expect(env.stderr).toContain('ROOSTER_TOKEN');
  });
});
