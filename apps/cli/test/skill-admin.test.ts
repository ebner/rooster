import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { skillMarkdown } from '@rooster/mcp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installSkill, skillPath } from '../src/commands/skill.ts';
import { UnsafePathError } from '../src/safe-write.ts';
import { CLI_VERSION } from '../src/version.ts';
import { FAKE_ENV, fakeApi, ME, problem } from './support/fake-api.ts';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer } from './support/rooster-server.ts';

describe('rooster skill', () => {
  let cli: CliHarness;
  afterEach(() => cli?.cleanup());

  it('print writes the skill for the given server to stdout', async () => {
    cli = cliHarness();
    const run = await cli.run(['skill', 'print', '--server', 'https://tasks.example.com/']);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      skillMarkdown({ instanceUrl: 'https://tasks.example.com', version: CLI_VERSION }),
    );
  });

  it('print without a server says how to give one', async () => {
    cli = cliHarness();
    const run = await cli.run(['skill', 'print']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--server');
  });

  it('install writes ~/.claude/skills/rooster/SKILL.md; again is a no-op', async () => {
    cli = cliHarness();
    const run = await cli.run(['skill', 'install', '--server', 'https://tasks.example.com']);
    expect(run.code).toBe(0);
    const file = join(cli.home, '.claude', 'skills', 'rooster', 'SKILL.md');
    expect(readFileSync(file, 'utf8')).toContain('https://tasks.example.com/mcp');
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
    const again = await cli.run(['skill', 'install', '--server', 'https://tasks.example.com']);
    expect(again.stderr).toContain('already up to date');
  });

  it('install --target agents uses ~/.agents; an unknown target is a usage error', async () => {
    cli = cliHarness();
    expect(
      (
        await cli.run([
          'skill',
          'install',
          '--target',
          'agents',
          '--server',
          'https://t.example.com',
        ])
      ).code,
    ).toBe(0);
    expect(readdirSync(join(cli.home, '.agents', 'skills', 'rooster'))).toEqual(['SKILL.md']);
    expect(
      (await cli.run(['skill', 'install', '--target', 'vim', '--server', 'https://t.example.com']))
        .code,
    ).toBe(2);
  });
});

describe('installSkill (safe writes)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rooster-skill-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('--project: a symlink anywhere below the directory is refused', () => {
    const repo = join(dir, 'repo');
    const outside = join(dir, 'outside');
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(repo, '.claude'));
    const options = {
      target: 'claude' as const,
      project: true,
      homedir: join(dir, 'home'),
      cwd: repo,
    };
    expect(() => installSkill(options, 'skill', 0)).toThrow(UnsafePathError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('--project: a planted SKILL.md link to another file is refused', () => {
    const repo = join(dir, 'repo2');
    const victim = join(dir, 'bashrc');
    writeFileSync(victim, 'export PATH');
    const options = {
      target: 'agents' as const,
      project: true,
      homedir: join(dir, 'home'),
      cwd: repo,
    };
    const { file } = skillPath(options);
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(victim, file);
    expect(() => installSkill(options, 'skill', 0)).toThrow(UnsafePathError);
    expect(readFileSync(victim, 'utf8')).toBe('export PATH');
  });

  it('home: a linked ~/.claude (dotfiles) is fine, a linked skill folder is not', () => {
    const home = join(dir, 'home3');
    const dotfiles = join(dir, 'dotfiles');
    mkdirSync(join(dotfiles, 'skills'), { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(dotfiles, join(home, '.claude'));
    const options = { target: 'claude' as const, project: false, homedir: home, cwd: dir };
    expect(installSkill(options, 'v1', 0).status).toBe('added');
    expect(readFileSync(join(dotfiles, 'skills', 'rooster', 'SKILL.md'), 'utf8')).toBe('v1');

    const updated = installSkill(options, 'v2', Date.UTC(2026, 9, 9));
    expect(updated.status).toBe('updated');
    expect(readFileSync(updated.backup ?? '', 'utf8')).toBe('v1');

    const home4 = join(dir, 'home4');
    mkdirSync(join(home4, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(dir, 'outside'), join(home4, '.claude', 'skills', 'rooster'));
    expect(() => installSkill({ ...options, homedir: home4 }, 'x', 0)).toThrow(UnsafePathError);
  });
});

describe('rooster admin reindex', () => {
  it('reports the rebuilt index with the admin capability', async () => {
    const api = fakeApi({
      'GET /api/v1/me': ME,
      'POST /api/v1/admin/search/reindex': { indexed: 12, durationMs: 34, finishedAt: 0 },
    });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      const run = await cli.run(['admin', 'reindex'], { env: FAKE_ENV });
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('12 tasks in 34 ms');
      expect(api.calls.find((c) => c.method === 'POST')?.path).toBe('/api/v1/admin/search/reindex');
    } finally {
      cli.cleanup();
    }
  });

  it('without it, explains rooster login --admin (exit 3)', async () => {
    const api = fakeApi({
      'POST /api/v1/admin/search/reindex': () =>
        problem(403, 'forbidden_scope', 'This token or app lacks the "admin" permission.'),
    });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      const run = await cli.run(['admin', 'reindex'], { env: FAKE_ENV });
      expect(run.code).toBe(3);
      expect(run.stderr).toContain('rooster login --admin');
    } finally {
      cli.cleanup();
    }
  });

  describe('against the server', () => {
    let server: RoosterServer;
    beforeAll(async () => {
      server = await startServer();
    });
    afterAll(async () => {
      await server?.close();
    });

    it('a token without the admin capability is refused with the hint', async () => {
      const user = await server.user('notadmin@example.com');
      const { token } = await user.token({ scopes: ['tasks:read'] });
      const cli = cliHarness();
      try {
        const run = await cli.run(['admin', 'reindex'], {
          env: { ROOSTER_SERVER: server.url, ROOSTER_TOKEN: token },
        });
        expect(run.code).toBe(3);
        expect(run.stderr).toContain('rooster login --admin');
      } finally {
        cli.cleanup();
      }
    });
  });
});

describe('rooster login --admin', () => {
  it('asks the device flow for the admin capability too', async () => {
    const api = fakeApi({
      'GET /api/v1/meta': { version: CLI_VERSION },
      'POST /api/auth/device/code': () =>
        new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 }),
    });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      const run = await cli.run([
        'login',
        '--admin',
        '--no-browser',
        '--server',
        'https://rooster.test',
      ]);
      expect(run.code).toBe(3);
      const body = api.calls.find((c) => c.path === '/api/auth/device/code')?.body as {
        scope: string;
      };
      expect(body.scope.split(' ')).toContain('admin');
      expect(body.scope.split(' ')).toContain('tasks:write');
    } finally {
      cli.cleanup();
    }
  });
});

describe('help and completion mention the admin capability', () => {
  it('login --help lists --admin; token create --help mentions admin', async () => {
    const cli = cliHarness();
    try {
      expect((await cli.run(['login', '--help'])).stdout).toContain('--admin');
      expect((await cli.run(['token', 'create', '--help'])).stdout).toContain('admin');
      const bash = await cli.run(['completion', 'bash']);
      expect(bash.stdout).toContain('notifications:read admin');
      expect(bash.stdout).toContain('claude-code claude-desktop cursor print');
    } finally {
      cli.cleanup();
    }
  });

  it('mcp, skill and admin have help', async () => {
    const cli = cliHarness();
    try {
      expect((await cli.run(['mcp', '--help'])).stdout).toContain('--read-only');
      expect((await cli.run(['mcp', 'setup', '--help'])).stdout).toContain('--allow-delete');
      expect((await cli.run(['skill', 'install', '--help'])).stdout).toContain('--project');
      expect((await cli.run(['admin', '--help'])).stdout).toContain('reindex');
    } finally {
      cli.cleanup();
    }
  });
});
