import type { ListOpSpec } from '@rooster/core/reducers';
import { create } from 'zustand';
import { onSessionDataCleared } from '../data/session-events';

/** 02 §3.7: the last 50 user operations, session-scoped. */
export const undoLimit = 50;

/** One user operation (04 §5.2 `undoStore`): its inverse and the ops that redo it. */
export interface UndoEntry {
  orgId: string;
  /** Translated, e.g. "Task deleted"; shown in the undo toast. */
  label: string;
  inverseOps: ListOpSpec[];
  redoOps: ListOpSpec[];
}

interface UndoStore {
  undo: UndoEntry[];
  redo: UndoEntry[];
  /** A new user operation clears the redo stack. */
  push: (entry: UndoEntry) => void;
  popUndo: () => UndoEntry | undefined;
  popRedo: () => UndoEntry | undefined;
  pushRedo: (entry: UndoEntry) => void;
  /** After a redo: back on the undo stack without clearing the redo stack. */
  pushUndoKeepRedo: (entry: UndoEntry) => void;
  clear: () => void;
}

const capped = (entries: UndoEntry[]) => entries.slice(-undoLimit);

export const useUndoStore = create<UndoStore>()((set, get) => ({
  undo: [],
  redo: [],
  push: (entry) => set((s) => ({ undo: capped([...s.undo, entry]), redo: [] })),
  popUndo: () => {
    const entry = get().undo.at(-1);
    if (entry) set((s) => ({ undo: s.undo.slice(0, -1) }));
    return entry;
  },
  popRedo: () => {
    const entry = get().redo.at(-1);
    if (entry) set((s) => ({ redo: s.redo.slice(0, -1) }));
    return entry;
  },
  pushRedo: (entry) => set((s) => ({ redo: capped([...s.redo, entry]) })),
  pushUndoKeepRedo: (entry) => set((s) => ({ undo: capped([...s.undo, entry]) })),
  clear: () => set({ undo: [], redo: [] }),
}));

// Undo replays ops through the pipeline: another session must never inherit them.
onSessionDataCleared(() => useUndoStore.getState().clear());
