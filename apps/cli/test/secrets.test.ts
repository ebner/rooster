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
import {
  CredentialRemovalError,
  CredentialStore,
  CredentialStoreUnavailable,
  isStoreAbsent,
  KeychainRefused,
  type KeyringFactory,
} from '../src/secrets.ts';
import { FAKE_ENV, fakeApi, ME } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

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
    expect(await store.save('home', A)).toBe('keychain');
    expect(JSON.parse(keychain.entries.get('rooster/home') ?? '{}')).toEqual(A);
    expect(existsSync(store.pathOf('home'))).toBe(false);
    expect(await store.load('home', 'keychain')).toEqual(A);
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
    expect(await store.save('home', A)).toBe('file');
    expect(statSync(store.pathOf('home')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'credentials.d')).mode & 0o777).toBe(0o700);
    expect(await store.load('home', 'file')).toEqual(A);
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
      await store.save('home', A);
      mkdirSync(join(dir, 'credentials.d'), { recursive: true });
      writeFileSync(
        store.pathOf('home'),
        JSON.stringify({ token: 'stale-file', server: A.server }),
      );
      keychain.state.failCalls = message;
      await expect(store.load('home', 'keychain')).rejects.toBeInstanceOf(
        CredentialStoreUnavailable,
      );
    },
  );

  it('a recorded keychain without the addon fails closed', async () => {
    const store = new CredentialStore(dir, async () => null);
    await expect(store.load('home', 'keychain')).rejects.toBeInstanceOf(CredentialStoreUnavailable);
  });

  it('a recorded file never consults the keychain', async () => {
    const keychain = fakeKeychain();
    keychain.state.failCalls = SERVICE_UNKNOWN;
    const store = new CredentialStore(dir, keychain.load);
    expect(await store.save('home', A)).toBe('file');
    keychain.state.failCalls = null;
    keychain.entries.set('rooster/home', JSON.stringify({ token: 'keychain', server: A.server }));
    const before = keychain.state.calls;
    expect(await store.load('home', 'file')).toEqual(A);
    expect(keychain.state.calls).toBe(before);
  });
});

describe('logout removes from the recorded store, confirmed or not at all', () => {
  it('a failed keychain delete (ServiceUnknown after reads worked) is an error', async () => {
    const keychain = fakeKeychain();
    const store = new CredentialStore(dir, keychain.load);
    await store.save('home', A);
    keychain.state.failCalls = SERVICE_UNKNOWN;
    await expect(store.remove('home', 'keychain')).rejects.toMatchObject({ where: 'keychain' });
    keychain.state.failCalls = null;
    expect(await store.load('home', 'keychain')).toEqual(A);
  });

  it.skipIf(asRoot)('a file that cannot be removed is an error naming the file', async () => {
    const store = new CredentialStore(dir, async () => null);
    await store.save('home', A);
    chmodSync(join(dir, 'credentials.d'), 0o500);
    try {
      const error = await store.remove('home', 'file').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CredentialRemovalError);
      expect((error as CredentialRemovalError).where).toBe(store.pathOf('home'));
    } finally {
      chmodSync(join(dir, 'credentials.d'), 0o700);
    }
  });

  it('a removed or never stored login is confirmed', async () => {
    const store = new CredentialStore(dir, async () => null);
    await store.save('home', A);
    await store.remove('home', 'file');
    await store.remove('home', 'file');
    expect(await store.load('home', 'file')).toBeUndefined();
  });
});

describe('one file per profile', () => {
  it('concurrent logins and logouts of different profiles leave each other intact', async () => {
    const store = new CredentialStore(dir, async () => null);
    const profiles = ['work', 'home', 'ci', 'a.b', '../x', 'with space'];
    await Promise.all(profiles.map((p) => store.save(p, { token: `t-${p}`, server: A.server })));
    await Promise.all([
      store.remove('ci', 'file'),
      store.save('work', { token: 't-work-2', server: A.server }),
    ]);
    for (const p of profiles) {
      const expected =
        p === 'ci' ? undefined : { token: p === 'work' ? 't-work-2' : `t-${p}`, server: A.server };
      expect(await store.load(p, 'file'), p).toEqual(expected);
    }
    // Names never escape the directory.
    expect(store.pathOf('../x').startsWith(join(dir, 'credentials.d'))).toBe(true);
    expect(existsSync(join(dir, 'x'))).toBe(false);
  });

  it('moves the old shared credentials file to per-profile files, once', () => {
    writeFileSync(
      join(dir, 'credentials'),
      '[profiles.home]\ntoken = "tok-h"\nserver = "https://h.example/sub"\nat = 3\n[profiles.work]\ntoken = "tok-w"\nserver = "https://w.example"\n[profiles.gone]\ndeleted = true\nat = 9\n',
      { mode: 0o600 },
    );
    const store = new CredentialStore(dir, async () => null);
    expect(store.migrateLegacy('home')).toEqual({ token: 'tok-h', server: 'https://h.example' });
    expect(existsSync(join(dir, 'credentials'))).toBe(false);
    expect(JSON.parse(readFileSync(store.pathOf('work'), 'utf8'))).toEqual({
      token: 'tok-w',
      server: 'https://w.example',
    });
    expect(existsSync(store.pathOf('gone'))).toBe(false);
    expect(store.migrateLegacy('work')).toBeUndefined();
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
        join(dirPath, 'default'),
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
          expect(logout.stderr).toContain(join(dirPath, 'default'));
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

  it('migrates a login from the old shared credentials file', async () => {
    const h = harness(async () => null);
    try {
      expect((await h.run(['config', 'set', 'server', FAKE_ENV.ROOSTER_SERVER])).code).toBe(0);
      writeFileSync(
        join(h.cli.home, 'config', 'rooster', 'credentials'),
        `[profiles.default]\ntoken = "tok"\nserver = "${FAKE_ENV.ROOSTER_SERVER}"\nat = 1\n`,
        { mode: 0o600 },
      );
      expect((await h.run(['whoami', '--quiet'])).stdout).toBe('ada@example.com\n');
      expect(h.configText()).toContain('credential_store = "file"');
      expect(existsSync(join(h.cli.home, 'config', 'rooster', 'credentials'))).toBe(false);
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
