import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { launchBrowser, runEditor, type SpawnFn } from './launch.ts';

export interface OutStream {
  write(text: string): void;
  isTTY?: boolean;
  columns?: number;
}

/**
 * Everything the CLI touches outside itself. `nodeIo()` is the real process; tests pass their
 * own (captured output, a temp home, a fake browser and clock).
 */
export interface Io {
  stdout: OutStream;
  stderr: OutStream;
  stdinIsTTY: boolean;
  /** The whole of stdin as text. */
  readStdin(): Promise<string>;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
  now(): number;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  /** Opens an already validated URL (`openableUrl`) in the browser; false when it could not. */
  openUrl(href: string): Promise<boolean>;
  /** Runs the editor argv on `file` attached to the terminal; resolves its exit code. */
  runEditor(editor: readonly string[], file: string): Promise<number>;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) =>
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    );
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

export function nodeIo(): Io {
  const spawnFn = spawn as unknown as SpawnFn;
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: () => readAll(process.stdin),
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    now: () => Date.now(),
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    openUrl: (href) => launchBrowser(spawnFn, process.platform, href),
    runEditor: (editor, file) => runEditor(spawnFn, editor, file),
  };
}
