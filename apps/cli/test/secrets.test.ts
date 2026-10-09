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
  type CredentialRef,
  CredentialRemovalError,
  CredentialStore,
  CredentialStoreUnavailable,
  isFileRef,
  isStoreAbsent,
  KeychainRefused,
  type KeyringFactory,
  newFileRef,
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
    /** Pauses a read (before it looks) or a delete of an account, to interleave processes. */
    beforeGet: null as ((account: string) => Promise<void>) | null,
    beforeDelete: null as ((account: string) => Promise<void>) | null,
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
        await state.beforeGet?.(account);
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
        await state.beforeDelete?.(account);
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

describe('login stages one store (CredentialStore.save)', () => {
  it('the keychain under a fresh account when a write and its read-back succeed', async () => {
    const keychain = fakeKeychain();
    const store = new CredentialStore(dir, keychain.load);
    const saved = await store.save('home', A);
    expect(saved.store).toBe('keychain');
    expect(saved.ref).toMatch(/^home:[0-9a-f-]{36}$/);
    expect(JSON.parse(keychain.entries.get(`rooster/${saved.ref}`) ?? '{}')).toEqual(A);
    expect(await store.load(saved)).toEqual(A);
  });

  it.each([
    ['no addon', async () => null],
    ['ServiceUnknown on every call', 'calls'],
    ['KeyRevoked when creating the entry', 'construct'],
  ] as const)('a provably absent keychain (%s): a new 0600 file of its own', async (_name, how) => {
    const keychain = fakeKeychain();
    if (how === 'calls') keychain.state.failCalls = SERVICE_UNKNOWN;
    if (how === 'construct') keychain.state.failConstruct = KEY_REVOKED;
    const store = new CredentialStore(dir, typeof how === 'function' ? how : keychain.load);
    const saved = await store.save('home', A);
    expect(saved.store).toBe('file');
    expect(isFileRef(saved.ref)).toBe(true);
    expect(statSync(store.pathOf(saved.ref)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'credentials.d')).mode & 0o777).toBe(0o700);
    expect(await store.load(saved)).toEqual(A);
    // Every login is a new generation: a second one never overwrites the first.
    const again = await store.save('home', { ...A, token: 'tok-2' });
    expect(again.ref).not.toBe(saved.ref);
    expect(await store.load(saved)).toEqual(A);
  });

  it.each([OBJECT_LOCKED, PROMPT_DISMISSED, ACCESS_DENIED, SOCKET_OUTAGE, 'Access is denied.'])(
    'a keychain failing with "%s" refuses the login (never a silent file login)',
    async (message) => {
      const keychain = fakeKeychain();
      keychain.state.failCalls = message;
      const store = new CredentialStore(dir, keychain.load);
      await expect(store.save('home', A)).rejects.toBeInstanceOf(KeychainRefused);
      expect(existsSync(join(dir, 'credentials.d'))).toBe(false);
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

describe('reads use only the recorded ref', () => {
  it.each([OBJECT_LOCKED, PROMPT_DISMISSED, ACCESS_DENIED, SOCKET_OUTAGE, SERVICE_UNKNOWN])(
    'a recorded keychain failing with "%s" fails closed',
    async (message) => {
      const keychain = fakeKeychain();
      const store = new CredentialStore(dir, keychain.load);
      const saved = await store.save('home', A);
      keychain.state.failCalls = message;
      await expect(store.load(saved)).rejects.toBeInstanceOf(CredentialStoreUnavailable);
    },
  );

  it('a recorded keychain without the addon fails closed', async () => {
    const store = new CredentialStore(dir, async () => null);
    await expect(store.load({ store: 'keychain', ref: 'home:x' })).rejects.toBeInstanceOf(
      CredentialStoreUnavailable,
    );
  });

  it('a recorded file never consults the keychain', async () => {
    const keychain = fakeKeychain();
    keychain.state.failCalls = SERVICE_UNKNOWN;
    const store = new CredentialStore(dir, keychain.load);
    const saved = await store.save('home', A);
    keychain.state.failCalls = null;
    const before = keychain.state.calls;
    expect(await store.load(saved)).toEqual(A);
    expect(keychain.state.calls).toBe(before);
  });

  it('a file ref that is not ours (a tampered config) is never a path', async () => {
    const store = new CredentialStore(dir, async () => null);
    expect(await store.load({ store: 'file', ref: '../../etc/passwd' })).toBeUndefined();
    await store.remove({ store: 'file', ref: '../../etc/passwd' });
    expect(() => store.pathOf('../x')).toThrow();
  });
});

describe('logout removes exactly the recorded ref, confirmed or not at all', () => {
  it('a failed keychain delete (ServiceUnknown after reads worked) is an error', async () => {
    const keychain = fakeKeychain();
    const store = new CredentialStore(dir, keychain.load);
    const saved = await store.save('home', A);
    keychain.state.failCalls = SERVICE_UNKNOWN;
    await expect(store.remove(saved)).rejects.toMatchObject({ where: 'keychain' });
    keychain.state.failCalls = null;
    expect(await store.load(saved)).toEqual(A);
  });

  it.skipIf(asRoot)('a file that cannot be removed is an error naming the file', async () => {
    const store = new CredentialStore(dir, async () => null);
    const saved = await store.save('home', A);
    chmodSync(join(dir, 'credentials.d'), 0o500);
    try {
      const error = await store.remove(saved).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CredentialRemovalError);
      expect((error as CredentialRemovalError).where).toBe(store.pathOf(saved.ref));
    } finally {
      chmodSync(join(dir, 'credentials.d'), 0o700);
    }
  });

  it('a removed or never stored login is confirmed', async () => {
    const store = new CredentialStore(dir, async () => null);
    const saved = await store.save('home', A);
    await store.remove(saved);
    await store.remove(saved);
    expect(await store.load(saved)).toBeUndefined();
  });
});

describe('credential files', () => {
  it('concurrent logins and logouts of different profiles leave each other intact', async () => {
    const store = new CredentialStore(dir, async () => null);
    const profiles = ['work', 'home', 'ci', 'a.b', '../x', 'with space'];
    const refs = await Promise.all(
      profiles.map((p) => store.save(p, { token: `t-${p}`, server: A.server })),
    );
    await store.remove(refs[2] as CredentialRef);
    for (const [i, p] of profiles.entries()) {
      const expected = p === 'ci' ? undefined : { token: `t-${p}`, server: A.server };
      expect(await store.load(refs[i] as CredentialRef), p).toEqual(expected);
    }
    expect(existsSync(join(dir, 'x'))).toBe(false);
  });

  it('[P1] home and Home get different, lowercase-only names', () => {
    const home = newFileRef('home');
    const Home = newFileRef('Home');
    expect(home.slice(0, 32)).not.toBe(Home.slice(0, 32));
    for (const ref of [home, Home, newFileRef('ÄRENDE'), newFileRef('../x')]) {
      expect(ref).toMatch(/^[0-9a-f]{32}-[0-9a-f-]{36}$/);
      expect(ref).toBe(ref.toLowerCase());
    }
  });

  it('[P2] a 128-character profile name still fits (with the atomic-write temp suffix)', async () => {
    const store = new CredentialStore(dir, async () => null);
    const profile = 'p'.repeat(128);
    const saved = await store.save(profile, A);
    expect(saved.ref.length).toBe(69);
    expect(await store.load(saved)).toEqual(A);
    const longest = `${saved.ref}.${2 ** 22}.${Date.now()}.tmp`;
    expect(longest.length).toBeLessThan(255);
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
        join(dirPath, newFileRef('default')),
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
          const ref = /credential_ref = "([^"]+)"/.exec(h.configText())?.[1] as string;
          expect(logout.stderr).toContain(join(dirPath, ref));
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
      // The recorded file now holds a login for another server (a racing login).
      const configDirPath = join(cli.home, 'config', 'rooster');
      const ref = new ConfigStore(configDirPath).reload().profiles.default
        ?.credential_ref as string;
      writeFileAtomic(
        join(configDirPath, 'credentials.d', ref),
        JSON.stringify({ token: 'tok-b', server: 'https://b.example' }),
        0o600,
      );
      expect((await cli.run(['whoami'])).code).toBe(3);
    } finally {
      cli.cleanup();
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
      const active = /credential_ref = "([^"]+)"/.exec(config)?.[1] as string;
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
      const original = new ConfigStore(configDirPath).reload().profiles.default ?? {};
      for (const freshConfig of [false, true]) {
        const runtime = new Runtime(io, NO_GLOBALS);
        const realServer = runtime.server.bind(runtime);
        runtime.server = () => {
          const server = realServer();
          // Another process logs the same profile in to b.example right now.
          const ref = newFileRef('default');
          writeFileAtomic(
            join(configDirPath, 'credentials.d', ref),
            JSON.stringify({ token: 'tok-b', server: 'https://b.example' }),
            0o600,
          );
          new ConfigStore(configDirPath).updateProfile('default', (p) => ({
            ...p,
            server: 'https://b.example',
            credential_ref: ref,
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
        new ConfigStore(configDirPath).updateProfile('default', () => original);
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

  it('[P1] never takes over a lock automatically, even a dead holder’s; names the holder', () => {
    const store = new ConfigStore(dir, { timeoutMs: 100 });
    writeFileSync(`${store.path}.lock`, `2147483646 ${Date.now() - 3_600_000} x`);
    const error = (() => {
      try {
        store.updateProfile('home', (p) => ({ ...p, org: 'a' }));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigLockedError);
    expect((error as ConfigLockedError).holderPid).toBe(2147483646);
    expect(existsSync(`${store.path}.lock`)).toBe(true);
    expect(store.reload().profiles.home).toBeUndefined();
    rmSync(`${store.path}.lock`);
  });

  it.skipIf(asRoot)(
    '[P1] gives up within the deadline in a read-only directory, never spinning',
    () => {
      const store = new ConfigStore(dir, { timeoutMs: 50 });
      writeFileSync(`${store.path}.lock`, `2147483646 ${Date.now() - 3_600_000} x`);
      chmodSync(dir, 0o500);
      try {
        const started = Date.now();
        expect(() => store.updateProfile('home', (p) => ({ ...p, org: 'a' }))).toThrow();
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        chmodSync(dir, 0o700);
      }
      rmSync(`${store.path}.lock`);
      // Without a lock file, the read-only directory's EACCES propagates at once.
      chmodSync(dir, 0o500);
      try {
        const started = Date.now();
        let code: string | undefined;
        try {
          store.updateProfile('home', (p) => ({ ...p, org: 'a' }));
        } catch (e) {
          code = (e as NodeJS.ErrnoException).code;
        }
        expect(code).toBe('EACCES');
        expect(Date.now() - started).toBeLessThan(200);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('releases the lock when the change throws', () => {
    const store = new ConfigStore(dir);
    expect(() =>
      store.update(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(`${store.path}.lock`)).toBe(false);
  });

  it('[P1] a left-behind lock stops real processes instead of letting two in', async () => {
    writeFileSync(join(dir, 'config.toml.lock'), `2147483646 ${Date.now() - 3_600_000} x`);
    const writer = join(import.meta.dirname, 'support', 'config-writer.ts');
    const codes = await Promise.all(
      ['a', 'b', 'c'].map(
        (prefix) =>
          new Promise<number | null>((resolve) => {
            const child = spawn(
              process.execPath,
              ['--import', 'tsx', writer, dir, prefix, '1', '200'],
              { cwd: join(import.meta.dirname, '..'), stdio: 'ignore' },
            );
            child.on('exit', resolve);
          }),
      ),
    );
    expect(codes.every((code) => code !== 0)).toBe(true);
    expect(existsSync(join(dir, 'config.toml'))).toBe(false);
  }, 60_000);

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

/** A promise to pause on, with its release. */
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
};

/** A home with a keychain, a fake API that records the bearer tokens it receives, and a gate. */
function sharedHome(routes: Parameters<typeof fakeApi>[0] = {}) {
  const keychain = fakeKeychain();
  const bearers: string[] = [];
  const requests: { method: string; path: string; search: string; auth: string }[] = [];
  const grantsGate: { current: ReturnType<typeof gate> | null; asked: boolean } = {
    current: null,
    asked: false,
  };
  const api = fakeApi({
    'GET /api/v1/meta': {},
    'GET /api/v1/me': ME,
    'GET /api/v1/me/grants': [],
    ...routes,
  });
  const fetchFn = (async (input: Request) => {
    bearers.push(input.headers.get('authorization') ?? '');
    const url = new URL(input.url);
    requests.push({
      method: input.method,
      path: url.pathname,
      search: url.search,
      auth: input.headers.get('authorization') ?? '',
    });
    if (new URL(input.url).pathname === '/api/v1/me/grants' && grantsGate.current !== null) {
      grantsGate.asked = true;
      await grantsGate.current.promise;
    }
    return api.fetch(input);
  }) as typeof fetch;
  const cli = cliHarness({ loadKeyring: keychain.load }, { fetch: fetchFn });
  const env = { ROOSTER_KEYRING: '' };
  const login = (token: string, extra: Record<string, string> = {}) =>
    cli.run(['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER], {
      stdin: token,
      env: { ...env, ...extra },
    });
  const profile = () =>
    new ConfigStore(join(cli.home, 'config', 'rooster')).reload().profiles.default ?? {};
  return { keychain, bearers, requests, grantsGate, cli, env, login, profile, fetchFn };
}

describe('round 9 regressions', () => {
  it.skipIf(asRoot)(
    '[2] a failed publication discards exactly the staged login; the active one stays',
    async () => {
      const h = sharedHome();
      try {
        expect((await h.login('tok-1')).code).toBe(0);
        const active = h.profile().credential_ref as string;
        const configDirPath = join(h.cli.home, 'config', 'rooster');
        chmodSync(configDirPath, 0o500);
        let second: { code: number; stderr: string };
        try {
          second = await h.login('tok-2');
        } finally {
          chmodSync(configDirPath, 0o700);
        }
        expect(second.code).not.toBe(0);
        expect([...h.keychain.entries.keys()]).toEqual([`rooster/${active}`]);
        expect(h.profile().credential_ref).toBe(active);
        h.bearers.length = 0;
        expect((await h.cli.run(['whoami', '--quiet'], { env: h.env })).stdout).toBe(
          'ada@example.com\n',
        );
        expect(h.bearers[0]).toBe('Bearer tok-1');
      } finally {
        h.cli.cleanup();
      }
    },
  );

  it('[3] a process with an earlier config read sends the newer login, not a superseded one', async () => {
    const h = sharedHome();
    try {
      expect((await h.login('tok-1')).code).toBe(0);
      const runtimeA = new Runtime(
        {
          ...fakeIo(h.cli.home, { fetch: h.fetchFn }),
          env: { ...fakeIo(h.cli.home).env, ...h.env },
        },
        NO_GLOBALS,
        { loadKeyring: h.keychain.load },
      );
      expect(runtimeA.profile.credential_store).toBe('keychain'); // cached now
      // B logs in again and can't delete the old account: it is still in the keychain.
      h.keychain.state.failDelete = SERVICE_UNKNOWN;
      const relogin = await h.login('tok-2');
      h.keychain.state.failDelete = null;
      expect(relogin.code).toBe(0);
      expect(relogin.stderr).toContain('previous login could not be removed');
      expect(h.keychain.entries.size).toBe(2);
      expect(await runtimeA.token(FAKE_ENV.ROOSTER_SERVER)).toBe('tok-2');
    } finally {
      h.cli.cleanup();
    }
  });

  it('[3] a ref that changes during the secret read is read again', async () => {
    const h = sharedHome();
    try {
      expect((await h.login('tok-1')).code).toBe(0);
      const first = h.profile().credential_ref as string;
      const paused = gate();
      let reading = false;
      h.keychain.state.beforeGet = async (account) => {
        if (account === first && !reading) {
          reading = true;
          await paused.promise;
        }
      };
      const runtimeA = new Runtime(
        { ...fakeIo(h.cli.home), env: { ...fakeIo(h.cli.home).env, ...h.env } },
        NO_GLOBALS,
        { loadKeyring: h.keychain.load },
      );
      const read = runtimeA.token(FAKE_ENV.ROOSTER_SERVER);
      await until(() => reading);
      h.keychain.state.beforeGet = null;
      // B publishes a new login while A's read of the old one is in flight.
      expect((await h.login('tok-2')).code).toBe(0);
      paused.release();
      expect(await read).toBe('tok-2');
    } finally {
      h.cli.cleanup();
    }
  });

  it('[4] a logout overtaken by a new login leaves the new login alone and says so', async () => {
    const h = sharedHome();
    try {
      expect((await h.login('tok-1')).code).toBe(0);
      h.grantsGate.current = gate();
      const logout = h.cli.run(['logout'], { env: h.env });
      await until(() => h.grantsGate.asked);
      const paused = h.grantsGate.current;
      h.grantsGate.current = null;
      expect((await h.login('tok-2')).code).toBe(0);
      const newer = h.profile().credential_ref as string;
      paused.release();
      const result = await logout;
      expect(result.code).toBe(5);
      expect(result.stderr).toContain('newer login was kept');
      expect(result.stderr).not.toContain('Signed out');
      expect(h.profile().credential_ref).toBe(newer);
      expect([...h.keychain.entries.keys()]).toEqual([`rooster/${newer}`]);
      h.bearers.length = 0;
      expect((await h.cli.run(['whoami', '--quiet'], { env: h.env })).stdout).toBe(
        'ada@example.com\n',
      );
      expect(h.bearers[0]).toBe('Bearer tok-2');
    } finally {
      h.cli.cleanup();
    }
  });

  it('[5] a delayed cleanup of the previous keychain login never deletes a newer file login', async () => {
    const h = sharedHome();
    try {
      expect((await h.login('tok-1')).code).toBe(0);
      const k1 = h.profile().credential_ref as string;
      const paused = gate();
      let deleting = false;
      h.keychain.state.beforeDelete = async (account) => {
        if (account === k1) {
          deleting = true;
          await paused.promise;
        }
      };
      // A logs in to the keychain; its cleanup of K1 pauses.
      const loginA = h.login('tok-2');
      await until(() => deleting);
      // B logs in with ROOSTER_KEYRING=off: a file login of its own, published.
      expect((await h.login('tok-3', { ROOSTER_KEYRING: 'off' })).code).toBe(0);
      expect(h.profile().credential_store).toBe('file');
      paused.release();
      expect((await loginA).code).toBe(0);
      h.bearers.length = 0;
      expect((await h.cli.run(['whoami', '--quiet'], { env: h.env })).stdout).toBe(
        'ada@example.com\n',
      );
      expect(h.bearers[0]).toBe('Bearer tok-3');
    } finally {
      h.cli.cleanup();
    }
  });
});

describe('round 10 regressions', () => {
  it('[1] a default_profile change during the keychain read never moves a running command to another profile', async () => {
    const task = {
      id: '01a00000-0000-7000-8000-0000000000f2',
      orgId: ME.orgs[0]?.id,
      seq: 42,
      title: 'x',
    };
    const h = sharedHome({
      'GET /api/v1/tasks/resolve': task,
      'DELETE /api/v1/tasks/*': undefined,
    });
    const configDirPath = join(h.cli.home, 'config', 'rooster');
    try {
      for (const [name, token] of [
        ['home', 'tok-home'],
        ['work', 'tok-work'],
      ] as const) {
        const login = await h.cli.run(
          ['login', '--with-token', '--server', FAKE_ENV.ROOSTER_SERVER, '--profile', name],
          { stdin: token, env: h.env },
        );
        expect(login.code).toBe(0);
      }
      const store = new ConfigStore(configDirPath);
      store.updateProfile('work', (p) => ({ ...p, org: 'other' }));
      expect(store.reload().default_profile).toBe('home');
      const homeRef = store.reload().profiles.home?.credential_ref as string;

      const paused = gate();
      let reading = false;
      h.keychain.state.beforeGet = async (account) => {
        if (account === homeRef && !reading) {
          reading = true;
          await paused.promise;
        }
      };
      h.requests.length = 0;
      const rm = h.cli.run(['rm', '42', '--json', '--yes'], { env: h.env });
      await until(() => reading);
      // Another process switches the default profile mid-command.
      store.update((c) => ({ ...c, default_profile: 'work' }));
      paused.release();
      const result = await rm;
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const taskCalls = h.requests.filter((r) => r.path.startsWith('/api/v1/tasks'));
      expect(taskCalls.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /api/v1/tasks/resolve',
        `DELETE /api/v1/tasks/${task.id}`,
      ]);
      expect(taskCalls.every((r) => r.auth === 'Bearer tok-home')).toBe(true);
      expect(taskCalls[0]?.search).toContain('org=acme');
    } finally {
      h.cli.cleanup();
    }
  });

  it('[2] logout revokes only its own captured grant, never a newer login published meanwhile', async () => {
    const deleted: string[] = [];
    const h = sharedHome({
      'DELETE /api/v1/me/grants/*': (call: { path: string }) => {
        deleted.push(call.path);
        return undefined;
      },
    });
    // Each token sees its own device grant as current.
    const grantFor = (auth: string) => [
      {
        id: auth === 'Bearer tok-2' ? 'grant-new' : 'grant-old',
        kind: 'device',
        clientId: 'rooster-cli',
        label: 'x',
        scopes: ['tasks:read'],
        constraints: { orgs: 'all' },
        tokenPrefix: null,
        createdAt: 0,
        updatedAt: 0,
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        current: true,
      },
    ];
    const cli = cliHarness(
      { loadKeyring: h.keychain.load },
      {
        fetch: (async (input: Request) => {
          if (new URL(input.url).pathname === '/api/v1/me/grants' && input.method === 'GET') {
            return Response.json(grantFor(input.headers.get('authorization') ?? ''));
          }
          return h.fetchFn(input);
        }) as typeof fetch,
      },
    );
    // Use the shared home's directories.
    const env = {
      ...h.env,
      HOME: h.cli.home,
      XDG_CONFIG_HOME: join(h.cli.home, 'config'),
      XDG_STATE_HOME: join(h.cli.home, 'state'),
      XDG_CACHE_HOME: join(h.cli.home, 'cache'),
    };
    try {
      expect((await h.login('tok-1')).code).toBe(0);
      const k1 = h.profile().credential_ref as string;
      const paused = gate();
      let reading = false;
      h.keychain.state.beforeGet = async (account) => {
        if (account === k1 && !reading) {
          reading = true;
          await paused.promise;
        }
      };
      const logout = cli.run(['logout'], { env });
      await until(() => reading);
      h.keychain.state.beforeGet = null;
      // A new login is published while logout reads its captured credential.
      expect((await h.login('tok-2')).code).toBe(0);
      paused.release();
      const result = await logout;
      expect(result.code).toBe(5);
      expect(deleted).not.toContain('/api/v1/me/grants/grant-new');
      expect(h.profile().credential_ref).not.toBe(k1);
      h.bearers.length = 0;
      expect((await h.cli.run(['whoami', '--quiet'], { env: h.env })).stdout).toBe(
        'ada@example.com\n',
      );
      expect(h.bearers[0]).toBe('Bearer tok-2');
    } finally {
      cli.cleanup();
      h.cli.cleanup();
    }
  });
});
