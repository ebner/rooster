import { uuidv7 } from '@rooster/core/ids';
import {
  type ApplyContext,
  inverseOfSequence,
  type ListOpSpec,
  type ListState,
  listOps,
  normalGroups,
  tasksInGroup,
} from '@rooster/core/reducers';
import { BULK_MAX, type OrderingIntent, type Task, type TaskMove } from '@rooster/core/schemas';
import type { DroppedOp, ListPipeline } from '../../data/list';
import {
  type Caret,
  type Draft,
  groupIdOfRow,
  groupRowId,
  isGroupRowId,
  selectedIds,
  useListStore,
} from '../../state/list-store';
import { type UndoEntry, useUndoStore } from '../../state/undo-store';
import { toast } from '../../ui/toast';
import type { ViewerDateContext } from '../dates';
import { announce } from './announcer';
import { groupStepTarget, type KeyboardMove, keyboardMoveTarget } from './model/moves';
import { isNavigable, isTaskRow, type Row, type TaskRow, visibleOrder } from './model/rows';
import { parseTitle, type Span } from './title-tokens';

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
  /** User prefs: title parsing (02 §8.1) and the completion hold (02 §3.6), read live. */
  prefs?: () => { parseTitles: boolean; holdMs: number };
  holdMs?: number;
  collapseMs?: number;
}

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

  state(): ListState | undefined {
    return this.deps.pipeline.view(this.deps.orgId);
  }

  private get t(): Translate {
    return this.deps.t;
  }

  private ctx(): ApplyContext {
    return { userId: this.deps.userId, now: Date.now() };
  }

  private parseTitles(): boolean {
    return this.deps.prefs?.().parseTitles ?? true;
  }

  private store() {
    return useListStore.getState();
  }

  task(id: string): Task | undefined {
    return this.state()?.tasks[id];
  }

  // -------------------------------------------------------------------------------------
  // Running ops and undo (02 §3.7)
  // -------------------------------------------------------------------------------------

  /** Applies and queues `specs` as one user operation with one undo entry. */
  run(label: string, specs: ListOpSpec[], options: { toast?: boolean } = {}): UndoEntry | null {
    const before = this.state();
    if (!before || specs.length === 0) return null;
    const inverseOps = inverseOfSequence(specs, before, this.ctx());
    this.deps.pipeline.enqueue(this.orgId, specs, { userId: this.deps.userId });
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
    this.deps.pipeline.enqueue(entry.orgId, entry.redoOps, { userId: this.deps.userId });
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
    for (const id of Object.keys(this.store().hiding)) this.clearHiding(id);
    this.deps.pipeline.enqueue(entry.orgId, entry.inverseOps, { userId: this.deps.userId });
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
    useListStore.setState({ anchor: from });
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
    const groupId =
      cursorRow?.kind === 'task'
        ? cursorRow.groupId
        : cursorRow?.kind === 'group'
          ? cursorRow.group.id
          : undefined;
    const inGroup = rows.filter((r) => r.groupId === groupId).map((r) => r.id);
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
    const count = selectedIds(store).length;
    if (count > 1 && store.cursor) {
      store.select(store.cursor);
      return true;
    }
    if (count === 1) {
      store.set({ selected: {}, anchor: null });
      return true;
    }
    return false;
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

  /** Creates a draft row and puts the caret in it. */
  newDraft(groupId: string, afterId: string | null): string {
    const draft: Draft = { id: uuidv7(), groupId, afterId };
    this.store().addDraft(draft);
    this.store().edit(draft.id, 'end');
    return draft.id;
  }

  /** The row above `rowId` within its group (task or draft), or null at the top. */
  private rowAboveInGroup(rowId: string): string | null {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.id === rowId);
    const above = rows[index - 1];
    return above?.kind === 'task' ? above.id : null;
  }

  /** N / Enter: new row below the cursor (or at the end of its group). */
  newBelow(rowId?: string | null): void {
    const row = rowId ? this.rows().find((r) => r.id === rowId) : this.cursorRow();
    if (row?.kind === 'task') this.newDraft(row.groupId, row.id);
    else if (row?.kind === 'group') this.newDraft(row.group.id, null);
    else this.quickAdd();
  }

  /** Shift+N / Shift+Enter: new row above. */
  newAbove(rowId?: string | null): void {
    const row = rowId ? this.rows().find((r) => r.id === rowId) : this.cursorRow();
    if (row?.kind === 'task') this.newDraft(row.groupId, this.rowAboveInGroup(row.id));
    else if (row?.kind === 'group') this.newDraft(row.group.id, null);
    else this.quickAdd();
  }

  /** "+ Add task": a draft at the end of the group. */
  addAtEnd(groupId: string): void {
    const last = this.rows()
      .filter((r): r is TaskRow => r.kind === 'task' && r.groupId === groupId)
      .at(-1);
    this.newDraft(groupId, last?.id ?? null);
  }

  /** Q / Tab+Q: top of the first visible group, Inbox excluded (02 §3.4). */
  quickAdd(): void {
    const state = this.state();
    if (!state) return;
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
    const parsed = parseTitle(raw, this.deps.dateContext(), ignored, this.parseTitles());
    const draft = this.store().drafts.find((d) => d.id === rowId);
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
      (due.dueDate !== task.dueDate || due.dueTime !== task.dueTime || due.dueTz !== task.dueTz);
    const patch = {
      ...(parsed.title === task.title ? {} : { title: parsed.title }),
      ...(dueChanged ? due : {}),
    };
    if (Object.keys(patch).length > 0) {
      this.run(this.t('undo.edited'), [listOps.patchTask(rowId, patch)]);
    }
    return {};
  }

  private createFromDraft(draft: Draft, parsed: readonly { title: string; due?: object }[]): void {
    const rows = this.rows();
    const index = rows.findIndex((r) => r.id === draft.id);
    // Neighbours among persisted tasks of the group, around the draft's slot.
    const before = rows
      .slice(0, index)
      .reverse()
      .find((r): r is TaskRow => isTaskRow(r) && r.groupId === draft.groupId);
    const after = rows
      .slice(index + 1)
      .find((r): r is TaskRow => isTaskRow(r) && r.groupId === draft.groupId);
    const sameGroupBefore = before && this.rowsBetweenSameGroup(rows, before.id, draft.id);
    const sameGroupAfter = after && this.rowsBetweenSameGroup(rows, draft.id, after.id);
    let afterId: string | null = sameGroupBefore ? before.id : null;
    const beforeId: string | null = sameGroupAfter ? after.id : null;
    const specs: ListOpSpec[] = [];
    parsed.forEach((p, i) => {
      const id = i === 0 ? draft.id : uuidv7();
      createdHere.add(id);
      specs.push(
        listOps.createTask({
          id,
          title: p.title,
          groupId: draft.groupId,
          afterId,
          beforeId,
          ...(p.due ?? {}),
        }),
      );
      afterId = id;
    });
    this.store().removeDraft(draft.id);
    this.run(
      parsed.length === 1
        ? this.t('undo.created')
        : this.t('undo.createdMany', { count: parsed.length }),
      specs,
    );
  }

  /** True when no group header lies between the two rows. */
  private rowsBetweenSameGroup(rows: readonly Row[], a: string, b: string): boolean {
    const i = rows.findIndex((r) => r.id === a);
    const j = rows.findIndex((r) => r.id === b);
    return rows
      .slice(Math.min(i, j), Math.max(i, j))
      .every((r) => r.kind !== 'group' || r.id === a);
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
    const result = this.commitTitle(rowId, raw, ignored);
    const row = this.rows().find((r) => r.id === rowId);
    const groupId = row?.kind === 'task' ? row.groupId : draft?.groupId;
    if (!groupId) return result;
    if (above) this.newDraft(groupId, this.rowAboveInGroup(rowId));
    else this.newDraft(groupId, rowId);
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
    // List payloads omit the description; only tasks created here are known to have none.
    if (task.description === undefined) return !createdHere.has(task.id);
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
    const ctx = this.deps.dateContext();
    const parsed = lines
      .map((line) => parseTitle(line, ctx, [], this.parseTitles()))
      .filter((p) => p.title !== '');
    if (parsed.length === 0) return;
    let draft = this.store().drafts.find((d) => d.id === rowId);
    if (!draft) {
      const row = this.rows().find((r) => r.id === rowId);
      if (row?.kind !== 'task') return;
      draft = { id: uuidv7(), groupId: row.groupId, afterId: row.id };
      this.store().addDraft(draft);
    }
    this.createFromDraft(draft, parsed);
    this.store().navigate(draft.id);
  }

  // -------------------------------------------------------------------------------------
  // Completing and deleting
  // -------------------------------------------------------------------------------------

  /** Checkbox / Ctrl+Enter: completes (or, in the hold window, un-completes). */
  toggleComplete(ids: readonly string[] = this.selectedTaskIds()): void {
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
    const specs =
      targets.length === 1
        ? [listOps.completeTask(targets[0] as string, complete)]
        : chunk(targets).map((part) =>
            listOps.bulk(this.orgId, { op: complete ? 'complete' : 'uncomplete', ids: part }),
          );
    for (const id of targets) {
      if (complete) this.startHiding(id);
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

  private startHiding(id: string): void {
    if (this.store().showCompleted) return;
    this.clearHiding(id);
    const hold = this.deps.prefs?.().holdMs ?? this.deps.holdMs ?? completionHoldMs;
    const collapse = this.deps.collapseMs ?? completionCollapseMs;
    this.store().setHiding(id, 'hold');
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

  /** Tab+Delete, Delete in Navigate, the bulk bar: soft delete with undo. */
  deleteTasks(ids: readonly string[] = this.selectedTaskIds()): void {
    const live = ids.filter((id) => this.task(id));
    if (live.length === 0) return;
    const next = this.nextNavigableAfter(live);
    const specs =
      live.length === 1
        ? [listOps.deleteTask(live[0] as string)]
        : chunk(live).map((part) => listOps.bulk(this.orgId, { op: 'delete', ids: part }));
    const label =
      live.length === 1
        ? this.t('undo.deleted')
        : this.t('undo.deletedMany', { count: live.length });
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
    due: { dueDate: string | null; dueTime: string | null; dueTz: string | null } | null,
  ): void {
    const value = due ?? { dueDate: null, dueTime: null, dueTz: null };
    const live = ids.filter((id) => this.task(id));
    if (live.length === 0) return;
    const specs =
      live.length === 1
        ? [listOps.patchTask(live[0] as string, value)]
        : chunk(live).map((part) =>
            listOps.bulk(this.orgId, { op: 'setDue', ids: part, args: value }),
          );
    this.run(due ? this.t('undo.dated') : this.t('undo.dateCleared'), specs, {
      toast: due === null,
    });
  }

  // -------------------------------------------------------------------------------------
  // Moving (02 §5)
  // -------------------------------------------------------------------------------------

  /** Moves tasks to an intent; one op for one task, bulk for several. */
  moveTasks(ids: readonly string[], target: TaskMove, announceMove = true): void {
    const live = ids.filter((id) => this.task(id));
    if (live.length === 0) return;
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
    const cursor = this.cursorRow();
    if (cursor?.kind === 'group') {
      if (move !== 'up' && move !== 'down') return false;
      return this.stepGroup(cursor.group.id, move === 'up' ? -1 : 1);
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

  moveGroup(groupId: string, intent: OrderingIntent): void {
    const state = this.state();
    const group = state?.groups[groupId];
    if (!state || !group || group.kind === 'inbox') return;
    this.run(this.t('undo.groupMoved'), [listOps.moveGroup(groupId, intent)]);
    const order = normalGroups(this.state() as ListState);
    announce(
      this.t('dnd.groupMoved', {
        group: group.name,
        position: order.findIndex((g) => g.id === groupId) + 1,
        total: order.length,
      }),
    );
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
    this.deps.pipeline.enqueue(this.orgId, specs, { userId: this.deps.userId });
  }

  /** ←/→ in Navigate on a header (or on a task: its group). */
  collapseCursor(collapsed: boolean): boolean {
    const row = this.cursorRow();
    if (row?.kind !== 'group') return false;
    this.setCollapsed(row.group.id, collapsed);
    return true;
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
    if (!state) return;
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

  /** Header "⋯" → Collapse others. */
  collapseOthers(groupId: string): void {
    const state = this.state();
    if (!state) return;
    const specs = Object.values(state.groups)
      .filter((g) => g.kind === 'normal' && g.collapsed !== (g.id !== groupId))
      .map((g) => listOps.patchGroup(g.id, { collapsed: g.id !== groupId }));
    if (specs.length > 0)
      this.deps.pipeline.enqueue(this.orgId, specs, { userId: this.deps.userId });
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
