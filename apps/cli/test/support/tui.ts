import { render } from 'ink-testing-library';
import { withLocale } from '../../src/i18n.ts';
import type { Io } from '../../src/io.ts';
import { NO_GLOBALS, Runtime, withRuntime } from '../../src/runtime.ts';
import { createSession, type TuiSession } from '../../src/tui/main.tsx';
import { type CliHarness, fakeIo } from './fake-io.ts';

// Ink measures the terminal through `terminal-size` when the stream has no rows; with these
// set it answers at once instead of asking `tput` (ink-testing-library's stdout has no rows).
process.env.COLUMNS ??= '100';
process.env.LINES ??= '30';

export const KEY = {
  enter: '\r',
  esc: '\u001b',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  delete: '\u001b[3~',
  backspace: '\u007f',
  ctrlR: '\u0012',
  ctrlC: '\u0003',
  pageDown: '\u001b[6~',
} as const;

export interface TuiHarness {
  session: TuiSession;
  runtime: Runtime;
  frame(): string;
  /** Sends keys one at a time (each string is one keypress, or one paste). */
  press(...keys: string[]): Promise<void>;
  /** Types text as single keypresses. */
  type(text: string): Promise<void>;
  waitFor(predicate: (frame: string) => boolean, timeoutMs?: number): Promise<string>;
  resize(columns: number, rows: number): void;
  close(): void;
}

// Ink waits 20 ms after a lone Esc to tell it from an escape sequence; keys sent faster than
// that would merge (Esc then d reads as Alt+d).
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The TUI of a signed-in CLI home (`cli`), rendered with ink-testing-library at `columns` ×
 * `rows`, against the in-process server the home is signed in to.
 */
export async function openTui(
  cli: CliHarness,
  options: { columns?: number; rows?: number; io?: Partial<Io> } = {},
): Promise<TuiHarness> {
  const io = fakeIo(cli.home, options.io);
  io.env = { ...io.env, ...cli.env };
  const runtime = new Runtime(io, NO_GLOBALS);
  const session = await withLocale('en', () => withRuntime(runtime, () => createSession(runtime)));
  const ui = render(session.element);
  let size = { columns: options.columns ?? 100, rows: options.rows ?? 30 };
  Object.defineProperty(ui.stdout, 'columns', { get: () => size.columns, configurable: true });
  Object.defineProperty(ui.stdout, 'rows', { get: () => size.rows, configurable: true });
  ui.stdout.emit('resize');
  await session.start();
  const frame = () => ui.lastFrame() ?? '';
  const harness: TuiHarness = {
    session,
    runtime,
    frame,
    async press(...keys) {
      for (const key of keys) {
        ui.stdin.write(key);
        await tick();
      }
    },
    async type(text) {
      for (const ch of text) {
        ui.stdin.write(ch);
        await tick(5);
      }
      await tick();
    },
    async waitFor(predicate, timeoutMs = 3_000) {
      const started = Date.now();
      for (;;) {
        const current = frame();
        if (predicate(current)) return current;
        if (Date.now() - started > timeoutMs) {
          throw new Error(`waitFor timed out; last frame:\n${current}`);
        }
        await tick();
      }
    },
    resize(columns, rows) {
      size = { columns, rows };
      ui.stdout.emit('resize');
    },
    close() {
      session.stop();
      ui.unmount();
      ui.cleanup();
    },
  };
  return harness;
}
