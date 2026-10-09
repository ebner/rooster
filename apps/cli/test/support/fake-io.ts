import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../../src/io.ts';
import { type RunOptions, runCli } from '../../src/run.ts';

export interface FakeIo extends Io {
  out: string[];
  err: string[];
  opened: string[];
  stdinText: string;
}

/** An Io with a private home (XDG dirs), captured output and no keychain or browser. */
export function fakeIo(home: string, overrides: Partial<Io> = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const io: FakeIo = {
    out,
    err,
    opened,
    stdinText: '',
    stdout: { write: (text: string) => void out.push(text), isTTY: false },
    stderr: { write: (text: string) => void err.push(text), isTTY: false },
    stdinIsTTY: false,
    readStdin: async () => io.stdinText,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
      ROOSTER_KEYRING: 'off',
      LANG: 'en_US.UTF-8',
    },
    platform: 'linux',
    homedir: home,
    now: () => Date.now(),
    fetch: globalThis.fetch,
    sleep: async () => {},
    openUrl: async (href) => {
      opened.push(href);
      return true;
    },
    runEditor: async () => 0,
    ...overrides,
  };
  return io;
}

export interface CliHarness {
  home: string;
  env: Record<string, string | undefined>;
  /** Runs `rooster <argv>`; stdin text optional. */
  run(
    argv: readonly string[],
    options?: { stdin?: string; env?: Record<string, string | undefined> },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup(): void;
}

export function cliHarness(options: RunOptions = {}, overrides: Partial<Io> = {}): CliHarness {
  const home = mkdtempSync(join(tmpdir(), 'rooster-cli-'));
  const env: Record<string, string | undefined> = {};
  return {
    home,
    env,
    async run(argv, runOptions = {}) {
      const io = fakeIo(home, overrides);
      io.env = { ...io.env, ...env, ...runOptions.env };
      io.stdinText = runOptions.stdin ?? '';
      const code = await runCli(argv, io, options);
      return { code, stdout: io.out.join(''), stderr: io.err.join('') };
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
