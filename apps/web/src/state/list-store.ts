import { create } from 'zustand';

/** 02 §3.2: Navigate (a row is selected) or Edit (caret in a title or group name). */
export type ListMode = 'navigate' | 'edit';

/** Where the caret goes when a title input mounts. */
export type Caret = 'end' | 'start' | 'all' | number;

/**
 * A new row that is not persisted until its title is non-empty and committed (02 §3.4).
 * Its id becomes the task id, so committing keeps the same row (and focus).
 */
export interface Draft {
  id: string;
  groupId: string;
  /** The row directly above within the group (task or draft); null = top of the group. */
  afterId: string | null;
}

/** The DnD insertion point, drawn on one row (02 §5). */
export interface DropIndicator {
  rowId: string;
  edge: 'before' | 'after' | 'inside';
}

export interface KeyboardDrag {
  ids: string[];
  /** Index into the drop slots computed from the rows. */
  slot: number;
}

export interface ListPopover {
  kind: 'moveTo' | 'date' | 'groupDelete' | 'groupMenu';
  /** The row the popover is anchored to. */
  rowId: string;
}

/** The row id of a group header. */
export const groupRowId = (groupId: string) => `group:${groupId}`;
export const addRowId = (groupId: string) => `add:${groupId}`;
export const addGroupRowId = 'add-group';
export const isGroupRowId = (id: string) => id.startsWith('group:');
export const groupIdOfRow = (id: string) => id.slice('group:'.length);

export interface ListUiState {
  mode: ListMode;
  /** The focused (most recently selected) row. */
  cursor: string | null;
  selected: Readonly<Record<string, true>>;
  /** Shift-range anchor. */
  anchor: string | null;
  /** The row whose title (or group name) is being edited; `seq` re-applies the caret. */
  editing: { rowId: string; caret: Caret; seq: number } | null;
  /** Bumped to ask the list to move DOM focus to the cursor again. */
  focusSeq: number;
  drafts: readonly Draft[];
  showCompleted: boolean;
  /** Completion sequence (02 §3.6): held visible, then collapsing. */
  hiding: Readonly<Record<string, 'hold' | 'collapsing'>>;
  popover: ListPopover | null;
  /** Pointer drag in progress: the dragged ids. */
  dragging: readonly string[] | null;
  /** Group drag: every group renders collapsed (02 §5). */
  dragCollapsed: boolean;
  /** Collapsed groups opened by hovering during a drag (600 ms). */
  hoverExpanded: Readonly<Record<string, true>>;
  drop: DropIndicator | null;
  keyboardDrag: KeyboardDrag | null;
}

export interface ListUiActions {
  set: (patch: Partial<ListUiState>) => void;
  /** Selects exactly one row (Navigate). */
  select: (rowId: string | null, mode?: ListMode) => void;
  /** Enters Edit on a row. */
  edit: (rowId: string, caret?: Caret) => void;
  /** Leaves Edit for Navigate on the same (or given) row. */
  navigate: (rowId?: string | null) => void;
  toggleSelected: (rowId: string) => void;
  selectRange: (ids: readonly string[], cursor: string) => void;
  addDraft: (draft: Draft) => void;
  removeDraft: (id: string) => void;
  setHiding: (id: string, phase: 'hold' | 'collapsing' | null) => void;
  reset: () => void;
}

export type ListStore = ListUiState & ListUiActions;

const showCompletedKey = 'rooster.list.showCompleted';

function readShowCompleted(): boolean {
  try {
    return globalThis.localStorage?.getItem(showCompletedKey) === '1';
  } catch {
    return false;
  }
}

export function persistShowCompleted(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(showCompletedKey, value ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the toggle still works for this session.
  }
}

const initial = (): ListUiState => ({
  mode: 'navigate',
  cursor: null,
  selected: {},
  anchor: null,
  editing: null,
  focusSeq: 0,
  drafts: [],
  showCompleted: readShowCompleted(),
  hiding: {},
  popover: null,
  dragging: null,
  dragCollapsed: false,
  hoverExpanded: {},
  drop: null,
  keyboardDrag: null,
});

let editSeq = 0;

/** List UI state (04 §5.2 `listStore`). One list is on screen at a time. */
export const useListStore = create<ListStore>()((set) => ({
  ...initial(),
  set: (patch) => set(patch),
  select: (rowId, mode = 'navigate') =>
    set((s) => ({
      mode,
      cursor: rowId,
      anchor: rowId,
      selected: rowId ? { [rowId]: true } : {},
      editing: mode === 'edit' ? s.editing : null,
      focusSeq: s.focusSeq + 1,
    })),
  edit: (rowId, caret = 'end') => {
    editSeq += 1;
    set({
      mode: 'edit',
      cursor: rowId,
      anchor: rowId,
      selected: { [rowId]: true },
      editing: { rowId, caret, seq: editSeq },
    });
  },
  navigate: (rowId) =>
    set((s) => {
      const target = rowId === undefined ? s.cursor : rowId;
      return {
        mode: 'navigate',
        editing: null,
        cursor: target,
        anchor: target,
        selected: target ? { [target]: true } : {},
        focusSeq: s.focusSeq + 1,
      };
    }),
  toggleSelected: (rowId) =>
    set((s) => {
      const selected = { ...s.selected };
      if (selected[rowId]) delete selected[rowId];
      else selected[rowId] = true;
      return { selected, cursor: rowId, anchor: rowId, mode: 'navigate', editing: null };
    }),
  selectRange: (ids, cursor) =>
    set((s) => ({
      selected: Object.fromEntries(ids.map((id) => [id, true] as const)),
      cursor,
      mode: 'navigate',
      editing: null,
      focusSeq: s.focusSeq + 1,
    })),
  addDraft: (draft) => set((s) => ({ drafts: [...s.drafts, draft] })),
  removeDraft: (id) => set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) })),
  setHiding: (id, phase) =>
    set((s) => {
      const hiding = { ...s.hiding };
      if (phase) hiding[id] = phase;
      else delete hiding[id];
      return { hiding };
    }),
  reset: () => set(initial()),
}));

/** The selected row ids in no particular order. */
export function selectedIds(state: Pick<ListUiState, 'selected'>): string[] {
  return Object.keys(state.selected);
}
