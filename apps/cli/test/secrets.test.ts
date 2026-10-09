import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigLockedError, ConfigStore, writeFileAtomic } from '../src/config.ts';
import { NO_GLOBALS, Runtime, withRuntime } from '../src/runtime.ts';
import {
  CredentialRemovalError,
  CredentialStore,
  CredentialStoreUnavailable,
  fileNameOf,
  isStoreAbsent,
  KeychainRefused,
  type KeyringFactory,
} from '../src/secrets.ts';
import { FAKE_ENV, fakeApi, ME } from './support/fake-api.ts';
import { cliHarness, fakeIo } from './support/fake-io.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rooster-secrets-'));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const A = { token: 'tok-a', server: 'https://a.example' };

// The exact messages from the reviews and from `@napi-rs/keyring` on Linux.
const SERVICE_UNKNOWN =
  'Platform secure storage failure: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files';
const OBJECT_LOCKED = 'Secret Service: object locked';
const PROMPT_DISMISSED = 'Secret Service: unlock prompt was dismissed';
const ACCESS_DENIED =
  'org.freedesktop.DBus.Error.AccessDenied: Rejected send message to org.freedesktop.secrets';
const SOCKET_OUTAGE = 'Failed to connect to socket /run/user/1000/bus: Connection refused';
const KEY_REVOKED = "Couldn't access platform storage: KeyRevoked";

/**
 * A keychain that can work, or fail every call (or creating entries) with a given message.
 * `calls` counts every use, so tests can prove it was never consulted.
 */
function fakeKeychain() {
  const entries = new Map<string, string>();
  const state = {
    failCalls: null as string | null,
    failConstruct: null as string | null,
    failDelete: null as string | null,
    /** Per account: a message to fail reads with (e.g. only the staged account). */
    failGet: null as ((account: string) => string | null) | null,
    calls: 0,
  };
  const guard = () => {
    state.calls += 1;
    if (state.failCalls !== null) throw new Error(state.failCalls);
  };
  const factory: KeyringFactory = (service, account) => {
    state.calls += 1;
    if (state.failConstruct !== null) throw new Error(state.failConstruct);
    const key = `${service}/${account}`;
    return {
      getPassword: async () => {
        guard();
        const message = state.failGet?.(account) ?? null;
        if (message !== null) throw new Error(message);
        return entries.get(key);
      },
      setPassword: async (value: string) => {
        guard();
        entries.set(key, value);
      },
      deletePassword: async () => {
        guard();
        if (state.failDelete !== null) throw new Error(state.failDelete);
        return entries.delete(key);
      },
    };
  };
  return { entries, state, load: async () => factory };
}

describe('isStoreAbsent: the strict allowlist', () => {
  it('only proven absence counts; refusals, outages and unknown messages do not', () => {
    for (const message of [
      SERVICE_UNKNOWN,
      'org.freedesktop.DBus.Error.NameHasNoOwner: Could not get owner of name',
      'DBUS_SESSION_BUS_ADDRESS is not set',
      'DBus error: org.freedesktop.DBus.Error.Spawn.ExecFailed',
      'Platform not supported',
    ]) {
      expect(isStoreAbsent(new Error(message), 'call'), message).toBe(true);
    }
    expect(isStoreAbsent(new Error(KEY_REVOKED), 'construct')).toBe(true);
    expect(isStoreAbsent(new Error(KEY_REVOKED), 'call')).toBe(false);
    for (const message of [
      OBJECT_LOCKED,
      PROMPT_DISMISSED,
      ACCESS_DENIED,
      SOCKET_OUTAGE,
      'Access is denied.',
      'org.freedesktop.DBus.Error.NoReply: Did not receive a reply',
      'org.freedesktop.DBus.Error.Disconnected: Connection was disconnected',
      'Operation timed out',
      'Secret Service: something new',
      'something else',
    ]) {
      expect(isStoreAbsent(new Error(message), 'call'), message).toBe(false);
      expect(isStoreAbsent(new Error(message), 'construct'), message).toBe(false);
    }
  });
});

describe('login picks one store (CredentialStore.save)', () => {
  it('the keychain when a write and its read-back succeed; a stale file is removed', async () => {
    const keychain = fakeKeychain();
    const store = new CredentialStore(dir, keychain.load);
    mkdirSync(join(dir, 'credentials.d'), { recursive: true });
    writeFileSync(store.pathOf('home'), JSON.stringify({ token: 'old', server: A.server }));
    const saved = await store.save('home', A);
    if (saved.store !== 'keychain') throw new Error('expected the keychain');
    // Staged under a fresh account, never the active one.
    expect(saved.account).toMatch(/^home:[0-9a-f-]{36}$/);
    expect(JSON.parse(keychain.entries.get(`rooster/${saved.account}`) ?? '{}')).toEqual(A);
    expect(await store.load('home', 'keychain', saved.account)).toEqual(A);
    // Once published, the profile's old file login is dropped.
    expect(await store.dropPrevious('home', { store: 'file' }, saved)).toBe(true);
    expect(existsSync(store.pathOf('home'))).toBe(false);
  });

  it.each([
    ['no addon', async () => null],
    ['ServiceUnknown on every call', 'calls'],
    ['KeyRevoked when creating the entry', 'construct'],
  ] as const)('a provably absent keychain (%s): a 0600 file of its own', async (_name, how) => {
    const keychain = fakeKeychain();
    if (how === 'calls') keychain.state.failCalls = SERVICE_UNKNOWN;
    if (how === 'construct') keychain.state.failConstruct = KEY_REVOKED;
    const store = new CredentialStore(dir, typeof how === 'function' ? how : keychain.load);
    expect(await store.save('home', A)).toEqual({ store: 'file' });
    expect(statSync(store.pathOf('home')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'credentials.d')).mode & 0o777).toBe(0o700);
    expect(await store.load('home', 'file', undefined)).toEqual(A);
  });

  it.each([OBJECT_LOCKED, PROMPT_DISMISSED, ACCESS_DENIED, SOCKET_OUTAGE, 'Access is denied.'])(
    'a keychain failing with "%s" refuses the login (never a silent file login)',
    async (message) => {
      const keychain = fakeKeychain();
      keychain.state.failCalls = message;
      const store = new CredentialStore(dir, keychain.load);
      await expect(store.save('home', A)).rejects.toBeInstanceOf(KeychainRefused);
      expect(existsSync(store.pathOf('home'))).toBe(false);
    },
  );

  it('a constructor throwing "Access is denied." refuses too', async () => {
    const keychain = fakeKeychain();
    keychain.state.failConstruct = 'Access is denied.';
    const store = new CredentialStore(dir, keychain.load);
    await expect(store.save('home', A)).rejects.toBeInstanceOf(KeychainRefused);
  });

  it('a read-back that differs refuses', async () => {
    const store = new CredentialStore(dir, async () => () => ({
      getPassword: async () => JSON.stringify({ token: 'someone-else', server: A.server }),
      setPassword: async () => {},
      deletePassword: async () => true,
    }));
    await expect(store.save('home', A)).rejects.toBeInstanceOf(KeychainRefused);
  });
});

describe('reads use only the recorded store', () => {
  it.each([OBJECT_LOCKED, PROMPT_DISMISSED, ACCESS_DENIED, SOCKET_OUTAGE, SERVICE_UNKNOWN])(
    'a recorded keychain failing with "%s" fails closed, even with a file login present',
    async (message) => {
      const keychain = fakeKeychain();
      const store = new CredentialStore(dir, keychain.load);
      const saved = await store.save('home', A);
      const account = saved.store === 'keychain' ? saved.account : undefined;
      mkdirSync(join(dir, 'credentials.d'), { recursive: true });
      writeFileSync(
        store.pathOf('home'),
        JSON.stringify({ token: 'stale-file', server: A.server }),
      );
      keychain.state.failCalls = message;
      await expect(store.load('home', 'keychain', account)).rejects.toBeInstanceOf(
        CredentialStoreUnavailable,
      );
    },
  );

  it('a recorded keychain without the addon fails closed', async () => {
    const store = new CredentialStore(dir, async () => null);
    await expect(store.load('home', 'keychain', 'home:x')).rejects.toBeInstanceOf(
      CredentialStoreUnavailable,
    );
  });

  it('a recorded file never consults the keychain', async () => {
    const keychain = fakeKeychain();
    keychain.state.failCalls = SERVICE_UNKNOWN;
    const store = new CredentialStore(dir, keychain.load);
    expect(await store.save('home', A)).toEqual({ store: 'file' });
    keychain.state.failCalls = null;
    keychain.entries.set('rooster/home', JSON.stringify({ token: 'keychain', server: A.server }));
    const before = keychain.state.calls;
    expect(await store.load('home', 'file', undefined)).toEqual(A);
    expect(keychain.state.calls).toBe(before);
  });
});

describe('logout removes from the recorded store, confirmed or not at all', () => {
  it('a failed keychain delete (ServiceUnknown after reads worked) is an error', async () => {
    const keychain = fakeKeychain();
    const store = new CredentialStore(dir, keychain.load);
    const saved = await store.save('home', A);
    const account = saved.store === 'keychain' ? saved.account : undefined;
    keychain.state.failCalls = SERVICE_UNKNOWN;
    await expect(store.remove('home', 'keychain', account)).rejects.toMatchObject({
      where: 'keychain',
    });
    keychain.state.failCalls = null;
    expect(await store.load('home', 'keychain', account)).toEqual(A);
  });

  it.skipIf(asRoot)('a file that cannot be removed is an error naming the file', async () => {
    const store = new CredentialStore(dir, async () => null);
    await store.save('home', A);
    chmodSync(join(dir, 'credentials.d'), 0o500);
    try {
      const error = await store.remove('home', 'file', undefined).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CredentialRemovalError);
      expect((error as CredentialRemovalError).where).toBe(store.pathOf('home'));
    } finally {
      chmodSync(join(dir, 'credentials.d'), 0o700);
    }
  });

  it('a removed or never stored login is confirmed', async () => {
    const store = new CredentialStore(dir, async () => null);
    await store.save('home', A);
    await store.remove('home', 'file', undefined);
    await store.remove('home', 'file', undefined);
    expect(await store.load('home', 'file', undefined)).toBeUndefined();
  });
});

describe('one file per profile', () => {
  it('concurrent logins and logouts of different profiles leave each other intact', async () => {
    const store = new CredentialStore(dir, async () => null);
    const profiles = ['work', 'home', 'ci', 'a.b', '../x', 'with space'];
    await Promise.all(profiles.map((p) => store.save(p, { token: `t-${p}`, server: A.server })));
    await Promise.all([
      store.remove('ci', 'file', undefined),
      store.save('work', { token: 't-work-2', server: A.server }),
    ]);
    for (const p of profiles) {
      const expected =
        p === 'ci' ? undefined : { token: p === 'work' ? 't-work-2' : `t-${p}`, server: A.server };
      expect(await store.load(p, 'file', undefined), p).toEqual(expected);
    }
    // Names never escape the directory.
    expect(store.pathOf('../x').startsWith(join(dir, 'credentials.d'))).toBe(true);
    expect(existsSync(join(dir, 'x'))).toBe(false);
  });
});

describe('the CLI with one store per profile', () => {
  const META = { version: '1.1.0', gitSha: 'x', providers: [], features: {}, serverTime: 0 };

  function harness(load: () => Promise<KeyringFactory | null>) {
    const api = fakeApi({
      'GET /api/v1/meta': META,
      'GET /api/v1/me': ME,
      'GET /api/v1/me/grants': [],
    });
    const cli = cliHarness({ loadKeyring: load }, { fetch: api.fetch });
    const env = { ROOSTER_KEYRING: '' };
    const run = (argv: string[], extra: Record<string, string> = {}, stdin?: string) =>
      cli.run(argv, { env: { ...env, ...extra }, ...(stdin === undefined ? {} : { stdin }) });
    const login = (profile = 'default') =>
      run(
        ['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER, '--profile', profile],
        {},
        'tok',
      );
    const configText = () =>
      readFileSync(join(cli.home, 'config', 'rooster', 'config.toml'), 'utf8');
    return { cli, api, run, login, configText };
  }

  it('a headless host (no Secret Service) logs in to the file; whoami and logout work', async () => {
    const keychain = fakeKeychain();
    keychain.state.failCalls = SERVICE_UNKNOWN;
    const h = harness(keychain.load);
    try {
      const login = await h.login();
      expect(login.code).toBe(0);
      expect(login.stderr).toContain('No system keychain available');
      expect(h.configText()).toContain('credential_store = "file"');
      expect((await h.run(['whoami', '--quiet'])).stdout).toBe('ada@example.com\n');
      const logout = await h.run(['logout']);
      expect(logout.code).toBe(0);
      expect(logout.stderr).toContain('Signed out');
      expect(h.configText()).not.toContain('credential_store');
      expect((await h.run(['whoami'])).code).toBe(3);
    } finally {
      h.cli.cleanup();
    }
  });

  it('a keychain login that later locks fails closed and never uses a file login', async () => {
    const keychain = fakeKeychain();
    const h = harness(keychain.load);
    try {
      expect((await h.login()).code).toBe(0);
      expect(h.configText()).toContain('credential_store = "keychain"');
      // A stale file login for the same profile, as an old session might have left.
      const dirPath = join(h.cli.home, 'config', 'rooster', 'credentials.d');
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(
        join(dirPath, fileNameOf('default')),
        JSON.stringify({ token: 'stale', server: FAKE_ENV.ROOSTER_SERVER }),
      );
      for (const message of [OBJECT_LOCKED, SOCKET_OUTAGE]) {
        keychain.state.failCalls = message;
        const whoami = await h.run(['whoami']);
        expect(whoami.code, message).toBe(3);
        expect(whoami.stderr, message).toContain('keychain');
      }
      expect(h.api.calls.filter((c) => c.path === '/api/v1/me')).toHaveLength(1);
      keychain.state.failCalls = null;
      expect((await h.run(['whoami', '--quiet'])).stdout).toBe('ada@example.com\n');
    } finally {
      h.cli.cleanup();
    }
  });

  it('logout with a failed keychain delete exits 1, names the keychain and stays signed in', async () => {
    const keychain = fakeKeychain();
    const h = harness(keychain.load);
    try {
      expect((await h.login()).code).toBe(0);
      // Reads work; only the delete fails (the Secret Service went away in between).
      keychain.state.failDelete = SERVICE_UNKNOWN;
      const logout = await h.run(['logout']);
      expect(logout.code).toBe(1);
      expect(logout.stderr).toContain('system keychain');
      expect(logout.stderr).not.toContain('Signed out');
      expect(h.configText()).toContain('credential_store = "keychain"');
      expect((await h.run(['whoami', '--quiet'])).stdout).toBe('ada@example.com\n');
    } finally {
      h.cli.cleanup();
    }
  });

  it.skipIf(asRoot)(
    'logout with an unremovable credential file exits 1 naming the file',
    async () => {
      const h = harness(async () => null);
      try {
        expect((await h.login()).code).toBe(0);
        const dirPath = join(h.cli.home, 'config', 'rooster', 'credentials.d');
        chmodSync(dirPath, 0o500);
        try {
          const logout = await h.run(['logout']);
          expect(logout.code).toBe(1);
          expect(logout.stderr).toContain(join(dirPath, fileNameOf('default')));
          expect(logout.stderr).not.toContain('Signed out');
        } finally {
          chmodSync(dirPath, 0o700);
        }
        expect((await h.run(['whoami', '--quiet'])).stdout).toBe('ada@example.com\n');
      } finally {
        h.cli.cleanup();
      }
    },
  );

  it('a refusing keychain fails the login with the ROOSTER_KEYRING=off hint; off forces the file', async () => {
    const keychain = fakeKeychain();
    keychain.state.failCalls = OBJECT_LOCKED;
    const h = harness(keychain.load);
    try {
      const refused = await h.login();
      expect(refused.code).toBe(3);
      expect(refused.stderr).toContain('ROOSTER_KEYRING=off');
      expect(existsSync(join(h.cli.home, 'config', 'rooster', 'config.toml'))).toBe(false);

      const before = keychain.state.calls;
      const off = await h.run(
        ['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER],
        { ROOSTER_KEYRING: 'off' },
        'tok',
      );
      expect(off.code).toBe(0);
      expect(off.stderr).not.toContain('No system keychain');
      expect(keychain.state.calls).toBe(before);
      expect(h.configText()).toContain('credential_store = "file"');
      expect((await h.run(['whoami', '--quiet'])).stdout).toBe('ada@example.com\n');
    } finally {
      h.cli.cleanup();
    }
  });

  it('concurrent logins of two profiles leave both usable', async () => {
    const h = harness(async () => null);
    try {
      const [a, b] = await Promise.all([h.login('work'), h.login('home')]);
      expect([a.code, b.code]).toEqual([0, 0]);
      for (const profile of ['work', 'home']) {
        const who = await h.run(['whoami', '--quiet', '--profile', profile]);
        expect(who.stdout, profile).toBe('ada@example.com\n');
      }
    } finally {
      h.cli.cleanup();
    }
  });
});

describe('[P1] a stored login is only sent to its own server', () => {
  it('refuses ROOSTER_SERVER or a changed server setting with exit 3, sending nothing', async () => {
    const requests: string[] = [];
    const api = fakeApi({ 'GET /api/v1/meta': {}, 'GET /api/v1/me': ME });
    const cli = cliHarness(
      {},
      {
        fetch: (async (input: Request) => {
          requests.push(new URL(input.url).origin);
          return api.fetch(input);
        }) as typeof fetch,
      },
    );
    try {
      const login = await cli.run(['login', '--with-token', '--server', 'https://a.example'], {
        stdin: 'secret-token-of-a',
      });
      expect(login.code).toBe(0);
      requests.length = 0;

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
      expect(requests[0]).toBe('https://attacker.example');
    } finally {
      cli.cleanup();
    }
  });

  it('a store and profile that disagree on the server (a racing login) give no login', async () => {
    const api = fakeApi({ 'GET /api/v1/meta': {}, 'GET /api/v1/me': ME });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      expect(
        (
          await cli.run(['login', '--with-token', '--server', 'https://a.example'], {
            stdin: 'tok',
          })
        ).code,
      ).toBe(0);
      const store = new CredentialStore(join(cli.home, 'config', 'rooster'), async () => null);
      await store.save('default', { token: 'tok-b', server: 'https://b.example' });
      expect((await cli.run(['whoami'])).code).toBe(3);
    } finally {
      cli.cleanup();
    }
  });
});

describe('[P1] profile names on case-insensitive file systems', () => {
  it('home and Home get different files; names are p- plus lowercase hex', () => {
    expect(fileNameOf('home')).toBe('p-686f6d65');
    expect(fileNameOf('Home')).toBe('p-486f6d65');
    expect(fileNameOf('home')).not.toBe(fileNameOf('Home'));
    for (const name of ['home', 'Home', 'HOME', '../x', 'Ärende', 'with space', '.', '']) {
      expect(fileNameOf(name), name).toMatch(/^p-[0-9a-f]*$/);
    }
  });
});

describe('[P2] a refused login never replaces the active keychain login', () => {
  it('write ok, read-back "Secret Service: object locked": exit 3, and the old login still works', async () => {
    const keychain = fakeKeychain();
    const sent: string[] = [];
    const api = fakeApi({
      'GET /api/v1/meta': {},
      'GET /api/v1/me': ME,
      'GET /api/v1/me/grants': [],
    });
    const cli = cliHarness(
      { loadKeyring: keychain.load },
      {
        fetch: (async (input: Request) => {
          sent.push(input.headers.get('authorization') ?? '');
          return api.fetch(input);
        }) as typeof fetch,
      },
    );
    const env = { ROOSTER_KEYRING: '' };
    try {
      const first = await cli.run(['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER], {
        stdin: 'old-token',
        env,
      });
      expect(first.code).toBe(0);
      const config = readFileSync(join(cli.home, 'config', 'rooster', 'config.toml'), 'utf8');
      const active = /credential_account = "([^"]+)"/.exec(config)?.[1] as string;
      expect(active).toMatch(/^default:/);

      // The new login's write works; reading it back fails as with a locked collection.
      keychain.state.failGet = (account) => (account === active ? null : OBJECT_LOCKED);
      const second = await cli.run(['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER], {
        stdin: 'new-token',
        env,
      });
      expect(second.code).toBe(3);
      expect(second.stderr).toContain('ROOSTER_KEYRING=off');
      // The staged entry was discarded; the active one is untouched.
      expect([...keychain.entries.keys()]).toEqual([`rooster/${active}`]);

      keychain.state.failGet = null;
      sent.length = 0;
      expect((await cli.run(['whoami', '--quiet'], { env })).stdout).toBe('ada@example.com\n');
      expect(sent[0]).toBe('Bearer old-token');
    } finally {
      cli.cleanup();
    }
  });

  it('a successful re-login publishes the new account and drops the previous one', async () => {
    const keychain = fakeKeychain();
    const api = fakeApi({ 'GET /api/v1/meta': {}, 'GET /api/v1/me': ME });
    const cli = cliHarness({ loadKeyring: keychain.load }, { fetch: api.fetch });
    const env = { ROOSTER_KEYRING: '' };
    try {
      for (const token of ['one', 'two']) {
        const login = await cli.run(
          ['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER],
          {
            stdin: token,
            env,
          },
        );
        expect(login.code).toBe(0);
      }
      expect(keychain.entries.size).toBe(1);
      const [value] = [...keychain.entries.values()];
      expect(JSON.parse(value ?? '{}')).toMatchObject({ token: 'two' });
    } finally {
      cli.cleanup();
    }
  });
});

describe('[P1] the token is chosen for the origin the request goes to', () => {
  it('a profile switched to another server by another process between api() and token() sends nothing', async () => {
    const requests: string[] = [];
    const api = fakeApi({ 'GET /api/v1/meta': {}, 'GET /api/v1/me': ME });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      expect(
        (
          await cli.run(['login', '--with-token', '--server', 'https://a.example'], {
            stdin: 'tok-a',
          })
        ).code,
      ).toBe(0);
      const io = fakeIo(cli.home, {
        fetch: (async (input: Request) => {
          requests.push(input.url);
          return api.fetch(input);
        }) as typeof fetch,
      });
      const configDirPath = join(cli.home, 'config', 'rooster');
      for (const freshConfig of [false, true]) {
        const runtime = new Runtime(io, NO_GLOBALS);
        const realServer = runtime.server.bind(runtime);
        runtime.server = () => {
          const server = realServer();
          // Another process logs the same profile in to b.example right now.
          writeFileAtomic(
            join(configDirPath, 'credentials.d', fileNameOf('default')),
            JSON.stringify({ token: 'tok-b', server: 'https://b.example' }),
            0o600,
          );
          new ConfigStore(configDirPath).updateProfile('default', (p) => ({
            ...p,
            server: 'https://b.example',
            credential_origin: 'https://b.example',
          }));
          // Whether this process sees the new config or its earlier read, no token may go
          // to a.example (the origin the client was built for).
          if (freshConfig) runtime.config.reload();
          return server;
        };
        expect(realServer()).toBe('https://a.example');
        const result = await withRuntime(runtime, () => runtime.api()).catch((e: unknown) => e);
        expect(result, `fresh=${freshConfig}`).toMatchObject({ exitCode: 3 });
        expect(requests).toEqual([]);
        // Back to a.example for the next round.
        writeFileAtomic(
          join(configDirPath, 'credentials.d', fileNameOf('default')),
          JSON.stringify({ token: 'tok-a', server: 'https://a.example' }),
          0o600,
        );
        new ConfigStore(configDirPath).updateProfile('default', (p) => ({
          ...p,
          server: 'https://a.example',
          credential_origin: 'https://a.example',
        }));
      }
      // And a direct check: a stored login for a.example is never handed out for b.example.
      const fresh = new Runtime(fakeIo(cli.home), NO_GLOBALS);
      expect(await fresh.token('https://a.example')).toBe('tok-a');
      await expect(fresh.token('https://b.example')).rejects.toMatchObject({ exitCode: 3 });
    } finally {
      cli.cleanup();
    }
  });
});

describe('[P1] config.toml read-modify-write is locked across processes', () => {
  it('waits for a live holder, then gives up with ConfigLockedError', () => {
    const store = new ConfigStore(dir, { timeoutMs: 100 });
    writeFileSync(`${store.path}.lock`, `${process.pid} ${Date.now()} x`);
    expect(() => store.updateProfile('home', (p) => ({ ...p, org: 'a' }))).toThrow(
      ConfigLockedError,
    );
    rmSync(`${store.path}.lock`);
    store.updateProfile('home', (p) => ({ ...p, org: 'a' }));
    expect(store.reload().profiles.home).toEqual({ org: 'a' });
    expect(existsSync(`${store.path}.lock`)).toBe(false);
  });

  it('takes over a stale lock whose process is gone, but not one whose process lives', () => {
    const store = new ConfigStore(dir, { timeoutMs: 100, staleMs: 1_000 });
    const old = Date.now() - 60_000;
    writeFileSync(`${store.path}.lock`, `2147483646 ${old} x`);
    store.updateProfile('home', (p) => ({ ...p, org: 'a' }));
    expect(existsSync(`${store.path}.lock`)).toBe(false);
    writeFileSync(`${store.path}.lock`, `${process.pid} ${old} x`);
    expect(() => store.updateProfile('home', (p) => ({ ...p, org: 'b' }))).toThrow(
      ConfigLockedError,
    );
    rmSync(`${store.path}.lock`);
  });

  it('releases the lock when the change throws', () => {
    const store = new ConfigStore(dir);
    expect(() =>
      store.update(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(`${store.path}.lock`)).toBe(false);
  });

  it('three real processes adding profiles at once lose none of them', () => {
    const writer = join(import.meta.dirname, 'support', 'config-writer.ts');
    const count = 25;
    const children = ['a', 'b', 'c'].map((prefix) =>
      spawn(process.execPath, ['--import', 'tsx', writer, dir, prefix, String(count)], {
        cwd: join(import.meta.dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );
    return Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            let err = '';
            child.stderr?.on('data', (d: Buffer) => {
              err += d.toString();
            });
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
          }),
      ),
    ).then(() => {
      const profiles = new ConfigStore(dir).reload().profiles;
      for (const prefix of ['a', 'b', 'c']) {
        for (let n = 0; n < count; n++) {
          expect(profiles[`${prefix}-${n}`], `${prefix}-${n}`).toEqual({ org: String(n) });
        }
      }
      expect(Object.keys(profiles)).toHaveLength(3 * count);
    });
  }, 60_000);
});
