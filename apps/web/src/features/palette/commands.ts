import { useEffect } from 'react';

/**
 * The bridge between the palette (mounted once in the app shell) and the screen that owns the
 * current selection (the list). A screen publishes what it can do for its selection; the palette
 * reads the topmost provider. Keyed actions go through the keymap registry instead; this covers
 * the palette-only commands that need an argument (a picked task).
 */
export interface PaletteCommands {
  /** Selected task IDs in the current list (empty: no task actions). */
  selectedTaskIds: readonly string[];
  orgId: string;
  /** "Make subtask of…" (ADR 0008): re-parent the selection under `parentId`. */
  makeSubtaskOf?: (parentId: string) => void;
}

type Listener = () => void;
const stack: PaletteCommands[] = [];
const listeners = new Set<Listener>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** The topmost published commands, or null when no screen publishes any. */
export function currentPaletteCommands(): PaletteCommands | null {
  return stack.at(-1) ?? null;
}

export function subscribePaletteCommands(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publishes `commands` while mounted. Pass a memoised object; a new identity re-publishes. */
export function usePaletteCommands(commands: PaletteCommands | null): void {
  useEffect(() => {
    if (!commands) return;
    stack.push(commands);
    notify();
    return () => {
      const index = stack.lastIndexOf(commands);
      if (index >= 0) stack.splice(index, 1);
      notify();
    };
  }, [commands]);
}
