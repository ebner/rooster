import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { create, type StoreApi, type UseBoundStore, useStore } from 'zustand';

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
  /** The group the row renders in (for a subtask draft: its top-level ancestor's group). */
  groupId: string;
  /**
   * The row directly above within the group, or among the siblings for a subtask draft (task
   * or draft); null = the top.
   */
  afterId: string | null;
  /** Set for a subtask draft (P3): the parent it is created under. */
  parentId?: string;
  /**
   * A due date picked for the draft before it has a title (the phone's accessory bar,
   * 02 §13.3). A date phrase in the title still wins.
   */
  due?: DraftDue | undefined;
  /**
   * Smart views (02 §10): the section the draft renders in. `groupId` is then where the task
   * lands (the Inbox unless picked), and `afterId` the row above it within the section.
   */
  sectionId?: string | undefined;
}

/** The due fields a draft can carry (the shape of the date picker's value). */
export interface DraftDue {
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
  startDate?: string | null | undefined;
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
  kind: 'moveTo' | 'date' | 'groupDelete' | 'groupMenu' | 'tag' | 'assign' | 'recurringDelete';
  /** The row the popover is anchored to. */
  rowId: string;
}

/** The row id of a group header. */
export const groupRowId = (groupId: string) => `group:${groupId}`;
export const addRowId = (groupId: string) => `add:${groupId}`;
export const addGroupRowId = 'add-group';
/** The Upcoming section's header (ADR 0068). */
export const upcomingRowId = 'upcoming';
export const addSubtaskRowId = (parentId: string) => `addsub:${parentId}`;
/** A smart-view section header and its "+ Add task" row (02 §10). */
export const sectionRowId = (sectionId: string) => `section:${sectionId}`;
export const addSectionRowId = (sectionId: string) => `add:section:${sectionId}`;
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
  /** FR-TAG-4: only rows with one of these tags (empty = no filter). */
  tagFilter: readonly string[];
  /**
   * Phones (02 §13.2): a long-press entered selection mode. Checkboxes become selection
   * circles, a tap toggles a row, and the bulk bar replaces the bottom nav.
   */
  selectionMode: boolean;
  /**
   * The row whose title edit is paused while a sheet opened from the accessory bar has focus:
   * its blur neither commits nor discards the draft (02 §13.3).
   */
  suspendedEdit: string | null;
  /**
   * The task just created from a draft of this list, for an open pane to switch to (02 §3.3).
   * The row keeps the draft's id, so the cursor alone never shows the change.
   */
  created: string | null;
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
  /** Patches a draft (its group, position or picked due date). */
  updateDraft: (id: string, patch: Partial<Omit<Draft, 'id'>>) => void;
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
  tagFilter: [],
  selectionMode: false,
  suspendedEdit: null,
  created: null,
});

let editSeq = 0;

export type ListStoreHook = UseBoundStore<StoreApi<ListStore>>;

/**
 * A list UI store (04 §5.2 `listStore`). My tasks uses the app-wide `useListStore`; the pane's
 * subtask list (02 §9.2) gets its own, so both share the row component and keyboard model
 * without sharing a selection.
 */
export function createListStore(overrides: Partial<ListUiState> = {}): ListStoreHook {
  return create<ListStore>()((set) => ({
    ...initial(),
    ...overrides,
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
    updateDraft: (id, patch) =>
      set((s) => ({ drafts: s.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)) })),
    setHiding: (id, phase) =>
      set((s) => {
        const hiding = { ...s.hiding };
        if (phase) hiding[id] = phase;
        else delete hiding[id];
        return { hiding };
      }),
    reset: () => set({ ...initial(), ...overrides }),
  }));
}

/** The My tasks list store. */
export const useListStore = createListStore();

/** The store the list components below read (My tasks unless a provider says otherwise). */
export const ListStoreContext = createContext<ListStoreHook>(useListStore);

export function useListStoreApi(): ListStoreHook {
  return useContext(ListStoreContext);
}

/** `useListStore(selector)` for the list in context. */
export function useListUi<T>(selector: (state: ListStore) => T): T {
  return useStore(useContext(ListStoreContext), selector);
}

/**
 * Rows whose per-row UI state can differ between two store states: only these rows' listeners
 * run (`useRowUi`). `'all'` when a change touches every row (selection mode).
 */
export function changedRowIds(next: ListUiState, prev: ListUiState): Set<string> | 'all' {
  if (next.selectionMode !== prev.selectionMode) return 'all';
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id) ids.add(id);
  };
  const diffKeys = (a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>) => {
    for (const key in a) if (a[key] !== b[key]) ids.add(key);
    for (const key in b) if (a[key] !== b[key]) ids.add(key);
  };
  if (next.selected !== prev.selected) diffKeys(next.selected, prev.selected);
  if (next.hiding !== prev.hiding) diffKeys(next.hiding, prev.hiding);
  if (next.dragging !== prev.dragging) {
    for (const id of prev.dragging ?? []) ids.add(id);
    for (const id of next.dragging ?? []) ids.add(id);
  }
  if (next.keyboardDrag?.ids !== prev.keyboardDrag?.ids) {
    for (const id of prev.keyboardDrag?.ids ?? []) ids.add(id);
    for (const id of next.keyboardDrag?.ids ?? []) ids.add(id);
  }
  if (next.popover !== prev.popover) {
    add(prev.popover?.rowId);
    add(next.popover?.rowId);
  }
  if (next.editing !== prev.editing) {
    add(prev.editing?.rowId);
    add(next.editing?.rowId);
  }
  if (next.drop !== prev.drop) {
    add(prev.drop?.rowId);
    add(next.drop?.rowId);
  }
  return ids;
}

interface RowListeners {
  byRow: Map<string, Set<() => void>>;
}

const rowListeners = new WeakMap<ListStoreHook, RowListeners>();

function rowListenersOf(store: ListStoreHook): RowListeners {
  let registry = rowListeners.get(store);
  if (!registry) {
    const created: RowListeners = { byRow: new Map() };
    store.subscribe((next, prev) => {
      const ids = changedRowIds(next, prev);
      if (ids === 'all') {
        for (const set of created.byRow.values()) for (const listener of set) listener();
        return;
      }
      for (const id of ids) {
        const set = created.byRow.get(id);
        if (set) for (const listener of set) listener();
      }
    });
    rowListeners.set(store, created);
    registry = created;
  }
  return registry;
}

/**
 * Per-row UI state (selection, editing, drag, popovers, the drop line) for the row `id`.
 * Unlike `useListUi`, a store change runs only the listeners of the rows it touches
 * (`changedRowIds`), so a keypress costs O(changed rows), not O(rows) (AC-11.4, 2,000 rows).
 * `select` must only read the fields `changedRowIds` watches, and return a primitive or a
 * reference taken from the state.
 */
export function useRowUi<T>(id: string, select: (state: ListUiState, id: string) => T): T {
  const store = useContext(ListStoreContext);
  const subscribe = useCallback(
    (listener: () => void) => {
      const { byRow } = rowListenersOf(store);
      let set = byRow.get(id);
      if (!set) {
        set = new Set();
        byRow.set(id, set);
      }
      set.add(listener);
      return () => {
        const current = byRow.get(id);
        current?.delete(listener);
        if (current?.size === 0) byRow.delete(id);
      };
    },
    [store, id],
  );
  return useSyncExternalStore(subscribe, () => select(store.getState(), id));
}

/** The selected row ids in no particular order. */
export function selectedIds(state: Pick<ListUiState, 'selected'>): string[] {
  return Object.keys(state.selected);
}
