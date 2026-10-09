import type { Runtime } from '../runtime.ts';

/**
 * P9 WP 9.1 (owned by the TUI agent): the full-screen TUI (07 §5), opened by `rooster` with no
 * arguments on a terminal. Resolves when the user quits. Returns false when the TUI can't run
 * (no raw-mode TTY), so the caller falls back to `rooster ls`.
 */
export async function runTui(_runtime: Runtime): Promise<boolean> {
  return false;
}
