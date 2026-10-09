import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialRemovalError,
  CredentialStoreUnavailable,
  CredentialsChanging,
  FileSecretStore,
  isStoreUnreachable,
  LayeredSecretStore,
} from '../src/secrets.ts';
import { FAKE_ENV, fakeApi, ME } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rooster-secrets-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A keychain that can be locked and unlocked, like a desktop session's. */
function fakeKeychain() {
  const entries = new Map<string, string>();
  const state = { locked: false };
  const guard = () => {
    if (state.locked) throw new Error('locked');
  };
  const factory = async () => (service: string, account: string) => ({
    getPassword: async () => {
      guard();
      return entries.get(`${service}/${account}`);
    },
    setPassword: async (p: string) => {
      guard();
      entries.set(`${service}/${account}`, p);
    },
    deletePassword: async () => {
      guard();
      return entries.delete(`${service}/${account}`);
    },
  });
  return { entries, state, factory };
}

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, tick: (ms = 1_000) => (now += ms) };
}

describe('credential storage (07 §2)', () => {
  it('the file fallback is mode 0600, per profile, bound to the server origin', async () => {
    const notice = vi.fn();
    const store = new LayeredSecretStore(new FileSecretStore(dir), async () => null, notice);
    expect(await store.set('home', 'tok-1', 'https://a.example/sub')).toBe('file');
    expect(await store.set('work', 'tok-2', 'https://b.example')).toBe('file');
    const path = join(dir, 'credentials');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await store.get('home')).toMatchObject({ token: 'tok-1', server: 'https://a.example' });
    await store.delete('home');
    expect(await store.get('home')).toBeUndefined();
    expect(await store.get('work')).toMatchObject({ token: 'tok-2' });
    expect(notice).toHaveBeenCalledTimes(2);
    expect(readFileSync(path, 'utf8')).not.toContain('tok-1');
  });

  it('uses the keychain when it works and keeps no copy in the file', async () => {
    const keychain = fakeKeychain();
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, keychain.factory, vi.fn());
    expect(await store.set('home', 'tok', 'https://a.example')).toBe('keychain');
    expect(JSON.parse(keychain.entries.get('rooster/home') ?? '{}')).toMatchObject({
      token: 'tok',
      server: 'https://a.example',
    });
    expect(file.entry('home')).toBeUndefined();
    expect(await store.get('home')).toMatchObject({ token: 'tok' });
  });

  it('a raw (unbound) keychain token is never used', async () => {
    const keychain = fakeKeychain();
    keychain.entries.set('rooster/home', 'rooster_pat_old');
    const store = new LayeredSecretStore(new FileSecretStore(dir), keychain.factory, vi.fn());
    expect(await store.get('home')).toBeUndefined();
  });

  it('[P2] a login written to the file while the keychain was locked beats the older keychain entry', async () => {
    const keychain = fakeKeychain();
    const time = clock();
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, keychain.factory, vi.fn(), time.now);
    await store.set('home', 'old', 'https://a.example');
    time.tick();
    // A later login from a session without a usable keychain (SSH, no Secret Service).
    const elsewhere = new LayeredSecretStore(file, async () => null, vi.fn(), time.now);
    expect(await elsewhere.set('home', 'new', 'https://a.example')).toBe('file');
    expect(await store.get('home')).toMatchObject({ token: 'new' });
    // Reads never delete: the stale keychain entry stays until the next login or logout.
    expect(keychain.entries.has('rooster/home')).toBe(true);
    expect(await store.get('home')).toMatchObject({ token: 'new' });
    await store.set('home', 'newest', 'https://a.example');
    expect(await store.get('home')).toMatchObject({ token: 'newest' });
    expect(file.entry('home')).toBeUndefined();
  });

  it('[P2] a read never erases a login that happens while it runs (interleaving)', async () => {
    const keychain = fakeKeychain();
    const time = clock();
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, keychain.factory, vi.fn(), time.now);
    // A stale keychain login (T1) and a newer fallback login in the file (T2).
    await store.set('home', 't1', 'https://a.example');
    time.tick();
    await new LayeredSecretStore(file, async () => null, vi.fn(), time.now).set(
      'home',
      't2',
      'https://a.example',
    );
    time.tick();
    // Every keychain delete waits until released, so the reader can be caught mid-cleanup.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = await keychain.factory();
    const gated = new LayeredSecretStore(
      file,
      async () => (service: string, account: string) => {
        const entry = factory(service, account);
        return {
          ...entry,
          deletePassword: async () => {
            await gate;
            return entry.deletePassword();
          },
        };
      },
      vi.fn(),
      time.now,
    );
    const reader = gated.get('home');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    // Another process logs in meanwhile: keychain T3, file entry removed.
    const writer = new LayeredSecretStore(file, keychain.factory, vi.fn(), time.now);
    expect(await writer.set('home', 't3', 'https://a.example')).toBe('keychain');
    release();
    expect(await reader).toMatchObject({ token: 't2' });
    expect(await store.get('home')).toMatchObject({ token: 't3' });
  });

  it('[P2] a logout while the keychain is locked is not undone when it unlocks', async () => {
    const keychain = fakeKeychain();
    const time = clock();
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, keychain.factory, vi.fn(), time.now);
    await store.set('home', 'tok', 'https://a.example');
    time.tick();
    keychain.state.locked = true;
    await store.delete('home');
    // Locked, the keychain's state is unknown: reads fail closed rather than guess.
    await expect(store.get('home')).rejects.toBeInstanceOf(CredentialStoreUnavailable);
    keychain.state.locked = false;
    expect(await store.get('home')).toBeUndefined();
    expect(await store.get('home')).toBeUndefined();
    // The next logout, with the keychain unlocked, clears both.
    await store.delete('home');
    expect(keychain.entries.has('rooster/home')).toBe(false);
    expect(file.entry('home')).toBeUndefined();
  });

  it('[P2] a newer keychain login beats an older file entry, even with a clock that went back', async () => {
    const keychain = fakeKeychain();
    const time = clock(50_000);
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, keychain.factory, vi.fn(), time.now);
    await new LayeredSecretStore(file, async () => null, vi.fn(), time.now).set(
      'home',
      'from-file',
      'https://a.example',
    );
    time.tick(-20_000);
    expect(await store.set('home', 'from-keychain', 'https://a.example')).toBe('keychain');
    expect(await store.get('home')).toMatchObject({ token: 'from-keychain' });
  });

  it('ignores a corrupt credentials file instead of crashing', async () => {
    writeFileSync(join(dir, 'credentials'), '[[[', { mode: 0o600 });
    const store = new LayeredSecretStore(new FileSecretStore(dir), async () => null, vi.fn());
    expect(await store.get('home')).toBeUndefined();
  });
});

describe('[P1] a stored login is only sent to its own server', () => {
  it('refuses ROOSTER_SERVER or a changed server setting with exit 3, sending nothing', async () => {
    const requests: string[] = [];
    const cli = cliHarness(
      {},
      {
        fetch: (async (input: Request) => {
          requests.push(new URL(input.url).origin);
          return new Response('{}', { status: 500 });
        }) as typeof fetch,
      },
    );
    try {
      const store = new LayeredSecretStore(
        new FileSecretStore(join(cli.home, 'config', 'rooster')),
        async () => null,
        () => {},
      );
      await store.set('default', 'secret-token-of-a', 'https://a.example');
      expect((await cli.run(['config', 'set', 'server', 'https://a.example'])).code).toBe(0);

      const viaEnv = await cli.run(['whoami'], {
        env: { ROOSTER_SERVER: 'https://attacker.example' },
      });
      expect(viaEnv.code).toBe(3);
      expect(viaEnv.stderr).toContain('https://a.example');
      expect(viaEnv.stderr).toContain('rooster login --server https://attacker.example');

      expect((await cli.run(['config', 'set', 'server', 'https://attacker.example'])).code).toBe(0);
      expect((await cli.run(['ls'])).code).toBe(3);
      expect((await cli.run(['--version'])).code).toBe(0);
      expect(requests).toEqual([]);

      // An explicit ROOSTER_TOKEN is the user's choice of credential and server.
      await cli.run(['ls'], { env: { ROOSTER_TOKEN: 'explicit' } });
      expect(requests).toEqual(['https://attacker.example']);
    } finally {
      cli.cleanup();
    }
  });
});

describe('[P2] a read racing a login returns a settled credential', () => {
  it('re-reads both stores until they agree (gated keychain read)', async () => {
    const keychain = fakeKeychain();
    const time = clock();
    const file = new FileSecretStore(dir);
    const setup = new LayeredSecretStore(file, keychain.factory, vi.fn(), time.now);
    await setup.set('home', 'A', 'https://a.example');
    time.tick();
    await new LayeredSecretStore(file, async () => null, vi.fn(), time.now).set(
      'home',
      'B',
      'https://a.example',
    );
    time.tick();

    // The reader's first keychain read sees A, then waits until released.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    const factory = await keychain.factory();
    const reader = new LayeredSecretStore(
      file,
      async () => (service: string, account: string) => {
        const entry = factory(service, account);
        return {
          ...entry,
          getPassword: async () => {
            const value = await entry.getPassword();
            if (gated) {
              gated = false;
              await gate;
            }
            return value;
          },
        };
      },
      vi.fn(),
      time.now,
    );
    const read = reader.get('home');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    // Another process logs in (C to the keychain) and removes the file's B.
    expect(await setup.set('home', 'C', 'https://a.example')).toBe('keychain');
    expect(file.entry('home')).toBeUndefined();
    release();
    // Without the re-read the reader would pair keychain A with the now empty file.
    expect(await read).toMatchObject({ token: 'C' });
  });
});

describe('[P2] logout never reports success while the login stays usable', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('the store throws when the file entry cannot be removed', async () => {
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, async () => null, vi.fn());
    await store.set('home', 'tok', 'https://a.example');
    chmodSync(dir, 0o500);
    try {
      await expect(store.delete('home')).rejects.toBeInstanceOf(CredentialRemovalError);
      expect(await store.get('home')).toMatchObject({ token: 'tok' });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('a durable tombstone is a logout even when the keychain is locked', async () => {
    const keychain = fakeKeychain();
    const store = new LayeredSecretStore(new FileSecretStore(dir), keychain.factory, vi.fn());
    await store.set('home', 'tok', 'https://a.example');
    keychain.state.locked = true;
    await store.delete('home');
    keychain.state.locked = false;
    expect(await store.get('home')).toBeUndefined();
  });

  it.skipIf(asRoot)(
    'rooster logout exits non-zero with the path and never says signed out',
    async () => {
      const api = fakeApi({ 'GET /api/v1/me': ME, 'GET /api/v1/me/grants': [] });
      const cli = cliHarness({}, { fetch: api.fetch });
      const configDir = join(cli.home, 'config', 'rooster');
      try {
        expect((await cli.run(['config', 'set', 'server', FAKE_ENV.ROOSTER_SERVER])).code).toBe(0);
        const store = new LayeredSecretStore(
          new FileSecretStore(configDir),
          async () => null,
          () => {},
        );
        await store.set('default', 'tok', FAKE_ENV.ROOSTER_SERVER);
        chmodSync(configDir, 0o500);
        const out = await cli.run(['logout']);
        expect(out.code).toBe(1);
        expect(out.stderr).toContain(
          `Couldn’t remove the stored credential at ${join(configDir, 'credentials')}`,
        );
        expect(out.stderr).not.toContain('Signed out');
        // Still signed in, and it says so honestly.
        expect((await cli.run(['whoami', '--quiet'])).stdout).toBe('ada@example.com\n');
      } finally {
        chmodSync(configDir, 0o700);
        cli.cleanup();
      }
    },
  );
});

describe('[P1] an unreadable keychain is unknown, never empty', () => {
  it('a keychain that locks after the first read fails closed', async () => {
    const keychain = fakeKeychain();
    const store = new LayeredSecretStore(new FileSecretStore(dir), keychain.factory, vi.fn());
    await store.set('home', 'tok', 'https://a.example');
    let reads = 0;
    const factory = await keychain.factory();
    const locking = new LayeredSecretStore(
      new FileSecretStore(dir),
      async () => (service: string, account: string) => {
        const entry = factory(service, account);
        return {
          ...entry,
          getPassword: async () => {
            reads += 1;
            if (reads > 1) throw new Error('locked');
            return entry.getPassword();
          },
        };
      },
      vi.fn(),
    );
    await expect(locking.get('home')).rejects.toBeInstanceOf(CredentialStoreUnavailable);
  });

  it('an older file credential is not used while the keychain is unreadable', async () => {
    const keychain = fakeKeychain();
    const time = clock();
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, keychain.factory, vi.fn(), time.now);
    file.put('home', { token: 'old-file', server: 'https://a.example', at: 1 });
    time.tick();
    await store.set('home', 'newer', 'https://a.example');
    // Removing the older file entry failed (say): both exist, the keychain is newer.
    file.put('home', { token: 'old-file', server: 'https://a.example', at: 1 });
    keychain.state.locked = true;
    await expect(store.get('home')).rejects.toBeInstanceOf(CredentialStoreUnavailable);
    keychain.state.locked = false;
    expect(await store.get('home')).toMatchObject({ token: 'newer' });
  });

  it('no keychain at all (no module, ROOSTER_KEYRING=off) is known empty', async () => {
    const file = new FileSecretStore(dir);
    const store = new LayeredSecretStore(file, async () => null, vi.fn());
    await store.set('home', 'tok', 'https://a.example');
    expect(await store.get('home')).toMatchObject({ token: 'tok' });
  });

  it('rooster logout and whoami exit 3 naming the keychain, and never say "not signed in"', async () => {
    const keychain = fakeKeychain();
    const api = fakeApi({ 'GET /api/v1/me': ME, 'GET /api/v1/me/grants': [] });
    const cli = cliHarness({ loadKeyring: keychain.factory }, { fetch: api.fetch });
    const env = { ROOSTER_KEYRING: '' };
    try {
      expect((await cli.run(['config', 'set', 'server', FAKE_ENV.ROOSTER_SERVER])).code).toBe(0);
      const store = new LayeredSecretStore(
        new FileSecretStore(join(cli.home, 'config', 'rooster')),
        keychain.factory,
        () => {},
      );
      expect(await store.set('default', 'tok', FAKE_ENV.ROOSTER_SERVER)).toBe('keychain');
      expect((await cli.run(['whoami', '--quiet'], { env })).stdout).toBe('ada@example.com\n');

      keychain.state.locked = true;
      const logout = await cli.run(['logout'], { env });
      expect(logout.code).toBe(3);
      expect(logout.stderr).toContain('keychain');
      expect(logout.stderr).not.toContain('isn’t signed in');
      expect(logout.stderr).not.toContain('Signed out');
      expect((await cli.run(['whoami'], { env })).code).toBe(3);

      keychain.state.locked = false;
      expect((await cli.run(['whoami', '--quiet'], { env })).stdout).toBe('ada@example.com\n');
    } finally {
      cli.cleanup();
    }
  });
});

describe('[P2] reads that never settle fail closed', () => {
  it('throws CredentialsChanging when every snapshot differs (another process keeps writing)', async () => {
    const keychain = fakeKeychain();
    const file = new FileSecretStore(dir);
    let at = 1;
    const factory = await keychain.factory();
    const churning = new LayeredSecretStore(
      file,
      async () => (service: string, account: string) => ({
        ...factory(service, account),
        // Each read sees a newer login written in between.
        getPassword: async () => {
          at += 1;
          return JSON.stringify({ token: `t${at}`, server: 'https://a.example', at });
        },
      }),
      vi.fn(),
    );
    await expect(churning.get('home')).rejects.toBeInstanceOf(CredentialsChanging);
  });

  it('exits 5 with a retry hint from the CLI', async () => {
    const keychain = fakeKeychain();
    let at = 1;
    const factory = await keychain.factory();
    const cli = cliHarness({
      loadKeyring: async () => (service: string, account: string) => ({
        ...factory(service, account),
        getPassword: async () => {
          at += 1;
          return JSON.stringify({ token: 't', server: 'https://rooster.test', at });
        },
      }),
    });
    try {
      const out = await cli.run(['whoami'], {
        env: { ROOSTER_KEYRING: '', ROOSTER_SERVER: 'https://rooster.test' },
      });
      expect(out.code).toBe(5);
      expect(out.stderr).toContain('another rooster process');
    } finally {
      cli.cleanup();
    }
  });
});

describe('[P2] no usable platform store versus a refusing keychain', () => {
  const META = { version: '1.1.0', gitSha: 'x', providers: [], features: {}, serverTime: 0 };
  const NO_SERVICE =
    'Platform secure storage failure: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files';

  /** A keyring whose backend fails the way `@napi-rs/keyring` does on a headless host. */
  const broken =
    (where: 'construct' | 'calls', message: string) =>
    async () =>
    (_service: string, _account: string) => {
      if (where === 'construct') throw new Error(message);
      const fail = async (): Promise<never> => {
        throw new Error(message);
      };
      return { getPassword: fail, setPassword: fail, deletePassword: fail };
    };

  async function loginThenWhoami(loadKeyring: ReturnType<typeof broken>) {
    const api = fakeApi({
      'GET /api/v1/meta': META,
      'GET /api/v1/me': ME,
      'GET /api/v1/me/grants': [],
    });
    const cli = cliHarness({ loadKeyring }, { fetch: api.fetch });
    const env = { ROOSTER_KEYRING: '' };
    try {
      const login = await cli.run(['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER], {
        stdin: 'tok',
        env,
      });
      const whoami = await cli.run(['whoami', '--quiet'], { env });
      const logout = await cli.run(['logout'], { env });
      const after = await cli.run(['whoami'], { env });
      return { login, whoami, logout, after };
    } finally {
      cli.cleanup();
    }
  }

  it.each([
    ['the backend fails at every call (no Secret Service)', broken('calls', NO_SERVICE)],
    [
      'creating the entry fails (Linux keyutils without a session keyring)',
      broken('construct', "Couldn't access platform storage: KeyRevoked"),
    ],
  ])('%s: login falls back to the file, and whoami and logout work', async (_name, loadKeyring) => {
    const { login, whoami, logout, after } = await loginThenWhoami(loadKeyring);
    expect(login.code).toBe(0);
    expect(login.stderr).toContain('No system keychain available');
    expect(whoami).toMatchObject({ code: 0, stdout: 'ada@example.com\n' });
    expect(logout.code).toBe(0);
    expect(logout.stderr).toContain('Signed out');
    expect(after.code).toBe(3);
  });

  it('a keychain that refuses the write fails the login instead of storing an unusable one', async () => {
    const { login, whoami } = await loginThenWhoami(
      broken('calls', "Couldn't access platform secure storage: the keychain is locked"),
    );
    expect(login.code).toBe(3);
    expect(login.stderr).toContain('ROOSTER_KEYRING=off');
    expect(login.stderr).not.toContain('Signed in');
    expect(whoami.code).toBe(3);
  });

  it('classifies errors: unreachable backends versus refusals', () => {
    for (const message of [
      NO_SERVICE,
      'org.freedesktop.DBus.Error.NoServer: Failed to connect to socket',
      'DBus error: org.freedesktop.DBus.Error.Spawn.ExecFailed',
      "Couldn't access platform storage: KeyRevoked",
      'Platform not supported',
    ]) {
      expect(isStoreUnreachable(new Error(message)), message).toBe(true);
    }
    for (const message of [
      "Couldn't access platform secure storage: the keychain is locked",
      'User interaction is not allowed.',
      'org.freedesktop.DBus.Error.AccessDenied: denied',
      'Access is denied.',
      'something else',
    ]) {
      expect(isStoreUnreachable(new Error(message)), message).toBe(false);
    }
  });
});
