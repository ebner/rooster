import type { Runtime } from '../runtime.ts';

export interface TuiStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/** Whether the full-screen TUI can run: both ends a terminal that can do raw mode. */
export function canRunTui(runtime: Runtime, streams: TuiStreams): boolean {
  return (
    runtime.io.stdinIsTTY &&
    streams.stdin.isTTY === true &&
    typeof streams.stdin.setRawMode === 'function' &&
    streams.stdout.isTTY === true &&
    runtime.io.env.TERM !== 'dumb'
  );
}

/**
 * P9 WP 9.1: the full-screen TUI (07 §5), opened by `rooster` with no arguments on a terminal.
 * Resolves when the user quits. Returns false when the TUI can't run (no raw-mode TTY), so the
 * caller falls back to `rooster ls`.
 *
 * React and Ink are loaded only here, with a dynamic import, so every other command (and
 * every script piping `rooster`) starts without them.
 */
export async function runTui(
  runtime: Runtime,
  streams: TuiStreams = { stdin: process.stdin, stdout: process.stdout },
): Promise<boolean> {
  if (!canRunTui(runtime, streams)) return false;
  // Sign-in and network problems surface as the usual CLI errors and exit codes, before the
  // screen is taken over.
  await runtime.api();
  await runtime.me();
  const { startTui } = await import('./main.tsx');
  await startTui(runtime, streams);
  return true;
}
