import { afterEach, describe, expect, it } from 'vitest';
import { type CliHarness, cliHarness } from './support/fake-io.ts';

let cli: CliHarness;
afterEach(() => cli?.cleanup());

describe('rooster without a server', () => {
  it('prints help with global options, without colour when piped', async () => {
    cli = cliHarness();
    const help = await cli.run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('GLOBAL OPTIONS');
    expect(help.stdout).not.toContain('\u001b[');
    const sub = await cli.run(['group', 'rm', '--help']);
    expect(sub.stdout).toContain('--delete-tasks');
    const tag = await cli.run(['help', 'tag']);
    expect(tag.stdout).toContain('+name -name');
  });

  it('prints the version', async () => {
    cli = cliHarness();
    const version = await cli.run(['--version']);
    expect(version.stdout).toMatch(/^rooster \d+\.\d+\.\d+\n$/);
    expect(JSON.parse((await cli.run(['--version', '--json'])).stdout)).toMatchObject({
      server: null,
    });
  });

  it('exits 3 when not logged in, 2 for usage errors', async () => {
    cli = cliHarness();
    const ls = await cli.run(['ls']);
    expect(ls.code).toBe(3);
    expect(ls.stderr).toContain('rooster login');
    expect((await cli.run([])).code).toBe(3);
    expect((await cli.run(['frobnicate'])).code).toBe(2);
    expect(
      (
        await cli.run(['show', 'not-a-ref'], {
          env: { ROOSTER_SERVER: 'http://127.0.0.1:9', ROOSTER_TOKEN: 'x' },
        })
      ).code,
    ).toBe(2);
    expect((await cli.run(['ls', 'someday'])).code).toBe(2);
    expect((await cli.run(['completion', 'tcsh'])).code).toBe(2);
    expect((await cli.run(['ls', '--org'])).code).toBe(2);
  });

  it('reports errors as JSON on stderr with --json', async () => {
    cli = cliHarness();
    const ls = await cli.run(['ls', '--json']);
    expect(JSON.parse(ls.stderr)).toEqual({
      error: { code: null, exitCode: 3, message: expect.stringContaining('rooster login') },
    });
  });

  it('speaks Swedish from $LANG until the profile or server says otherwise', async () => {
    cli = cliHarness();
    const ls = await cli.run(['ls'], { env: { LANG: 'sv_SE.UTF-8' } });
    expect(ls.stderr).toContain('Du är inte inloggad');
    await cli.run(['config', 'set', 'locale', 'en']);
    expect((await cli.run(['ls'], { env: { LANG: 'sv_SE.UTF-8' } })).stderr).toContain(
      'not signed in',
    );
  });

  it('config get, set and path', async () => {
    cli = cliHarness();
    expect((await cli.run(['config', 'set', 'server', 'rooster.example.com'])).code).toBe(0);
    expect((await cli.run(['config', 'get', 'server'])).stdout).toBe(
      'https://rooster.example.com\n',
    );
    expect((await cli.run(['config', 'set', 'org', 'acme', '--profile', 'work'])).code).toBe(0);
    expect((await cli.run(['config', 'get', 'org', '--profile', 'work'])).stdout).toBe('acme\n');
    expect((await cli.run(['config', 'get', 'org'])).code).toBe(4);
    expect((await cli.run(['config', 'set', 'default_profile', 'work'])).code).toBe(0);
    expect((await cli.run(['config', 'get', 'org'])).stdout).toBe('acme\n');
    expect((await cli.run(['config', 'set', 'locale', 'de'])).code).toBe(2);
    expect((await cli.run(['config', 'set', 'colour', 'x'])).code).toBe(2);
    expect((await cli.run(['config', 'path'])).stdout).toBe(
      `${cli.home}/config/rooster/config.toml\n`,
    );
  });

  it('prints completion scripts', async () => {
    cli = cliHarness();
    const bash = await cli.run(['completion', 'bash']);
    expect(bash.code).toBe(0);
    expect(bash.stdout).toContain('complete -o default -F _rooster rooster');
    // Not logged in: dynamic completion stays silent instead of failing in the prompt.
    const names = await cli.run(['__complete', 'groups']);
    expect(names).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('refuses to log in without a server or token', async () => {
    cli = cliHarness();
    expect((await cli.run(['login', '--with-token'])).code).toBe(2);
    expect((await cli.run(['login', '--with-token', '--server', 'http://127.0.0.1:9'])).code).toBe(
      2,
    );
    const down = await cli.run(['login', '--with-token', '--server', 'http://127.0.0.1:9'], {
      stdin: 'tok',
    });
    expect(down.code).toBe(6);
    expect(down.stderr).toContain('127.0.0.1:9');
  });
});

describe('[P2] safeDiagnostic', () => {
  it('redacts OAuth tokens and token-shaped form values it was never told about (11 §9.6)', async () => {
    const { safeDiagnostic } = await import('../src/diagnostics.ts');
    const runtime = { io: { env: {} }, usedTokens: new Set<string>() } as unknown as Parameters<
      typeof safeDiagnostic
    >[1];
    const text = safeDiagnostic(
      'rooster_at_Abc-12_x rooster_rt_Zz9 grant_type=refresh_token&refresh_token=secret1&device_code=secret2',
      runtime,
    );
    for (const secret of ['Abc-12_x', 'Zz9', 'secret1', 'secret2']) {
      expect(text).not.toContain(secret);
    }
  });

  it('redacts used credentials (line by line), PAT and Bearer shapes, and control characters', async () => {
    const { safeDiagnostic } = await import('../src/diagnostics.ts');
    const used = 'sessiontoken123\ninjected-line';
    const runtime = {
      io: { env: { ROOSTER_TOKEN: 'envtoken-abcdef' } },
      usedTokens: new Set([used]),
    } as unknown as Parameters<typeof safeDiagnostic>[1];
    const text = safeDiagnostic(
      `TypeError: Headers.set: "Bearer ${used}" is an invalid header value.\n` +
        'envtoken-abcdef rooster_pat_ABCdef123 \u001b]52;c;QUJD\u0007 sessiontoken123',
      runtime,
    );
    for (const secret of ['sessiontoken123', 'injected-line', 'envtoken-abcdef', 'ABCdef123']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });
});
