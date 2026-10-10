import { uuidv7 } from '@rooster/core/ids';
import { BULK_MAX, DEFAULT_PREFS } from '@rooster/core/limits';
import {
  type ApplyContext,
  ancestorsOf,
  childrenOf,
  depthOf,
  inboxOf,
  inverseOfSequence,
  type ListOpSpec,
  type ListState,
  listOps,
  normalGroups,
  type ReducerContext,
  SUBTASK_DEPTH_MAX,
  subtreeHeight,
  type TaskCreateBody,
  tasksInGroup,
} from '@rooster/core/reducers';
import type { ReminderSpec } from '@rooster/core/reminders';
import type { OrderingIntent, Reminder, Tag, Task, TaskMove } from '@rooster/core/schemas';
import type { SmartView, ViewSection } from '@rooster/core/views';
import type { DroppedOp, ListPipeline } from '../../data/list';
import {
  type Caret,
  type Draft,
  groupIdOfRow,
  groupRowId,
  isGroupRowId,
  type ListStore,
  type ListStoreHook,
  selectedIds,
  useListStore,
} from '../../state/list-store';
import { type UndoEntry, useUndoStore } from '../../state/undo-store';
import { toast } from '../../ui/toast';
import type { ViewerDateContext } from '../dates';
import { resolveAssigneeToken } from '../people/assignee-token';
import { sectionAssignee } from '../people/everyone-model';
import type { Person } from '../people/members';
import { announce } from './announcer';
import { holdsUntilReload } from './hide-delay';
import {
  groupStepTarget,
  isNoopIntent,
  type KeyboardMove,
  keyboardMoveTarget,
} from './model/moves';
import { isNavigable, isTaskRow, type Row, type TaskRow, visibleOrder } from './model/rows';
import { sectionTakesAdds } from './model/view-rows';
import {
  blankSpan,
  type GroupTokenHit,
  type ParsedTitle,
  parseTitle,
  resolveGroupToken,
  type Span,
} from './title-tokens';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 02 §3.6: default hold before a completed row hides (setting arrives with P9 prefs). */
export const completionHoldMs = 1500;
/** `--dur-slow`: the row-height collapse. */
export const completionCollapseMs = 250;

export interface ControllerDeps {
  orgId: string;
  userId: string;
  pipeline: ListPipeline;
  t: Translate;
  rows: () => readonly Row[];
  dateContext: () => ViewerDateContext;
  /**
   * User prefs: title parsing (02 §8.1), the completion hold (02 §3.6) and (P10) the all-day
   * reminder time that relative reminders on all-day tasks resolve against, read live.
   */
  prefs?: () => { parseTitles: boolean; holdMs: number; allDayReminderTime?: string };
  holdMs?: number;
  collapseMs?: number;
  /** The UI store of this list (My tasks: the app-wide one; the pane's subtasks: their own). */
  store?: ListStoreHook;
  /** The org's tags, read live (`#tag` tokens and the tag picker resolve names with them). */
  tags?: () => readonly Tag[];
  /** The detail pane, when this list drives it (02 §6 Esc chain: close the pane). */
  pane?: { isOpen: () => boolean; close: () => void };
  /** The pane's subtask list: rows are the subtasks of this task. */
  rootTaskId?: string;
  /** A smart view (02 §10): the view and the sections on screen, read live. */
  view?: () => ViewModel | null;
  /**
   * Tasks outside My tasks this list shows (Everyone's tasks, a task opened from there), read
   * live: commands, undo and the inverse ops see them as if they were in the list state.
   */
  extraTasks?: () => Readonly<Record<string, Task>> | undefined;
  /**
   * Shared orgs (P6): the members `@name` resolves against and the toasts name. Absent in a
   * personal org, where nothing is assigned (FR-COL-6).
   */
  members?: () => readonly Person[];
}

/**
 * What the controller needs of a smart view: drafts inherit their section's date. In
 * Everyone's tasks (02 §11) the sections are the assignees (`memberSectionId`), and drafts
 * are created for the section's member.
 */
export interface ViewModel {
  view: SmartView | 'everyone';
  sections: readonly ViewSection[];
}

/** A parsed title plus the `>Group` (smart views) and `@name` (new tasks) it names. */
type ParsedLine = ParsedTitle & { groupId?: string; assigneeId?: string };

export interface CommitResult {
  /** The input should show this text again (an emptied existing title). */
  restore?: string;
}

const hideTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
/** Tasks created on this client this session: known to have no description. */
const createdHere = new Set<string>();

function chunk<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BULK_MAX) out.push(items.slice(i, i + BULK_MAX));
  return out;
}

/**
 * Every list command, as plain functions over the pipeline and the UI stores (no React), so
 * the keymap, the rows, the bulk bar and DnD share one implementation and tests can drive it.
 */
export class ListController {
  readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  get orgId(): string {
    return this.deps.orgId;
  }

  private merged: {
    base: ListState;
    extra: Readonly<Record<string, Task>>;
    state: ListState;
  } | null = null;

  /** The list state, plus the tasks of `extraTasks` that are not in it (or deleted from it). */
  state(): ListState | undefined {
    const base = this.deps.pipeline.view(this.deps.orgId);
    const extra = this.deps.extraTasks?.();
    if (!base || !extra) return base;
    const cached = this.merged;
    if (cached && cached.base === base && cached.extra === extra) return cached.state;
    const tasks: Record<string, Task> = {};
    for (const [id, task] of Object.entries(extra)) {
      if (!base.deletedTasks[id]) tasks[id] = task;
    }
    const state = { ...base, tasks: Object.assign(tasks, base.tasks) };
    this.merged = { base, extra, state };
    return state;
  }

  private get t(): Translate {
    return this.deps.t;
  }

  /**
   * What the reducers need (P10 adds the viewer's timezone and all-day reminder time: the
   * completion date of a recurring task and optimistic reminder times).
   */
  reducerContext(): ReducerContext {
    return {
      userId: this.deps.userId,
      timezone: this.deps.dateContext().timezone,
      allDayReminderTime:
        this.deps.prefs?.().allDayReminderTime ?? DEFAULT_PREFS.allDayReminderTime,
    };
  }

  private ctx(): ApplyContext {
    return { ...this.reducerContext(), now: Date.now() };
  }

  private parseTitles(): boolean {
    return this.deps.prefs?.().parseTitles ?? true;
  }

  /** Set for the pane's subtask list: the task whose subtasks are the rows. */
  get rootTaskId(): string | undefined {
    return this.deps.rootTaskId;
  }

  /** The list's UI store. */
  get uiStore(): ListStoreHook {
    return this.deps.store ?? useListStore;
  }

  /** The list's UI state and actions, now. */
  ui(): ListStore {
    return this.uiStore.getState();
  }

  private store() {
    return this.ui();
  }

  task(id: string): Task | undefined {
    return this.state()?.tasks[id];
  }

  // -------------------------------------------------------------------------------------
  // Smart views (02 §10): read-only groupings whose drafts inherit the section's date
  // -------------------------------------------------------------------------------------

  /** The smart view this list shows, or null for My tasks and the pane's subtasks. */
  viewModel(): ViewModel | null {
    return this.deps.view?.() ?? null;
  }

  isView(): boolean {
    return this.viewModel() !== null;
  }

  /** Everyone's tasks (02 §11): sections are assignees, not dates. */
  isEveryone(): boolean {
    return this.viewModel()?.view === 'everyone';
  }

  /** The section to add to: `preferred` when it takes adds, else the first that does. */
  private addSection(preferred?: string): ViewSection | undefined {
    const sections = this.viewModel()?.sections ?? [];
    const wanted = sections.find((s) => s.id === preferred);
    return wanted && sectionTakesAdds(wanted) ? wanted : sections.find(sectionTakesAdds);
  }

  /**
   * A draft in a smart-view section (02 §3.4): it lands in the Inbox with the section's date.
   * Subtask drafts (S) may sit under a parent in any section.
   */
  newSectionDraft(sectionId: string, afterId: string | null, parentId?: string): string | null {
    const sections = this.viewModel()?.sections ?? [];
    const section = parentId
      ? sections.find((s) => s.id === sectionId)
      : this.addSection(sectionId);
    const state = this.state();
    if (!section || !state) return null;
    const draft: Draft = {
      id: uuidv7(),
      groupId: inboxOf(state)?.id ?? '',
      afterId: section.id === sectionId ? afterId : null,
      sectionId: section.id,
      ...(parentId ? { parentId } : {}),
      ...(section.date ? { due: { dueDate: section.date, dueTime: null, dueTz: null } } : {}),
    };
    this.store().addDraft(draft);
    this.store().edit(draft.id, 'end');
    return draft.id;
  }

  /** The row directly above `rowId` within its section (task or draft), or null at the top. */
  private rowAboveInSection(rowId: string): string | null {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.id === rowId);
    const above = rows[index - 1];
    const row = rows[index];
    return above?.kind === 'task' && row?.kind === 'task' && above.sectionId === row.sectionId
      ? above.id
      : null;
  }

  /** `>Group` in a smart-view draft's title (02 §3.4), against the org's groups. */
  private groupToken(raw: string, ignored: readonly Span[]): GroupTokenHit | null {
    const state = this.state();
    return state ? resolveGroupToken(raw, Object.values(state.groups), ignored) : null;
  }

  /**
   * Parses a title; in a smart-view draft a `>Group` token picks the group, and in a new task
   * of a shared org an `@name` token picks the assignee (02 §3.4). Both are removed.
   */
  private parseLine(
    raw: string,
    ignored: readonly Span[],
    groupTokens: boolean,
    assigneeTokens = false,
    /** P10: the task (or draft) has a due date already, so `!1h` tokens apply on their own. */
    hasDue = false,
  ): ParsedLine {
    const ctx = this.deps.dateContext();
    const members = assigneeTokens ? this.deps.members?.() : undefined;
    const who = members ? resolveAssigneeToken(raw, members, this.deps.userId, ignored) : null;
    const text = who ? blankSpan(raw, who) : raw;
    const assignee = who ? { assigneeId: who.userId } : {};
    const hit = groupTokens ? this.groupToken(text, ignored) : null;
    const parse = (line: string) => parseTitle(line, ctx, ignored, this.parseTitles(), hasDue);
    if (hit) {
      const parsed = parse(blankSpan(text, hit));
      if (parsed.title !== '') return { ...parsed, groupId: hit.groupId, ...assignee };
    }
    const parsed = parse(text);
    if (!who) return parsed;
    // A title made only of the token keeps it as text (a task called "@anna" stays that).
    return parsed.title !== '' ? { ...parsed, ...assignee } : parse(raw);
  }

  /** `reminders` for a task create (P10): the title's `!1h` tokens, relative to the due date. */
  private reminderField(offsets: readonly number[] | undefined): {
    reminders?: { offsetMinutes: number }[];
  } {
    return offsets && offsets.length > 0
      ? { reminders: offsets.map((offsetMinutes) => ({ offsetMinutes })) }
      : {};
  }

  // -------------------------------------------------------------------------------------
  // Running ops and undo (02 §3.7)
  // -------------------------------------------------------------------------------------

  /** Applies and queues `specs` as one user operation with one undo entry. */
  run(label: string, specs: ListOpSpec[], options: { toast?: boolean } = {}): UndoEntry | null {
    const before = this.state();
    if (!before || specs.length === 0) return null;
    const inverseOps = inverseOfSequence(specs, before, this.ctx());
    this.deps.pipeline.enqueue(this.orgId, specs, this.reducerContext());
    if (inverseOps.length === 0) return null;
    const entry: UndoEntry = { orgId: this.orgId, label, inverseOps, redoOps: specs };
    useUndoStore.getState().push(entry);
    if (options.toast) {
      toast({
        message: label,
        action: { label: this.t('undo.action'), onAction: () => this.undoEntry(entry) },
      });
    }
    return entry;
  }

  undo(): boolean {
    const entry = useUndoStore.getState().popUndo();
    if (!entry) return false;
    this.applyUndo(entry);
    return true;
  }

  redo(): boolean {
    const entry = useUndoStore.getState().popRedo();
    if (!entry) return false;
    const before = this.deps.pipeline.view(entry.orgId);
    if (!before) return false;
    const inverseOps = inverseOfSequence(entry.redoOps, before, this.ctx());
    this.deps.pipeline.enqueue(entry.orgId, entry.redoOps, this.reducerContext());
    useUndoStore.getState().pushUndoKeepRedo({ ...entry, inverseOps });
    announce(this.t('undo.redone', { label: entry.label }));
    return true;
  }

  /** The toast's Undo: undoes that entry, wherever it is in the stack. */
  undoEntry(entry: UndoEntry): void {
    const store = useUndoStore.getState();
    if (!store.undo.includes(entry)) return;
    useUndoStore.setState({ undo: store.undo.filter((e) => e !== entry) });
    this.applyUndo(entry);
  }

  private applyUndo(entry: UndoEntry): void {
    const before = this.deps.pipeline.view(entry.orgId);
    if (!before) return;
    // Redoing a create must restore, not re-create: recompute redo from the inverse.
    const redoOps = inverseOfSequence(entry.inverseOps, before, this.ctx());
    this.deps.pipeline.enqueue(entry.orgId, entry.inverseOps, this.reducerContext());
    // Stop the running hide timers. Rows held until reload (FR-SET-2) stay while completed.
    for (const id of Object.keys(this.store().hiding)) {
      if (hideTimers.has(id) || this.task(id)?.completedAt == null) this.clearHiding(id);
    }
    useUndoStore.getState().pushRedo({ ...entry, redoOps });
    announce(this.t('undo.undone', { label: entry.label }));
  }

  /** The revert toast for a dropped op (02 §14). */
  describeDropped({ op, error, before }: DroppedOp): string {
    const title = before?.tasks[op.entityId]?.title ?? before?.groups[op.entityId]?.name;
    const reason = this.t(`error.code.${error.code}`, { defaultValue: '' });
    if (title) return this.t('error.couldNotSaveTitle', { title, reason: reason || error.code });
    return this.t('error.couldNotSave', { reason: reason || error.code });
  }

  // -------------------------------------------------------------------------------------
  // Rows and selection
  // -------------------------------------------------------------------------------------

  rows(): readonly Row[] {
    return this.deps.rows();
  }

  private navigable(): Row[] {
    return this.rows().filter(isNavigable);
  }

  /** Selected rows in list order. */
  selection(): Row[] {
    const selected = this.store().selected;
    return this.rows().filter((r) => selected[r.id]);
  }

  /** Selected persisted task ids in list order (the cursor when nothing is selected). */
  selectedTaskIds(): string[] {
    const ids = this.selection()
      .filter(isTaskRow)
      .map((r) => r.id);
    if (ids.length > 0) return ids;
    const cursor = this.store().cursor;
    return cursor && this.task(cursor) ? [cursor] : [];
  }

  cursorRow(): Row | undefined {
    const cursor = this.store().cursor;
    return cursor ? this.rows().find((r) => r.id === cursor) : undefined;
  }

  select(rowId: string | null): void {
    this.store().select(rowId);
  }

  /** ↑/↓ (and K/J): moves the selection through headers and tasks. */
  step(delta: 1 | -1): void {
    const rows = this.navigable();
    if (rows.length === 0) return;
    const cursor = this.store().cursor;
    const index = rows.findIndex((r) => r.id === cursor);
    const next =
      index < 0
        ? delta === 1
          ? rows[0]
          : rows.at(-1)
        : rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
    if (next) this.store().select(next.id);
  }

  /** Shift+↑/↓: extends the selection from the anchor (tasks only). */
  extend(delta: 1 | -1): void {
    const rows = this.navigable();
    const { cursor, anchor } = this.store();
    const index = rows.findIndex((r) => r.id === cursor);
    const next = rows[index + delta];
    if (index < 0 || !next) return;
    this.selectRange(anchor ?? cursor ?? next.id, next.id);
  }

  /** Shift+click and Shift+↑/↓: tasks between the anchor and `to`. */
  selectRange(from: string, to: string): void {
    const rows = this.navigable();
    const a = rows.findIndex((r) => r.id === from);
    const b = rows.findIndex((r) => r.id === to);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const ids = rows
      .slice(lo, hi + 1)
      .filter((r) => r.kind === 'task')
      .map((r) => r.id);
    this.store().selectRange(ids.length > 0 ? ids : [to], to);
    this.uiStore.setState({ anchor: from });
    this.announceSelection();
  }

  toggleInSelection(rowId: string): void {
    if (isGroupRowId(rowId)) return;
    this.store().toggleSelected(rowId);
    this.announceSelection();
  }

  /** Ctrl+A: the cursor's group, then every task in the view. */
  selectAll(): void {
    const rows = this.rows().filter(isTaskRow);
    const cursorRow = this.cursorRow();
    // A smart view's sections stand in for groups.
    const groupId =
      cursorRow?.kind === 'task'
        ? (cursorRow.sectionId ?? cursorRow.groupId)
        : cursorRow?.kind === 'group'
          ? cursorRow.group.id
          : undefined;
    const inGroup = rows.filter((r) => (r.sectionId ?? r.groupId) === groupId).map((r) => r.id);
    const selected = selectedIds(this.store());
    const all = rows.map((r) => r.id);
    const groupDone = inGroup.length > 0 && inGroup.every((id) => selected.includes(id));
    const ids = groupDone || inGroup.length === 0 ? all : inGroup;
    if (ids.length === 0) return;
    this.store().selectRange(ids, this.store().cursor ?? (ids[0] as string));
    this.announceSelection();
  }

  private announceSelection(): void {
    const count = selectedIds(this.store()).length;
    if (count > 1) announce(this.t('bulk.selected', { count }));
  }

  /** Esc in Navigate: close a popover, then shrink the selection, then clear it. */
  escape(): boolean {
    const store = this.store();
    if (store.popover) {
      store.set({ popover: null });
      return true;
    }
    if (store.selectionMode) {
      this.exitSelectionMode();
      return true;
    }
    const count = selectedIds(store).length;
    if (count > 1 && store.cursor) {
      store.select(store.cursor);
      return true;
    }
    if (this.deps.pane?.isOpen()) {
      this.deps.pane.close();
      return true;
    }
    if (count === 1) {
      store.set({ selected: {}, anchor: null });
      return true;
    }
    return false;
  }

  /** Phones (02 §13.2): a long-press without a move selects the row in selection mode. */
  enterSelectionMode(rowId: string): void {
    const store = this.store();
    if (store.editing) store.set({ editing: null, mode: 'navigate' });
    store.set({
      selectionMode: true,
      selected: { [rowId]: true },
      cursor: rowId,
      anchor: rowId,
      popover: null,
    });
    announce(this.t('bulk.selected', { count: 1 }));
  }

  /** A tap in selection mode: toggles the row; the count is announced (02 §15). */
  toggleSelectionMode(rowId: string): void {
    const store = this.store();
    store.toggleSelected(rowId);
    const count = selectedIds(this.store()).length;
    if (count === 0) this.exitSelectionMode();
    announce(this.t('bulk.selected', { count }));
  }

  exitSelectionMode(): void {
    this.store().set({ selectionMode: false, selected: {}, anchor: null, popover: null });
  }

  selectEdge(edge: 'first' | 'last'): void {
    const rows = this.navigable();
    const row = edge === 'first' ? rows[0] : rows.at(-1);
    if (row) this.store().select(row.id);
  }

  // -------------------------------------------------------------------------------------
  // Drafts and title editing (02 §3.4–3.5)
  // -------------------------------------------------------------------------------------

  private draftTask(id: string): boolean {
    return this.store().drafts.some((d) => d.id === id);
  }

  /** Creates a draft row and puts the caret in it (a subtask draft with `parentId`). */
  newDraft(groupId: string, afterId: string | null, parentId?: string | null): string {
    const draft: Draft = {
      id: uuidv7(),
      groupId,
      afterId,
      ...(parentId ? { parentId } : {}),
    };
    this.store().addDraft(draft);
    this.store().edit(draft.id, 'end');
    return draft.id;
  }

  /**
   * The rows on the same level as `rowId` (its group's top-level rows, or its siblings under
   * the same parent) directly before and after it, drafts included.
   */
  private siblingRows(rowId: string): { before: TaskRow | null; after: TaskRow | null } {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.id === rowId);
    const row = rows[index];
    if (row?.kind !== 'task') return { before: null, after: null };
    const scan = (step: 1 | -1): TaskRow | null => {
      for (let i = index + step; i >= 0 && i < rows.length; i += step) {
        const r = rows[i] as Row;
        if (r.kind === 'group') return null;
        if (r.kind === 'task' && r.level === row.level) {
          return r.parentId === row.parentId ? r : null;
        }
        if ((r.kind === 'task' || r.kind === 'addSubtask') && r.level < row.level) return null;
      }
      return null;
    };
    return { before: scan(-1), after: scan(1) };
  }

  /** The row above `rowId` among its siblings (task or draft), or null at the top. */
  private rowAboveInGroup(rowId: string): string | null {
    return this.siblingRows(rowId).before?.id ?? null;
  }

  /** N / Enter: new row below the cursor (a sibling subtask under a subtask). */
  newBelow(rowId?: string | null): void {
    const row = rowId ? this.rows().find((r) => r.id === rowId) : this.cursorRow();
    if (this.isView()) {
      if (row?.kind === 'task' && row.sectionId) this.newSectionDraft(row.sectionId, row.id);
      else if (row?.kind === 'section') this.newSectionDraft(row.sectionId, null);
      else this.quickAdd();
      return;
    }
    if (row?.kind === 'task') this.newDraft(row.groupId, row.id, row.parentId);
    else if (row?.kind === 'group') this.newDraft(row.group.id, null);
    else this.quickAdd();
  }

  /** Shift+N / Shift+Enter: new row above. */
  newAbove(rowId?: string | null): void {
    const row = rowId ? this.rows().find((r) => r.id === rowId) : this.cursorRow();
    if (this.isView()) {
      if (row?.kind === 'task' && row.sectionId) {
        this.newSectionDraft(row.sectionId, this.rowAboveInSection(row.id));
      } else if (row?.kind === 'section') this.newSectionDraft(row.sectionId, null);
      else this.quickAdd();
      return;
    }
    if (row?.kind === 'task') {
      this.newDraft(row.groupId, this.rowAboveInGroup(row.id), row.parentId);
    } else if (row?.kind === 'group') this.newDraft(row.group.id, null);
    else this.quickAdd();
  }

  /** The accessory bar's group picker (02 §13.3): the draft moves to the top of `groupId`. */
  moveDraftToGroup(draftId: string, groupId: string): void {
    // A smart view's draft keeps its row; only the group it will land in changes.
    if (this.store().drafts.find((d) => d.id === draftId)?.sectionId) {
      this.store().updateDraft(draftId, { groupId });
      return;
    }
    const state = this.state();
    const group = state?.groups[groupId];
    if (group?.collapsed) this.run('', [listOps.patchGroup(groupId, { collapsed: false })]);
    this.store().updateDraft(draftId, { groupId, afterId: null });
  }

  /** The accessory bar's date button: a due date for the draft, applied when it is created. */
  setDraftDue(draftId: string, due: Draft['due'] | null): void {
    this.store().updateDraft(draftId, due ? { due } : { due: undefined });
  }

  /** "+ Add task": a draft at the end of the group (or of a smart view's section). */
  addAtEnd(groupId: string, sectionId?: string): void {
    if (sectionId) {
      const last = this.rows()
        .filter((r): r is TaskRow => r.kind === 'task' && r.sectionId === sectionId)
        .at(-1);
      this.newSectionDraft(sectionId, last?.id ?? null);
      return;
    }
    const last = this.rows()
      .filter((r): r is TaskRow => r.kind === 'task' && r.groupId === groupId)
      .at(-1);
    this.newDraft(groupId, last?.id ?? null);
  }

  /**
   * Q / Tab+Q: top of the first visible group, Inbox excluded (02 §3.4); in a smart view, the
   * top of the cursor's section (02 §13.3), or of the first one that takes adds.
   */
  quickAdd(): void {
    const state = this.state();
    if (!state) return;
    if (this.isView()) {
      const cursor = this.cursorRow();
      const sectionId =
        cursor?.kind === 'task' || cursor?.kind === 'section' ? cursor.sectionId : undefined;
      const section = this.addSection(sectionId);
      if (section) this.newSectionDraft(section.id, null);
      return;
    }
    const root = this.deps.rootTaskId;
    if (root) {
      this.addSubtask(root);
      return;
    }
    const first = normalGroups(state)[0];
    if (!first) return;
    if (first.collapsed) this.run('', [listOps.patchGroup(first.id, { collapsed: false })]);
    this.newDraft(first.id, null);
  }

  /**
   * Commits a title (Enter, Esc, blur, ↑/↓). Drafts become tasks only when non-empty; an
   * emptied existing title is restored.
   */
  commitTitle(rowId: string, raw: string, ignored: readonly Span[] = []): CommitResult {
    const draft = this.store().drafts.find((d) => d.id === rowId);
    const parsed = this.parseLine(
      raw,
      ignored,
      Boolean(draft?.sectionId && !draft.parentId && !this.isEveryone()),
      Boolean(draft),
      this.hasDueFor(rowId),
    );
    if (draft) {
      if (parsed.title === '') return {};
      this.createFromDraft(draft, [parsed]);
      return {};
    }
    const task = this.task(rowId);
    if (!task) return {};
    if (parsed.title === '') return { restore: task.title };
    const due = parsed.due;
    const dueChanged =
      due !== undefined &&
      (due.dueDate !== task.dueDate ||
        due.dueTime !== task.dueTime ||
        due.dueTz !== task.dueTz ||
        (due.recurrence !== undefined &&
          (due.recurrence !== task.recurrence ||
            // "every day after done" on a daily task: the same rule, another basis.
            (due.recurrenceBasis !== undefined && due.recurrenceBasis !== task.recurrenceBasis))));
    const patch = {
      ...(parsed.title === task.title ? {} : { title: parsed.title }),
      ...(dueChanged ? { ...due, startDate: null } : {}),
    };
    const specs: ListOpSpec[] = [];
    if (Object.keys(patch).length > 0) specs.push(listOps.patchTask(rowId, patch));
    specs.push(...this.tagSpecs([rowId], parsed.tags ?? []));
    // P10: `!1h` on an existing task adds the viewer's reminders (after the date, if any).
    for (const offsetMinutes of parsed.reminders ?? []) {
      specs.push(listOps.createReminder(rowId, uuidv7(), { offsetMinutes }));
    }
    if (specs.length > 0) this.run(this.t('undo.edited'), specs);
    return {};
  }

  /** Whether a row's task or draft already has a due date (P10: `!1h` needs one). */
  hasDueFor(rowId: string): boolean {
    const draft = this.store().drafts.find((d) => d.id === rowId);
    if (draft) return Boolean(draft.due?.dueDate);
    return Boolean(this.task(rowId)?.dueDate);
  }

  /** Splits `#tag` names into existing org tags and new names (case-insensitive). */
  resolveTags(names: readonly string[]): { ids: string[]; newNames: string[] } {
    const tags = this.deps.tags?.() ?? [];
    const ids: string[] = [];
    const newNames: string[] = [];
    for (const name of names) {
      const tag = tags.find((t) => t.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (tag) {
        if (!ids.includes(tag.id)) ids.push(tag.id);
      } else newNames.push(name);
    }
    return { ids, newNames };
  }

  /** Ops that add the named tags to existing tasks, creating unknown tags first. */
  private tagSpecs(taskIds: readonly string[], names: readonly string[]): ListOpSpec[] {
    if (names.length === 0) return [];
    const { ids, newNames } = this.resolveTags(names);
    const specs: ListOpSpec[] = [];
    for (const name of newNames) {
      const id = uuidv7();
      specs.push(listOps.createTag({ id, name }));
      ids.push(id);
    }
    for (const tagId of ids) {
      for (const taskId of taskIds) {
        if (!this.task(taskId)?.tagIds.includes(tagId)) specs.push(listOps.addTag(taskId, tagId));
      }
    }
    return specs;
  }

  /** The nearest persisted sibling of a draft on each side (drafts are skipped). */
  private persistedNeighbours(draftId: string): {
    afterId: string | null;
    beforeId: string | null;
  } {
    const find = (from: string, side: 'before' | 'after'): string | null => {
      let row = this.siblingRows(from)[side];
      while (row?.draft) row = this.siblingRows(row.id)[side];
      return row?.id ?? null;
    };
    return { afterId: find(draftId, 'before'), beforeId: find(draftId, 'after') };
  }

  private createFromDraft(draft: Draft, parsed: readonly ParsedLine[]): void {
    if (draft.sectionId) {
      this.createFromSectionDraft(draft, parsed);
      return;
    }
    const neighbours = this.persistedNeighbours(draft.id);
    let afterId = neighbours.afterId;
    const beforeId = neighbours.beforeId;
    const specs: ListOpSpec[] = [];
    parsed.forEach((p, i) => {
      const id = i === 0 ? draft.id : uuidv7();
      createdHere.add(id);
      const { ids: tagIds, newNames } = this.resolveTags(p.tags ?? []);
      specs.push(
        listOps.createTask({
          id,
          title: p.title,
          ...(draft.parentId ? { parentId: draft.parentId } : { groupId: draft.groupId }),
          afterId,
          beforeId,
          // A date picked in the accessory bar applies unless the title names one.
          ...(p.due ?? (i === 0 && draft.due ? draft.due : {})),
          ...(tagIds.length > 0 ? { tagIds } : {}),
          ...(newNames.length > 0 ? { tagNames: newNames } : {}),
          ...this.assigneeField(p.assigneeId),
          ...this.reminderField(p.reminders),
        }),
      );
      // A task for someone else lands in their Inbox, not here: the next one follows mine.
      if (!this.forSomeoneElse(p.assigneeId)) afterId = id;
    });
    this.store().removeDraft(draft.id);
    const label = this.createdLabel(parsed);
    this.run(label, specs, { toast: this.createdElsewhere(parsed) });
  }

  /** `assigneeId` for a create body: only another member (the server defaults to me). */
  private assigneeField(assigneeId: string | null | undefined): { assigneeId?: string | null } {
    return assigneeId === undefined || assigneeId === this.deps.userId ? {} : { assigneeId };
  }

  private forSomeoneElse(assigneeId: string | null | undefined): boolean {
    return assigneeId !== undefined && assigneeId !== this.deps.userId;
  }

  private memberName(userId: string): string {
    return this.deps.members?.().find((m) => m.userId === userId)?.name ?? this.t('assign.someone');
  }

  /** Tasks created for someone else (or unassigned) get a toast saying where they went. */
  private createdElsewhere(parsed: readonly ParsedLine[]): boolean {
    return parsed.some((p) => this.forSomeoneElse(p.assigneeId));
  }

  /** "Added to Anna's Inbox" when every new task went to one other member (02 §11). */
  private createdLabel(parsed: readonly ParsedLine[]): string {
    const others = new Set(parsed.map((p) => p.assigneeId));
    const only = others.size === 1 ? [...others][0] : undefined;
    if (only === null) return this.t('assign.createdUnassigned', { count: parsed.length });
    if (only !== undefined && only !== this.deps.userId) {
      return this.t('assign.createdFor', { count: parsed.length, name: this.memberName(only) });
    }
    return parsed.length === 1
      ? this.t('undo.created')
      : this.t('undo.createdMany', { count: parsed.length });
  }

  /**
   * A smart-view draft becomes a task (02 §3.4): in the Inbox (or the `>Group` / accessory-bar
   * group) with the section's date unless the title names one. It goes to the top of that
   * group, or right after the draft's predecessor when that is in the same group, so a run of
   * Enter keeps its order.
   */
  private createFromSectionDraft(draft: Draft, parsed: readonly ParsedLine[]): void {
    const state = this.state();
    if (!state) return;
    const specs: ListOpSpec[] = [];
    let previous = draft.afterId;
    // Everyone's tasks (02 §11): a draft under a member is created for that member.
    const sectionMember = draft.parentId ? undefined : sectionAssignee(draft.sectionId);
    const lines = parsed.map((p) =>
      p.assigneeId === undefined && sectionMember !== undefined
        ? { ...p, assigneeId: sectionMember as string }
        : p,
    );
    lines.forEach((p, i) => {
      const id = i === 0 ? draft.id : uuidv7();
      createdHere.add(id);
      const { ids: tagIds, newNames } = this.resolveTags(p.tags ?? []);
      const groupId = p.groupId ?? draft.groupId;
      let where: Partial<TaskCreateBody>;
      if (draft.parentId) {
        where = { parentId: draft.parentId };
      } else if (this.forSomeoneElse(p.assigneeId)) {
        // The server puts it at the top of their Inbox (or nowhere, unassigned).
        where = this.assigneeField(p.assigneeId);
      } else {
        const inGroup = tasksInGroup(state, groupId);
        const anchor = inGroup.findIndex((t) => t.id === previous);
        where = {
          groupId,
          afterId: anchor >= 0 ? (previous as string) : null,
          beforeId: inGroup[anchor + 1]?.id ?? null,
        };
      }
      specs.push(
        listOps.createTask({
          id,
          title: p.title,
          ...where,
          ...(p.due ?? draft.due ?? {}),
          ...(tagIds.length > 0 ? { tagIds } : {}),
          ...(newNames.length > 0 ? { tagNames: newNames } : {}),
          ...this.reminderField(p.reminders),
        }),
      );
      previous = id;
    });
    this.store().removeDraft(draft.id);
    const label = this.createdLabel(lines);
    this.run(label, specs, { toast: this.createdElsewhere(lines) });
  }

  /** Enter / Shift+Enter in Edit. */
  enter(rowId: string, raw: string, ignored: readonly Span[], above: boolean): CommitResult {
    const isDraft = this.draftTask(rowId);
    if (raw.trim() === '') {
      if (isDraft) return {};
      const task = this.task(rowId);
      toast({ message: this.t('hint.emptyTitle') });
      return task ? { restore: task.title } : {};
    }
    const draft = this.store().drafts.find((d) => d.id === rowId);
    const row = this.rows().find((r) => r.id === rowId);
    const sectionId = row?.kind === 'task' ? row.sectionId : draft?.sectionId;
    if (sectionId) {
      // Smart views: the next draft goes into the same section, if it takes adds.
      const aboveSection = above ? this.rowAboveInSection(rowId) : null;
      const result = this.commitTitle(rowId, raw, ignored);
      const section = this.viewModel()?.sections.find((s) => s.id === sectionId);
      if (section && sectionTakesAdds(section)) {
        this.newSectionDraft(sectionId, above ? aboveSection : rowId);
      } else {
        this.store().navigate(rowId);
      }
      return result;
    }
    const aboveId = above ? this.rowAboveInGroup(rowId) : null;
    const result = this.commitTitle(rowId, raw, ignored);
    const groupId = row?.kind === 'task' ? row.groupId : draft?.groupId;
    if (!groupId) return result;
    // 02 §3.4: Enter in a subtask creates a sibling subtask.
    const parentId = row?.kind === 'task' ? row.parentId : (draft?.parentId ?? null);
    if (above) this.newDraft(groupId, aboveId, parentId);
    else this.newDraft(groupId, rowId, parentId);
    return result;
  }

  /** Esc in Edit: commit and go to Navigate (an empty draft disappears). */
  escapeEdit(rowId: string, raw: string, ignored: readonly Span[]): CommitResult {
    const result = this.commitTitle(rowId, raw, ignored);
    if (this.draftTask(rowId)) {
      const previous = this.previousTaskRow(rowId);
      this.store().removeDraft(rowId);
      this.store().navigate(previous?.id ?? null);
      return result;
    }
    this.store().navigate(rowId);
    return result;
  }

  /** Blur: commit; an empty draft that loses focus disappears silently. */
  blurEdit(rowId: string, raw: string, ignored: readonly Span[]): CommitResult {
    const result = this.commitTitle(rowId, raw, ignored);
    if (this.draftTask(rowId)) this.store().removeDraft(rowId);
    const store = this.store();
    if (store.editing?.rowId === rowId) store.set({ editing: null, mode: 'navigate' });
    return result;
  }

  private previousTaskRow(rowId: string): TaskRow | undefined {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.id === rowId);
    return rows
      .slice(0, Math.max(0, index))
      .reverse()
      .find((r): r is TaskRow => r.kind === 'task');
  }

  private nextTaskRow(rowId: string): TaskRow | undefined {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.id === rowId);
    return rows.slice(index + 1).find((r): r is TaskRow => r.kind === 'task');
  }

  /** ↑/↓ in Edit: commit and move the caret to the adjacent task row. */
  caretMove(
    rowId: string,
    raw: string,
    ignored: readonly Span[],
    delta: 1 | -1,
    caret: Caret,
  ): CommitResult {
    const target = delta === -1 ? this.previousTaskRow(rowId) : this.nextTaskRow(rowId);
    if (!target) return {};
    const result = this.commitTitle(rowId, raw, ignored);
    if (this.draftTask(rowId)) this.store().removeDraft(rowId);
    this.store().edit(target.id, caret);
    return result;
  }

  /** Content that Backspace must not destroy (02 §3.5). */
  hasContent(task: Task): boolean {
    const { subtasks, comments, attachments } = task.counts;
    if (subtasks > 0 || comments > 0 || attachments > 0) return true;
    // List payloads omit the description but carry `hasDescription`. A cache persisted before
    // that field existed lacks it; then only tasks created here are known to have none.
    if (task.description === undefined) {
      return typeof task.hasDescription === 'boolean'
        ? task.hasDescription
        : !createdHere.has(task.id);
    }
    return task.description.trim() !== '';
  }

  /**
   * Backspace in an already-empty title. Auto-repeat never deletes a row (AC-2.6). Returns
   * true when it handled the key.
   */
  backspaceEmpty(rowId: string, repeat: boolean): boolean {
    if (repeat) return true;
    const previous = this.previousTaskRow(rowId);
    const focusPrevious = () => {
      if (previous) this.store().edit(previous.id, 'end');
      else this.store().navigate(null);
    };
    if (this.draftTask(rowId)) {
      this.store().removeDraft(rowId);
      focusPrevious();
      return true;
    }
    const task = this.task(rowId);
    if (!task) return false;
    if (this.hasContent(task)) {
      toast({ message: this.t('hint.useTabDelete') });
      return true;
    }
    this.run(this.t('undo.deleted'), [listOps.deleteTask(rowId)], { toast: true });
    focusPrevious();
    return true;
  }

  /** "Create 5 tasks? ↵" (02 §3.4): one task per non-empty line, from the draft's slot. */
  createMany(rowId: string, lines: readonly string[]): void {
    let draft = this.store().drafts.find((d) => d.id === rowId);
    const row = this.rows().find((r) => r.id === rowId);
    const inView = Boolean(draft?.sectionId ?? (row?.kind === 'task' && row.sectionId));
    const parsed = lines
      .map((line) =>
        this.parseLine(line, [], inView && !draft?.parentId && !this.isEveryone(), true),
      )
      .filter((p) => p.title !== '');
    if (parsed.length === 0) return;
    if (!draft && row?.kind === 'task' && row.sectionId) {
      const id = this.newSectionDraft(row.sectionId, row.id);
      draft = this.store().drafts.find((d) => d.id === id);
      if (!draft) return;
    }
    if (!draft) {
      if (row?.kind !== 'task') return;
      draft = {
        id: uuidv7(),
        groupId: row.groupId,
        afterId: row.id,
        ...(row.parentId ? { parentId: row.parentId } : {}),
      };
      this.store().addDraft(draft);
    }
    this.createFromDraft(draft, parsed);
    this.store().navigate(draft.id);
  }

  // -------------------------------------------------------------------------------------
  // Assigning (FR-COL-1, FR-COL-2)
  // -------------------------------------------------------------------------------------

  /**
   * Tab+A / A, the picker, the bulk bar and a reassign drag: one patch for one task, the bulk
   * op for several, with undo. Tasks that already have `assigneeId` are skipped; returns
   * whether anything changed. Rows that leave this list hand the selection on, as a delete does.
   */
  assign(ids: readonly string[], assigneeId: string | null): boolean {
    const live = ids.filter((id) => {
      const task = this.task(id);
      return task !== undefined && task.assigneeId !== assigneeId;
    });
    if (live.length === 0) return false;
    const rows = this.rows();
    // My tasks and the smart views list my tasks only; a subtask row under its parent stays.
    const leaving =
      this.isEveryone() || assigneeId === this.deps.userId
        ? []
        : live.filter((id) => {
            const row = rows.find((r) => r.id === id);
            return row?.kind === 'task' && row.parentId === null;
          });
    const cursor = this.store().cursor;
    const next = cursor && leaving.includes(cursor) ? this.nextNavigableAfter(leaving) : undefined;
    const specs =
      live.length === 1
        ? [listOps.patchTask(live[0] as string, { assigneeId })]
        : chunk(live).map((part) =>
            listOps.bulk(this.orgId, { op: 'assign', ids: part, args: { assigneeId } }),
          );
    this.run(this.assignedLabel(live.length, assigneeId), specs, { toast: true });
    if (next !== undefined) this.store().select(next);
    return true;
  }

  /** "Assigned to Anna · moved to their Inbox" (02 §11), "Assigned to you", "Unassigned". */
  private assignedLabel(count: number, assigneeId: string | null): string {
    if (assigneeId === null) return this.t('assign.unassigned', { count });
    if (assigneeId === this.deps.userId) return this.t('assign.toMe', { count });
    return this.t('assign.toOther', { count, name: this.memberName(assigneeId) });
  }

  // -------------------------------------------------------------------------------------
  // Completing and deleting
  // -------------------------------------------------------------------------------------

  /** Checkbox / Ctrl+Enter: completes (or, in the hold window, un-completes). */
  toggleComplete(
    ids: readonly string[] = this.selectedTaskIds(),
    options: { immediate?: boolean } = {},
  ): void {
    const tasks = ids.map((id) => this.task(id)).filter((t): t is Task => t !== undefined);
    if (tasks.length === 0) return;
    const complete = tasks.some((t) => t.completedAt === null);
    const targets = tasks.filter((t) => (t.completedAt === null) === complete).map((t) => t.id);
    const first = tasks[0] as Task;
    const label = complete
      ? targets.length === 1
        ? this.t('undo.completed', { title: first.title })
        : this.t('undo.completedMany', { count: targets.length })
      : this.t('undo.reopened', { count: targets.length });
    // P10 (ADR 0049 §1.6): a recurring task completes on its own, naming its next instance,
    // so the next one shows at once and the undo can remove it again.
    const repeating = complete
      ? targets.filter((id) => this.task(id)?.recurrence && this.task(id)?.dueDate)
      : [];
    const rest = targets.filter((id) => !repeating.includes(id));
    const specs = [
      ...repeating.map((id) => listOps.completeTask(id, true, uuidv7())),
      ...(rest.length === 1
        ? [listOps.completeTask(rest[0] as string, complete)]
        : chunk(rest).map((part) =>
            listOps.bulk(this.orgId, { op: complete ? 'complete' : 'uncomplete', ids: part }),
          )),
    ];
    for (const id of targets) {
      if (complete) this.startHiding(id, options.immediate ? 0 : undefined);
      else this.clearHiding(id);
    }
    const subtasksOpen = complete
      ? tasks.reduce((n, t) => n + (t.counts.subtasks - t.counts.subtasksDone), 0)
      : 0;
    const entry = this.run(label, specs);
    if (complete && entry) {
      const extra =
        subtasksOpen > 0 ? ` · ${this.t('undo.openSubtasks', { count: subtasksOpen })}` : '';
      toast({
        message: `${label}${extra}`,
        action: { label: this.t('undo.action'), onAction: () => this.undoEntry(entry) },
      });
    }
  }

  /**
   * `holdMs` 0: a swipe already showed the completion, so the row collapses at once, unless
   * the user keeps completed rows until reload.
   */
  private startHiding(id: string, holdMs?: number): void {
    if (this.store().showCompleted) return;
    this.clearHiding(id);
    const preferred = this.deps.prefs?.().holdMs ?? this.deps.holdMs ?? completionHoldMs;
    const hold = holdMs ?? preferred;
    const collapse = this.deps.collapseMs ?? completionCollapseMs;
    this.store().setHiding(id, 'hold');
    // FR-SET-2 "Until reload" (swipes too): no timers; leaving the list or reloading drops it.
    if (holdsUntilReload(preferred)) return;
    const timers = [
      setTimeout(() => this.store().setHiding(id, 'collapsing'), hold),
      setTimeout(() => {
        hideTimers.delete(id);
        const store = this.store();
        if (store.cursor === id && store.mode === 'navigate') {
          const next = this.nextNavigable(id);
          store.setHiding(id, null);
          store.select(next ?? null);
        } else {
          store.setHiding(id, null);
        }
      }, hold + collapse),
    ];
    hideTimers.set(id, timers);
  }

  private clearHiding(id: string): void {
    for (const timer of hideTimers.get(id) ?? []) clearTimeout(timer);
    hideTimers.delete(id);
    if (this.store().hiding[id]) this.store().setHiding(id, null);
  }

  private nextNavigable(id: string): string | null {
    const rows = this.navigable();
    const index = rows.findIndex((r) => r.id === id);
    return rows[index + 1]?.id ?? rows[index - 1]?.id ?? null;
  }

  /**
   * Tab+Delete, Delete in Navigate, the bulk bar: soft delete with undo. One recurring task
   * asks first (FR-REC-4): `deleteRecurring` answers. Bulk delete is always plain.
   */
  deleteTasks(ids: readonly string[] = this.selectedTaskIds()): void {
    const live = ids.filter((id) => this.task(id));
    if (live.length === 0) return;
    if (live.length === 1 && this.isRecurring(live[0] as string)) {
      this.store().set({ popover: { kind: 'recurringDelete', rowId: live[0] as string } });
      return;
    }
    this.deleteNow(live);
  }

  /** A task with a repeat rule (FR-REC): deleting it asks "this / this and following". */
  isRecurring(id: string): boolean {
    const task = this.task(id);
    return Boolean(task?.recurrence && task.dueDate && task.completedAt === null);
  }

  /**
   * The answer to the recurring delete question (ADR 0049 §1.7): "this" skips the occurrence
   * (to Trash, the next instance follows; undo restores it and removes the next one), and
   * "following" is the plain delete, which ends the series.
   */
  deleteRecurring(id: string, choice: 'this' | 'following'): void {
    this.store().set({ popover: null });
    if (!this.task(id)) return;
    if (choice === 'following') {
      this.deleteNow([id], this.t('undo.seriesDeleted'));
      return;
    }
    const next = this.nextNavigableAfter([id]);
    this.run(this.t('undo.skipped'), [listOps.skipTask(id, uuidv7())], { toast: true });
    this.store().select(next);
  }

  private deleteNow(live: readonly string[], message?: string): void {
    const next = this.nextNavigableAfter(live);
    const specs =
      live.length === 1
        ? [listOps.deleteTask(live[0] as string)]
        : chunk(live).map((part) => listOps.bulk(this.orgId, { op: 'delete', ids: part }));
    const label =
      message ??
      (live.length === 1
        ? this.t('undo.deleted')
        : this.t('undo.deletedMany', { count: live.length }));
    this.run(label, specs, { toast: true });
    this.store().select(next);
  }

  private nextNavigableAfter(ids: readonly string[]): string | null {
    const gone = new Set(ids);
    const rows = this.navigable();
    const lastIndex = Math.max(...ids.map((id) => rows.findIndex((r) => r.id === id)));
    const after = rows.slice(lastIndex + 1).find((r) => !gone.has(r.id));
    const before = rows
      .slice(0, lastIndex)
      .reverse()
      .find((r) => !gone.has(r.id));
    return (after ?? before)?.id ?? null;
  }

  /** Due change from the date cell, the picker or the bulk bar. */
  setDue(
    ids: readonly string[],
    due: {
      dueDate: string | null;
      dueTime: string | null;
      dueTz: string | null;
      startDate?: string | null | undefined;
      recurrence?: string | null | undefined;
      recurrenceBasis?: 'due' | 'completion' | null | undefined;
    } | null,
  ): void {
    const value = {
      dueDate: due?.dueDate ?? null,
      dueTime: due?.dueTime ?? null,
      dueTz: due?.dueTz ?? null,
      startDate: due?.startDate ?? null,
      // P10: left out, the series is kept; clearing the date ends it (ADR 0049 §1.8).
      ...(due?.dueDate && due.recurrence !== undefined
        ? {
            recurrence: due.recurrence,
            recurrenceBasis: due.recurrence ? (due.recurrenceBasis ?? 'due') : null,
          }
        : {}),
    };
    const live = ids.filter((id) => this.task(id));
    if (live.length === 0) return;
    const specs =
      live.length === 1
        ? [listOps.patchTask(live[0] as string, value)]
        : chunk(live).map((part) =>
            listOps.bulk(this.orgId, { op: 'setDue', ids: part, args: value }),
          );
    // ADR 0049 §2.2: relative reminders go dormant with the date; the undo revives them.
    const paused = due === null && live.some((id) => this.task(id)?.nextReminderAt);
    const label = due
      ? this.t('undo.dated')
      : paused
        ? this.t('undo.dateClearedReminders')
        : this.t('undo.dateCleared');
    this.run(label, specs, { toast: due === null });
  }

  // -------------------------------------------------------------------------------------
  // Reminders (FR-REM, ADR 0049 §2.7): personal, through the outbox
  // -------------------------------------------------------------------------------------

  /** Adds one of the viewer's reminders; the bell and the chips show it at once. */
  addReminder(taskId: string, spec: ReminderSpec): void {
    this.run(this.t('undo.reminderAdded'), [listOps.createReminder(taskId, uuidv7(), spec)]);
  }

  /** Removes one of the viewer's reminders (undo re-creates it with the same id). */
  removeReminder(taskId: string, reminder: Reminder): void {
    const restore =
      reminder.kind === 'relative' && reminder.offsetMinutes !== null
        ? { offsetMinutes: reminder.offsetMinutes }
        : reminder.remindAt !== null
          ? { at: reminder.remindAt }
          : undefined;
    this.run(this.t('undo.reminderRemoved'), [
      listOps.deleteReminder(taskId, reminder.id, restore),
    ]);
  }

  // -------------------------------------------------------------------------------------
  // Moving (02 §5)
  // -------------------------------------------------------------------------------------

  /**
   * Moves tasks to an intent; one op for one task, bulk for several. A move that leaves them
   * where they are sends nothing and records no undo step (02 §5); returns whether it moved.
   */
  moveTasks(ids: readonly string[], target: TaskMove, announceMove = true): boolean {
    const live = ids.filter((id) => this.task(id));
    if (live.length === 0) return false;
    const state = this.state();
    if (
      state &&
      isNoopIntent(
        tasksInGroup(state, target.groupId).map((t) => t.id),
        live,
        target,
      )
    ) {
      return false;
    }
    const specs =
      live.length === 1
        ? [listOps.moveTask(live[0] as string, target)]
        : chunk(live).map((part, i, parts) =>
            listOps.bulk(this.orgId, {
              op: 'move',
              ids: part,
              // Later chunks follow the previous chunk's last task.
              args: i === 0 ? target : { ...target, afterId: parts[i - 1]?.at(-1) ?? null },
            }),
          );
    this.run(this.t('undo.moved', { count: live.length }), specs);
    if (announceMove) this.announcePosition(live[0] as string);
    return true;
  }

  /** "Moved to Prio, position 1 of 2." */
  announcePosition(taskId: string): void {
    const state = this.state();
    const task = state?.tasks[taskId];
    const groupId = task?.placement?.groupId;
    if (!state || !groupId) return;
    const open = tasksInGroup(state, groupId).filter(
      (t) => t.completedAt === null || t.id === taskId,
    );
    announce(
      this.t('dnd.moved', {
        group: state.groups[groupId]?.name ?? '',
        position: open.findIndex((t) => t.id === taskId) + 1,
        total: open.length,
      }),
    );
  }

  /** Ctrl+↑/↓, Ctrl+Shift+↑/↓, Alt+Shift+↑/↓. On a header, Ctrl+↑/↓ moves the group. */
  keyboardMove(move: KeyboardMove): boolean {
    // Smart views are derived orders (02 §10): nothing to move within them; D re-dates.
    if (this.isView()) return false;
    const cursor = this.cursorRow();
    if (cursor?.kind === 'group') {
      if (move !== 'up' && move !== 'down') return false;
      return this.stepGroup(cursor.group.id, move === 'up' ? -1 : 1);
    }
    if (cursor?.kind === 'task' && this.task(cursor.id)?.parentId && cursor.parentId) {
      // Subtasks move among their siblings only (02 §5).
      if (move !== 'up' && move !== 'down') return true;
      return this.stepSubtask(cursor.id, move === 'up' ? -1 : 1);
    }
    const ids = this.selectedTaskIds();
    if (ids.length === 0) return false;
    const target = keyboardMoveTarget(visibleOrder(this.rows()), ids, move);
    if (!target) return true;
    this.moveTasks(ids, target);
    this.store().set({ focusSeq: this.store().focusSeq + 1 });
    return true;
  }

  /** "Move to…": the top of the chosen group. */
  moveToGroup(groupId: string, ids: readonly string[] = this.selectedTaskIds()): void {
    const state = this.state();
    if (!state) return;
    const moving = new Set(ids);
    const first = tasksInGroup(state, groupId).find((t) => !moving.has(t.id));
    this.moveTasks(ids, { groupId, afterId: null, beforeId: first?.id ?? null });
    this.store().set({ popover: null });
  }

  stepGroup(groupId: string, step: 1 | -1): boolean {
    const state = this.state();
    if (state?.groups[groupId]?.kind !== 'normal') return false;
    const intent = groupStepTarget(
      normalGroups(state).map((g) => g.id),
      groupId,
      step,
    );
    if (intent) this.moveGroup(groupId, intent);
    return true;
  }

  /** Reorders a group; a move onto its own place sends nothing (02 §5). Returns whether it moved. */
  moveGroup(groupId: string, intent: OrderingIntent): boolean {
    const state = this.state();
    const group = state?.groups[groupId];
    if (!state || !group || group.kind === 'inbox') return false;
    const order = normalGroups(state).map((g) => g.id);
    if (isNoopIntent(order, [groupId], intent)) return false;
    this.run(this.t('undo.groupMoved'), [listOps.moveGroup(groupId, intent)]);
    const moved = normalGroups(this.state() as ListState);
    announce(
      this.t('dnd.groupMoved', {
        group: group.name,
        position: moved.findIndex((g) => g.id === groupId) + 1,
        total: moved.length,
      }),
    );
    return true;
  }

  // -------------------------------------------------------------------------------------
  // Groups (02 §4)
  // -------------------------------------------------------------------------------------

  /** Chevron, ←/→. With `all` (Alt+click) every group follows. */
  setCollapsed(groupId: string, collapsed: boolean, all = false): void {
    const state = this.state();
    if (!state) return;
    const targets = all
      ? Object.values(state.groups).filter((g) => g.kind === 'normal' && g.collapsed !== collapsed)
      : [state.groups[groupId]].filter((g) => g && g.collapsed !== collapsed);
    const specs = targets.flatMap((g) => (g ? [listOps.patchGroup(g.id, { collapsed })] : []));
    if (specs.length === 0) return;
    // Collapse state is a view preference: persisted, but not an undo entry (02 §3.7 list).
    this.deps.pipeline.enqueue(this.orgId, specs, this.reducerContext());
  }

  /**
   * ←/→ in Navigate (02 §6): collapse or expand a group or a parent task. → on an expanded
   * parent selects its first subtask; ← on a subtask (nothing to collapse) selects its parent.
   */
  collapseCursor(collapsed: boolean): boolean {
    const row = this.cursorRow();
    if (row?.kind === 'group') {
      this.setCollapsed(row.group.id, collapsed);
      return true;
    }
    if (row?.kind !== 'task' || row.draft) return false;
    if (collapsed) {
      if (row.expandable && row.expanded) this.setExpanded(row.id, false);
      else if (row.parentId && this.rows().some((r) => r.id === row.parentId)) {
        this.store().select(row.parentId);
      }
      return true;
    }
    if (!row.expandable) return true;
    if (!row.expanded) {
      this.setExpanded(row.id, true);
      return true;
    }
    const rows = this.rows();
    const next = rows[rows.findIndex((r) => r.id === row.id) + 1];
    if (next?.kind === 'task' && next.parentId === row.id) this.store().select(next.id);
    return true;
  }

  // -------------------------------------------------------------------------------------
  // Subtasks (02 §3.1, FR-TASK-11)
  // -------------------------------------------------------------------------------------

  /** Chevron and ←/→: persisted per user (PUT/DELETE /tasks/:id/expanded), not undoable. */
  setExpanded(taskId: string, expanded: boolean): void {
    const state = this.state();
    if (!state || state.expandedTaskIds.includes(taskId) === expanded) return;
    this.deps.pipeline.enqueue(
      this.orgId,
      [listOps.setExpanded(taskId, expanded)],
      this.reducerContext(),
    );
  }

  toggleExpanded(taskId: string): void {
    this.setExpanded(taskId, !this.state()?.expandedTaskIds.includes(taskId));
  }

  /** Whether one more level fits below `taskId` (05 §4.3); hints when it does not. */
  canNestUnder(taskId: string): boolean {
    const state = this.state();
    if (!state?.tasks[taskId]) return false;
    if (depthOf(state, taskId) + 1 <= SUBTASK_DEPTH_MAX) return true;
    toast({ message: this.t('hint.subtaskDepth', { max: SUBTASK_DEPTH_MAX }) });
    return false;
  }

  /**
   * "Make subtask of…" (palette, ADR 0008): re-parents the tasks under `parentId` as one undo
   * step (`task.patch` with `parentId`). A task can't go under itself or its own descendant,
   * and the result must stay within the depth limit (05 §4.3); those are skipped with a hint.
   */
  makeSubtaskOf(ids: readonly string[], parentId: string): boolean {
    const state = this.state();
    const parent = state?.tasks[parentId];
    if (!state || !parent) return false;
    const lineage = new Set([parentId, ...ancestorsOf(state, parentId).map((t) => t.id)]);
    const candidates = ids.filter((id) => state.tasks[id] && state.tasks[id].parentId !== parentId);
    const acyclic = candidates.filter((id) => !lineage.has(id));
    const fits = acyclic.filter(
      (id) => depthOf(state, parentId) + 1 + subtreeHeight(state, id) <= SUBTASK_DEPTH_MAX,
    );
    if (acyclic.length < candidates.length) toast({ message: this.t('hint.subtaskCycle') });
    else if (fits.length < acyclic.length) {
      toast({ message: this.t('hint.subtaskDepth', { max: SUBTASK_DEPTH_MAX }) });
    }
    if (fits.length === 0) return false;
    this.run(
      this.t('undo.madeSubtask', { count: fits.length, parent: parent.title }),
      fits.map((id) => listOps.patchTask(id, { parentId })),
      { toast: true },
    );
    return true;
  }

  /**
   * Tab+S / S and "+ Add subtask": expands the parent and opens a subtask draft at the end of
   * its subtasks. In the pane's subtask list the parent is the pane's task.
   */
  addSubtask(parentId?: string): boolean {
    const id = parentId ?? this.selectedTaskIds()[0];
    const state = this.state();
    const parent = id ? state?.tasks[id] : undefined;
    if (!id || !parent || !this.canNestUnder(id)) return false;
    if (this.isView()) {
      // Flat rows: the subtask draft sits right under its parent, with the section's date.
      const row = this.rows().find((r) => r.id === id);
      if (row?.kind !== 'task' || !row.sectionId) return false;
      return this.newSectionDraft(row.sectionId, id, id) !== null;
    }
    if (!this.rootTaskId || this.rootTaskId !== id) this.setExpanded(id, true);
    const groupId = this.groupOfTask(id) ?? '';
    const siblings = this.rows().filter(
      (r): r is TaskRow => r.kind === 'task' && r.parentId === id,
    );
    const last = siblings.at(-1)?.id ?? childrenOf(state as ListState, id).at(-1)?.id ?? null;
    this.newDraft(groupId, last, id);
    return true;
  }

  /** The group a task's row renders in: its own placement, or its top-level ancestor's. */
  private groupOfTask(taskId: string): string | undefined {
    const state = this.state();
    let task = state?.tasks[taskId];
    for (let guard = 0; task && guard < 10; guard++) {
      if (task.placement) return task.placement.groupId;
      task = task.parentId ? state?.tasks[task.parentId] : undefined;
    }
    const row = this.rows().find((r) => r.id === taskId);
    return row?.kind === 'task' ? row.groupId : undefined;
  }

  /** Subtask reorder among siblings (DnD, Ctrl+↑/↓), with undo. */
  reorderSubtask(taskId: string, intent: OrderingIntent): boolean {
    const state = this.state();
    const parentId = this.task(taskId)?.parentId;
    if (!state || !parentId) return false;
    const siblings = childrenOf(state, parentId).map((t) => t.id);
    if (isNoopIntent(siblings, [taskId], intent)) return false;
    this.run(this.t('undo.moved', { count: 1 }), [listOps.reorderSubtask(taskId, intent)]);
    return true;
  }

  /** Ctrl+↑/↓ on a subtask: one step among its siblings. */
  private stepSubtask(taskId: string, step: 1 | -1): boolean {
    const state = this.state();
    const task = state?.tasks[taskId];
    if (!state || !task?.parentId) return false;
    const siblings = childrenOf(state, task.parentId).filter(
      (t) => t.completedAt === null || this.store().showCompleted || t.id === taskId,
    );
    const index = siblings.findIndex((t) => t.id === taskId);
    const target = index + step;
    if (target < 0 || target >= siblings.length) return true;
    const rest = siblings.filter((t) => t.id !== taskId);
    this.reorderSubtask(taskId, {
      afterId: rest[target - 1]?.id ?? null,
      beforeId: rest[target]?.id ?? null,
    });
    this.store().set({ focusSeq: this.store().focusSeq + 1 });
    return true;
  }

  // -------------------------------------------------------------------------------------
  // Duplicate (FR-TASK-13) and tags (FR-TAG-2)
  // -------------------------------------------------------------------------------------

  /** Ctrl+D: copies go directly after their originals; the selection moves to the copy. */
  duplicate(ids: readonly string[] = this.selectedTaskIds()): string[] {
    const live = ids.filter((id) => this.task(id));
    if (live.length === 0) return [];
    const copies = live.map(() => uuidv7());
    const specs = live.map((id, i) => listOps.duplicateTask(id, copies[i] as string));
    this.run(this.t('undo.duplicated', { count: live.length }), specs, { toast: true });
    if (this.rows().some((r) => r.id === copies[0])) this.store().select(copies[0] as string);
    return copies;
  }

  /** The tag picker's toggle: removes the tag when every task has it, else adds it. */
  toggleTag(ids: readonly string[], tagId: string): void {
    const tasks = ids.map((id) => this.task(id)).filter((t): t is Task => t !== undefined);
    if (tasks.length === 0) return;
    const remove = tasks.every((t) => t.tagIds.includes(tagId));
    const targets = tasks.filter((t) => t.tagIds.includes(tagId) === remove).map((t) => t.id);
    const specs =
      targets.length === 1
        ? [
            remove
              ? listOps.removeTag(targets[0] as string, tagId)
              : listOps.addTag(targets[0] as string, tagId),
          ]
        : chunk(targets).map((part) =>
            listOps.bulk(this.orgId, {
              op: remove ? 'removeTag' : 'addTag',
              ids: part,
              args: { tagId },
            }),
          );
    this.run(this.t(remove ? 'undo.untagged' : 'undo.tagged'), specs);
  }

  /** Removes one tag from one task (a chip's ×). */
  removeTag(taskId: string, tagId: string): void {
    if (!this.task(taskId)?.tagIds.includes(tagId)) return;
    this.run(this.t('undo.untagged'), [listOps.removeTag(taskId, tagId)]);
  }

  /** The picker's "Create …": a new org tag, added to the tasks. Returns its id. */
  createTagFor(ids: readonly string[], name: string): string | null {
    const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (trimmed === '') return null;
    const { ids: existing } = this.resolveTags([trimmed]);
    if (existing[0]) {
      this.toggleTag(ids, existing[0]);
      return existing[0];
    }
    const id = uuidv7();
    const live = ids.filter((t) => this.task(t));
    this.run(this.t('undo.tagged'), [
      listOps.createTag({ id, name: trimmed }),
      ...live.map((taskId) => listOps.addTag(taskId, id)),
    ]);
    return id;
  }

  renameGroup(groupId: string, name: string): void {
    const group = this.state()?.groups[groupId];
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!group || group.kind === 'inbox' || trimmed === '' || trimmed === group.name) return;
    this.run(this.t('undo.renamed'), [listOps.patchGroup(groupId, { name: trimmed.slice(0, 80) })]);
  }

  /** Enters rename on a header (click on the name, F2). */
  startRename(groupId: string): void {
    const group = this.state()?.groups[groupId];
    if (!group || group.kind === 'inbox') return;
    this.store().edit(groupRowId(groupId), 'end');
  }

  /**
   * Tab+N (02 §4): a group directly below the selected task, taking the tasks below it; on a
   * header (or nothing), an empty group after the current one. The caret lands in its name.
   */
  newGroupAtCursor(pendingTitle?: { rowId: string; raw: string; ignored: readonly Span[] }): void {
    if (pendingTitle) this.commitTitle(pendingTitle.rowId, pendingTitle.raw, pendingTitle.ignored);
    const state = this.state();
    // Smart views have no groups to split.
    if (!state || this.isView()) return;
    const row = this.cursorRow();
    const name = this.t('group.untitled');
    const id = uuidv7();
    let specs: ListOpSpec[];
    if (row?.kind === 'task' && !this.draftTask(row.id) && this.task(row.id)) {
      specs = [listOps.createGroup({ id, name, splitAfterTaskId: row.id })];
    } else if (row?.kind === 'task') {
      // An unsaved draft: split above it.
      this.store().removeDraft(row.id);
      specs = this.splitAtDraftSpecs(id, name, row.groupId, row.id);
    } else {
      const groupId = row?.kind === 'group' ? row.group.id : normalGroups(state).at(-1)?.id;
      specs = [listOps.createGroup({ id, name, ...this.afterGroupIntent(groupId) })];
    }
    const entry = this.run(this.t('undo.groupCreated'), specs);
    if (entry) {
      const moved = tasksInGroup(this.state() as ListState, id).length;
      if (moved > 0) {
        toast({
          message: this.t('undo.groupSplit', { count: moved }),
          action: { label: this.t('undo.action'), onAction: () => this.undoEntry(entry) },
        });
      }
    }
    this.store().edit(groupRowId(id), 'all');
  }

  /** `{afterId, beforeId}` for a new group right after `groupId` (the Inbox: at the top). */
  private afterGroupIntent(groupId: string | undefined) {
    const state = this.state() as ListState;
    const normals = normalGroups(state);
    const index = normals.findIndex((g) => g.id === groupId);
    return {
      afterId: index < 0 ? null : (normals[index]?.id ?? null),
      beforeId: normals[index + 1]?.id ?? null,
    };
  }

  /**
   * Splitting at a draft (colon-to-group, Tab+N on a draft): after the task above the
   * draft; with no task above, the new group takes the whole group (02 §4).
   */
  private splitAtDraftSpecs(
    id: string,
    name: string,
    groupId: string,
    draftId: string,
  ): ListOpSpec[] {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.id === draftId);
    const above = rows
      .slice(0, index)
      .reverse()
      .find((r) => r.kind !== 'task' || isTaskRow(r));
    if (above && isTaskRow(above) && above.groupId === groupId) {
      return [listOps.createGroup({ id, name, splitAfterTaskId: above.id })];
    }
    const state = this.state() as ListState;
    const ids = tasksInGroup(state, groupId).map((t) => t.id);
    return [
      listOps.createGroup({ id, name, ...this.afterGroupIntent(groupId) }),
      ...chunk(ids).map((part, i, parts) =>
        listOps.bulk(this.orgId, {
          op: 'move',
          ids: part,
          args: { groupId: id, afterId: parts[i - 1]?.at(-1) ?? null, beforeId: null },
        }),
      ),
    ];
  }

  /**
   * Colon-to-group (02 §4): the row becomes a group header named `name`. On a draft only the
   * group is created; on an existing task the group is created and the task deleted. One undo.
   */
  colonToGroup(rowId: string, name: string): void {
    const groupName = name.trim().slice(0, 80);
    if (groupName === '') return;
    const id = uuidv7();
    const draft = this.store().drafts.find((d) => d.id === rowId);
    let specs: ListOpSpec[];
    if (draft) {
      specs = this.splitAtDraftSpecs(id, groupName, draft.groupId, rowId);
      this.store().removeDraft(rowId);
    } else if (this.task(rowId)) {
      specs = [
        listOps.createGroup({ id, name: groupName, splitAfterTaskId: rowId }),
        listOps.deleteTask(rowId),
      ];
    } else {
      return;
    }
    this.run(this.t('undo.groupCreated'), specs, { toast: true });
    this.newDraft(id, null);
  }

  /** Header "⋯" → Add group below: an empty group right after this one. */
  addGroupAfter(groupId: string): void {
    const id = uuidv7();
    this.run(this.t('undo.groupCreated'), [
      listOps.createGroup({
        id,
        name: this.t('group.untitled'),
        ...this.afterGroupIntent(groupId),
      }),
    ]);
    this.store().edit(groupRowId(id), 'all');
  }

  /**
   * The header ⋯ menu's Collapse all / Expand all, Shift+←/→ (02 §2, §4): every normal group,
   * like an Alt+click on a chevron. A row that disappears into its group hands the cursor to
   * the group's header.
   */
  setAllCollapsed(collapsed: boolean): void {
    const row = this.cursorRow();
    this.setCollapsed('', collapsed, true);
    if (!collapsed || !row || row.kind === 'group' || !('groupId' in row)) return;
    if (this.state()?.groups[row.groupId]?.kind === 'normal') {
      this.store().select(groupRowId(row.groupId));
    }
  }

  /** Header "⋯" → Collapse others. */
  collapseOthers(groupId: string): void {
    const state = this.state();
    if (!state) return;
    const specs = Object.values(state.groups)
      .filter((g) => g.kind === 'normal' && g.collapsed !== (g.id !== groupId))
      .map((g) => listOps.patchGroup(g.id, { collapsed: g.id !== groupId }));
    if (specs.length > 0) this.deps.pipeline.enqueue(this.orgId, specs, this.reducerContext());
  }

  /** "+ Add group": at the end, caret in the name. */
  addGroupAtEnd(): void {
    const state = this.state();
    if (!state) return;
    const id = uuidv7();
    this.run(this.t('undo.groupCreated'), [
      listOps.createGroup({
        id,
        name: this.t('group.untitled'),
        afterId: normalGroups(state).at(-1)?.id ?? null,
        beforeId: null,
      }),
    ]);
    this.store().edit(groupRowId(id), 'all');
  }

  /** Header "⋯" → Delete. Empty groups go immediately (with undo); others need a choice. */
  requestDeleteGroup(groupId: string): void {
    const state = this.state();
    if (state?.groups[groupId]?.kind !== 'normal') return;
    // Only open tasks need a choice; completed leftovers go to the Inbox (ADR 0005 §4).
    if (tasksInGroup(state, groupId).every((t) => t.completedAt !== null)) {
      this.deleteGroup(groupId, {});
      return;
    }
    this.store().set({ popover: { kind: 'groupDelete', rowId: groupRowId(groupId) } });
  }

  canDeleteGroup(groupId: string): boolean {
    const state = this.state();
    return Boolean(
      state && state.groups[groupId]?.kind === 'normal' && normalGroups(state).length > 1,
    );
  }

  deleteGroup(groupId: string, option: { moveTasksTo?: string; deleteTasks?: true }): void {
    const group = this.state()?.groups[groupId];
    if (!group) return;
    const next = this.nextNavigableAfter([groupRowId(groupId)]);
    this.run(
      this.t('undo.groupDeleted', { name: group.name }),
      [listOps.deleteGroup(groupId, option)],
      {
        toast: true,
      },
    );
    this.store().set({ popover: null });
    this.store().select(next && !isGroupRowId(next) ? next : next);
  }

  /** The default "Move N tasks to" target: the group above, or below for the first. */
  defaultMoveTarget(groupId: string): string | undefined {
    const state = this.state();
    if (!state) return undefined;
    const normals = normalGroups(state);
    const index = normals.findIndex((g) => g.id === groupId);
    return (normals[index - 1] ?? normals[index + 1])?.id;
  }

  groupIdOfRow(rowId: string): string | undefined {
    if (isGroupRowId(rowId)) return groupIdOfRow(rowId);
    const row = this.rows().find((r) => r.id === rowId);
    return row?.kind === 'task' || row?.kind === 'add' ? row.groupId : undefined;
  }
}
