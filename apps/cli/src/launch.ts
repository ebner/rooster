import type { SpawnOptions } from 'node:child_process';

/** The subset of `child_process.spawn` the launchers use (mocked in tests). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  unref(): void;
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The URL to open, or null when it must only be printed: https (http for loopback hosts in
 * development), no credentials, and the same origin as the profile's server, so a server can
 * never make the CLI open anything but its own pages.
 */
export function openableUrl(raw: string, serverOrigin: string): string | null {
  let url: URL;
  let server: URL;
  try {
    url = new URL(raw);
    server = new URL(serverOrigin);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  const secure = url.protocol === 'https:';
  const devLoopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (!secure && !devLoopback) return null;
  if (url.origin !== server.origin) return null;
  return url.href;
}

/**
 * The browser launcher per platform: always an argv, never a shell, so no character of the
 * URL is interpreted (cmd's `start` would be).
 */
export function browserCommand(platform: NodeJS.Platform, href: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [href]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', href]];
  return ['xdg-open', [href]];
}

/** Starts the browser detached; resolves whether the launcher could be started. */
export function launchBrowser(
  spawn: SpawnFn,
  platform: NodeJS.Platform,
  href: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const [command, args] = browserCommand(platform, href);
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Splits `$VISUAL`/`$EDITOR` into argv the way a POSIX shell would for plain words and
 * quotes (`code --wait`, `"/Applications/My Editor/bin/edit" -w`), without running a shell.
 */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\$`]/.test(input.charAt(i + 1))) {
        current += input.charAt(++i);
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(current);
      current = '';
      inWord = false;
    } else if (ch === '\\' && i + 1 < input.length && !/[A-Za-z]/.test(input.charAt(i + 1))) {
      // An escaped space or quote; Windows paths (`C:\Program Files`) keep their backslashes.
      current += input.charAt(++i);
      inWord = true;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(current);
  return out;
}

/** Runs the editor on `file` attached to the terminal; resolves its exit code. */
export function runEditor(
  spawn: SpawnFn,
  editor: readonly string[],
  file: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = editor;
    if (command === undefined) {
      reject(new Error('No editor'));
      return;
    }
    const child = spawn(command, [...args, file], { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
