import { describe, expect, it, vi } from 'vitest';
import {
  browserCommand,
  launchBrowser,
  openableUrl,
  runEditor,
  type SpawnFn,
  splitCommand,
} from '../src/launch.ts';

const SERVER = 'https://rooster.example.com';

describe('openableUrl', () => {
  it('allows https pages of the profile server, normalised', () => {
    expect(openableUrl('https://rooster.example.com/device?user_code=ABCD-EFGH', SERVER)).toBe(
      'https://rooster.example.com/device?user_code=ABCD-EFGH',
    );
    expect(openableUrl('https://rooster.example.com/o/a b/my', SERVER)).toBe(
      'https://rooster.example.com/o/a%20b/my',
    );
  });

  it('keeps shell metacharacters as data (encoded or inert in argv)', () => {
    for (const raw of [
      'https://rooster.example.com/device?a=1&b=2',
      'https://rooster.example.com/x|calc',
      'https://rooster.example.com/%PATH%',
      'https://rooster.example.com/"quoted"',
      'https://rooster.example.com/^caret',
    ]) {
      const href = openableUrl(raw, SERVER);
      expect(href, raw).not.toBeNull();
      expect(href?.startsWith('https://rooster.example.com/')).toBe(true);
    }
  });

  it('refuses other origins, schemes, credentials and junk', () => {
    for (const raw of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://rooster.example.com/device',
      'https://evil.example.com/device',
      'https://rooster.example.com.evil.example/',
      'https://user:pw@rooster.example.com/device',
      'not a url',
      'https://rooster.example.com:8443/device',
    ]) {
      expect(openableUrl(raw, SERVER), raw).toBeNull();
    }
  });

  it('allows http only for loopback servers (development)', () => {
    expect(openableUrl('http://localhost:3000/device', 'http://localhost:3000')).toBe(
      'http://localhost:3000/device',
    );
    expect(openableUrl('http://10.0.0.5/device', 'http://10.0.0.5')).toBeNull();
  });

  it('a newline in the URL never reaches the launcher as a second command', () => {
    const href = openableUrl('https://rooster.example.com/a\nb', SERVER);
    expect(href).not.toContain('\n');
  });
});

describe('browserCommand', () => {
  const href = 'https://rooster.example.com/device?a=1&b=2|x';
  it.each([
    ['linux', 'xdg-open', [href]],
    ['darwin', 'open', [href]],
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', href]],
  ] as const)('%s', (platform, command, args) => {
    expect(browserCommand(platform, href)).toEqual([command, args]);
  });
});

function fakeSpawn(event: 'spawn' | 'error' | 'exit', code = 0) {
  const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
  const unref = vi.fn();
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      on(name: string, listener: (value: unknown) => void) {
        if (name === event)
          queueMicrotask(() => listener(event === 'error' ? new Error('x') : code));
        return this;
      },
      unref,
    } as unknown as ReturnType<SpawnFn>;
  };
  return { spawn, calls, unref };
}

describe('launchBrowser', () => {
  it('spawns the launcher without a shell, detached', async () => {
    const { spawn, calls, unref } = fakeSpawn('spawn');
    expect(await launchBrowser(spawn, 'win32', 'https://r.example/a&b')).toBe(true);
    expect(calls).toEqual([
      {
        command: 'rundll32',
        args: ['url.dll,FileProtocolHandler', 'https://r.example/a&b'],
        options: { stdio: 'ignore', detached: true, shell: false },
      },
    ]);
    expect(unref).toHaveBeenCalled();
  });

  it('reports a missing launcher', async () => {
    const { spawn } = fakeSpawn('error');
    expect(await launchBrowser(spawn, 'linux', 'https://r.example/')).toBe(false);
  });
});

describe('splitCommand ($EDITOR)', () => {
  it.each([
    ['vi', ['vi']],
    ['code --wait', ['code', '--wait']],
    ['"/Applications/My Editor.app/bin/edit" -w', ['/Applications/My Editor.app/bin/edit', '-w']],
    ["nano '-x y'", ['nano', '-x y']],
    ['my\\ editor -f', ['my editor', '-f']],
    ['C:\\Windows\\notepad.exe', ['C:\\Windows\\notepad.exe']],
    ['vim; rm -rf ~', ['vim;', 'rm', '-rf', '~']],
    ['  ', []],
  ])('%s', (input, argv) => {
    expect(splitCommand(input)).toEqual(argv);
  });

  it('runs the editor with the file as its own argv element, no shell', async () => {
    const { spawn, calls } = fakeSpawn('exit', 0);
    expect(await runEditor(spawn, ['code', '--wait'], '/tmp/a b;c.md')).toBe(0);
    expect(calls[0]).toEqual({
      command: 'code',
      args: ['--wait', '/tmp/a b;c.md'],
      options: { stdio: 'inherit', shell: false },
    });
  });
});
