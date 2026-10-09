import { compareKeys } from '@rooster/core/ordering';
import { type ListState, normalizeMyList, tasksInGroup } from '@rooster/core/reducers';
import type { Group, Task } from '@rooster/core/schemas';
import { parseSseInvalidate } from '@rooster/core/sse';
import type { ViewCounts } from '@rooster/core/views';
import {
  type Me,
  type Member,
  type Org,
  RoosterApiError,
  type RoosterClient,
  type Tag,
  type TaskDetail,
  unwrap,
} from '../api.ts';
import { applyDueFlags, type DueUnit, isNone } from '../dates.ts';
import { CliError, EXIT } from '../errors.ts';
import { describeApiError } from '../grant-info.ts';
import { type Locale, withLocale } from '../i18n.ts';
import { clean } from '../output/color.ts';
import { type DateContext, dateContext } from '../output/format.ts';
import { type Runtime, withRuntime } from '../runtime.ts';
import type { TuiTranslate } from './i18n.ts';
import { editLine, type LineInput, lineInput } from './input.ts';
import { type CommandId, commandFor, GO_KEYS, GO_TIMEOUT_MS, type KeyInfo } from './keymap.ts';
import {
  buildLines,
  type CreateTarget,
  counts,
  createTarget,
  indexOfKey,
  keepSelection,
  type Line,
  type ListView,
  type MoveDirection,
  type MovePlan,
  planMove,
  restorePlan,
  stepSelection,
  type TaskLine,
  type ViewId,
} from './model.ts';
import type { SseMessage, SseState } from './sse.ts';

export type ActivityItem = {
  kind: 'comment' | 'activity';
  comment?: { id: string; authorId: string; body: string; createdAt: number };
  activity?: {
    id: string;
    actorId: string | null;
    via: string;
    createdAt: number;
    type: string;
    data: Record<string, unknown>;
  };
};

export type Mode =
  | { kind: 'navigate' }
  | { kind: 'edit'; taskId: string; input: LineInput; original: string }
  | { kind: 'draft'; target: CreateTarget; input: LineInput }
  | { kind: 'date'; taskId: string; input: LineInput; choice: number; error: string | null }
  | { kind: 'tag'; taskId: string; input: LineInput; choice: number }
  | { kind: 'group'; taskId: string; input: LineInput; choice: number }
  | { kind: 'search'; input: LineInput }
  | { kind: 'help'; scroll: number };

export interface Message {
  text: string;
  tone: 'info' | 'error';
  /** A failed change that `r` sends again (07 §5: mutations fail with a retry prompt). */
  retry: boolean;
  /** A change that `u` undoes (the web's undo toast). */
  undo?: boolean;
}

export interface DetailState {
  taskId: string;
  task: TaskDetail | null;
  activity: ActivityItem[] | null;
  error: string | null;
  scroll: number;
}

export type Connection = 'connecting' | 'live' | 'offline';

export interface TuiState {
  me: Me;
  org: Org;
  view: ViewId;
  /** The list view to return to from search results. */
  listView: ListView;
  list: ListState | null;
  tags: Tag[];
  members: Member[] | null;
  everyone: Task[] | null;
  search: { query: string; hits: Task[] } | null;
  dates: DateContext;
  lines: Line[];
  counts: ViewCounts | null;
  selected: string | null;
  showCompleted: boolean;
  mode: Mode;
  detail: DetailState | null;
  goPending: boolean;
  connection: Connection;
  saving: number;
  message: Message | null;
}

interface UndoEntry {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** The web's session undo stack holds 50 operations (02 §3.7). */
export const UNDO_LIMIT = 50;
/** How long a search waits for more typing before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 200;
/** Invalidations within this window are one refresh (the server coalesces 50 ms bursts too). */
export const REFRESH_DEBOUNCE_MS = 30;

export interface ControllerDeps {
  runtime: Runtime;
  /** The TUI's own client (`X-Rooster-Client: tui/…`, so activity says "via the terminal app"). */
  api: RoosterClient;
  locale: Locale;
  t: TuiTranslate;
  clientId: string;
  me: Me;
  org: Org;
  now: () => number;
  /** Runs `$EDITOR` on `text` with the terminal handed over; the new text or undefined. */
  editText: (text: string) => Promise<string | undefined>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Listener = () => void;

const DATE_SUGGESTIONS = ['today', 'tomorrow', 'weekend', 'nextWeek', 'nextMonth', 'none'] as const;
export type DateSuggestion = (typeof DATE_SUGGESTIONS)[number];

/** Orgs in the user's sidebar order (1–9 switch to them). */
export function orgsInOrder(me: Me): Org[] {
  return [...me.orgs].sort(
    (a, b) => compareKeys(a.position, b.position) || compareKeys(a.id, b.id),
  );
}

const isNetwork = (error: unknown) => error instanceof CliError && error.exitCode === EXIT.network;

/**
 * The TUI's state and every action on it. Ink only renders `getState()` and forwards keys to
 * `key()`; everything else (API calls, the undo stack, live updates) lives here, so it is
 * testable without a terminal.
 */
export class TuiController {
  private state: TuiState;
  private readonly listeners = new Set<Listener>();
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  /** Session overrides of the server's collapse and expand state, so a toggle sticks at once. */
  private readonly collapsed = new Map<string, boolean>();
  private readonly expanded = new Map<string, boolean>();
  private readonly keep = new Set<string>();
  private failed: (() => Promise<void>) | null = null;
  private inFlight = 0;
  private epoch = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private refreshTimer: unknown = null;
  private searchTimer: unknown = null;
  private goTimer: unknown = null;
  private pageSize = 10;
  private exitFn: () => void = () => {};
  private reconnectFn: () => void = () => {};
  private clockTimer: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private closed = false;
  /** Set by a view or org switch: select the first task unless the selected one is shown. */
  private preferFirst = false;

  constructor(private readonly deps: ControllerDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        // UI timers never keep the process alive after quitting.
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.state = {
      me: deps.me,
      org: deps.org,
      view: 'my',
      listView: 'my',
      list: null,
      tags: [],
      members: null,
      everyone: null,
      search: null,
      dates: dateContext(deps.me, deps.locale, deps.now()),
      lines: [],
      counts: null,
      selected: null,
      showCompleted: false,
      mode: { kind: 'navigate' },
      detail: null,
      goPending: false,
      connection: 'connecting',
      saving: 0,
      message: null,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Store

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): TuiState => this.state;

  private set(patch: Partial<TuiState>, derive = false): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    if (derive) this.derive();
    for (const listener of this.listeners) listener();
  }

  /** Recomputes the lines and counts, keeping the selection on the same task. */
  private derive(): void {
    const s = this.state;
    const dates = dateContext(s.me, this.deps.locale, this.deps.now());
    if (s.list === null) {
      this.state = { ...s, dates, lines: [], counts: null };
      return;
    }
    const lines = buildLines({
      view: s.view,
      list: s.list,
      viewerId: s.me.id,
      dates,
      showCompleted: s.showCompleted,
      keep: this.keep,
      expanded: new Set(this.expandedIds(s.list)),
      collapsed: (group) => this.collapsed.get(group.id) ?? group.collapsed,
      members: s.members,
      everyone: s.everyone,
      search: s.search,
      t: this.deps.t,
    });
    const previous = Math.max(0, indexOfKey(s.lines, s.selected));
    // A fresh list starts on its first task rather than on a header.
    const shown = lines.some((line) => line.key === s.selected);
    const selected =
      s.selected === null || (this.preferFirst && !shown)
        ? (lines.find((line) => line.kind === 'task')?.key ?? keepSelection(lines, null, 0))
        : keepSelection(lines, s.selected, previous);
    this.preferFirst = false;
    this.state = { ...s, dates, lines, counts: counts(s.list, s.me.id, dates), selected };
  }

  private expandedIds(list: ListState): string[] {
    const ids = new Set(list.expandedTaskIds);
    for (const [id, open] of this.expanded) {
      if (open) ids.add(id);
      else ids.delete(id);
    }
    return [...ids];
  }

  /** Runs `fn` in the CLI's locale and runtime context (`t()`, `describeApiError`). */
  private ctx<T>(fn: () => Promise<T>): Promise<T> {
    return withLocale(this.deps.locale, () => withRuntime(this.deps.runtime, fn));
  }

  private get api(): RoosterClient {
    return this.deps.api;
  }

  private t(key: string, values?: Record<string, unknown>): string {
    return this.deps.t(key, values);
  }

  /** The user-facing text of a failure: the server's explanation, never a stack. */
  private async describe(error: unknown): Promise<string> {
    if (error instanceof RoosterApiError) {
      const described = await this.ctx(() => describeApiError(this.deps.runtime, error)).catch(
        () => null,
      );
      return clean(described?.message ?? error.message);
    }
    if (error instanceof CliError) return clean(error.message);
    return clean(String(error instanceof Error ? error.message : error));
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle and loading

  /** Called by the Ink app once mounted. */
  attach(options: { exit: () => void }): void {
    this.exitFn = options.exit;
  }

  /** How `r` reconnects the live stream while offline (the session's `SseClient`). */
  setReconnect(reconnect: () => void): void {
    this.reconnectFn = reconnect;
  }

  /** The list area's height, for page moves. */
  setPageSize(rows: number): void {
    this.pageSize = Math.max(1, rows - 1);
  }

  async start(): Promise<void> {
    this.tickClock();
    await this.loadOrg(this.state.org);
  }

  /** Relative dates and the smart views move on at midnight without a key being pressed. */
  private tickClock(): void {
    this.clockTimer = this.setTimer(() => {
      if (this.closed) return;
      this.set({}, true);
      this.tickClock();
    }, 60_000);
  }

  close(): void {
    this.closed = true;
    this.clearTimer(this.clockTimer);
    this.clearTimer(this.refreshTimer);
    this.clearTimer(this.searchTimer);
    this.clearTimer(this.goTimer);
  }

  quit(): void {
    this.close();
    this.exitFn();
  }

  private async fetchMyList(orgId: string): Promise<ListState> {
    const list = await unwrap(
      this.api.GET('/api/v1/orgs/{orgId}/my-list', { params: { path: { orgId } } }),
    );
    return normalizeMyList(orgId, list);
  }

  private async fetchEveryone(orgId: string, showCompleted: boolean): Promise<Task[]> {
    const out: Task[] = [];
    let cursor: string | undefined;
    do {
      const page = await unwrap(
        this.api.GET('/api/v1/orgs/{orgId}/tasks', {
          params: {
            path: { orgId },
            query: {
              view: 'everyone',
              limit: 200,
              completed: showCompleted ? 'any' : 'false',
              ...(cursor === undefined ? {} : { cursor }),
            },
          },
        }),
      );
      out.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return out;
  }

  private async fetchSearch(orgId: string, query: string): Promise<Task[]> {
    const hits = await unwrap(
      this.api.GET('/api/v1/search', { params: { query: { q: query, limit: 50, orgId } } }),
    );
    return hits.map((hit) => hit.task);
  }

  /** Everything the current org and view show, fetched together. */
  private async fetchAll(org: Org, view: ViewId, search: string | null) {
    const shared = !org.isPersonal;
    const [list, tags, members, everyone, hits] = await this.ctx(() =>
      Promise.all([
        this.fetchMyList(org.id),
        unwrap(this.api.GET('/api/v1/orgs/{orgId}/tags', { params: { path: { orgId: org.id } } })),
        shared
          ? unwrap(
              this.api.GET('/api/v1/orgs/{orgId}/members', { params: { path: { orgId: org.id } } }),
            )
          : Promise.resolve(null),
        view === 'everyone' && shared
          ? this.fetchEveryone(org.id, this.state.showCompleted)
          : Promise.resolve(null),
        view === 'search' && search !== null && search.trim() !== ''
          ? this.fetchSearch(org.id, search)
          : Promise.resolve(null),
      ]),
    );
    return { list, tags, members, everyone, hits };
  }

  private async loadOrg(org: Org): Promise<void> {
    const view = this.state.view;
    try {
      const data = await this.fetchAll(org, view, this.state.search?.query ?? null);
      if (this.state.org.id !== org.id) return;
      this.set(
        {
          list: data.list,
          tags: data.tags,
          members: data.members,
          everyone: data.everyone,
          ...(data.hits === null
            ? {}
            : { search: { query: this.state.search?.query ?? '', hits: data.hits } }),
        },
        true,
      );
      if (this.state.detail !== null) void this.loadDetail(this.state.detail.taskId);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Refetches what is shown. Concurrent calls coalesce; a response that raced a change of
   * this session's own is dropped and fetched again after it, so a local edit never flickers
   * back to the old value.
   */
  refresh(): Promise<void> {
    if (this.refreshing !== null) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        const epoch = this.epoch;
        const org = this.state.org;
        let data: Awaited<ReturnType<TuiController['fetchAll']>>;
        try {
          data = await this.fetchAll(org, this.state.view, this.state.search?.query ?? null);
        } catch (error) {
          this.fail(error);
          return;
        }
        if (this.closed || org.id !== this.state.org.id) return;
        if (epoch !== this.epoch || this.inFlight > 0) {
          // A change of ours started meanwhile: its completion refreshes again.
          if (this.inFlight === 0) this.refreshAgain = true;
          continue;
        }
        this.set(
          {
            list: data.list,
            tags: data.tags,
            members: data.members,
            everyone: data.everyone,
            ...(data.hits === null || this.state.search === null
              ? {}
              : { search: { ...this.state.search, hits: data.hits } }),
          },
          true,
        );
        if (this.state.detail !== null) await this.loadDetail(this.state.detail.taskId);
      } while (this.refreshAgain && !this.closed);
    })().finally(() => {
      this.refreshing = null;
      // Asked for again after the loop's last check: run once more.
      if (this.refreshAgain && !this.closed) void this.refresh();
    });
    return this.refreshing;
  }

  private scheduleRefresh(): void {
    this.clearTimer(this.refreshTimer);
    this.refreshTimer = this.setTimer(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  private fail(error: unknown): void {
    void this.describe(error).then((text) => {
      // A failed change waiting for `r` keeps its prompt: retrying it matters more.
      if (this.failed !== null && this.state.message?.retry) {
        if (isNetwork(error)) this.set({ connection: 'offline' });
        return;
      }
      this.set({
        message: { text: this.t('error.load', { message: text }), tone: 'error', retry: true },
        ...(isNetwork(error) ? { connection: 'offline' as const } : {}),
      });
      this.failed = () => this.refresh();
    });
  }

  private async loadDetail(taskId: string): Promise<void> {
    try {
      const [task, page] = await this.ctx(() =>
        Promise.all([
          unwrap(this.api.GET('/api/v1/tasks/{id}', { params: { path: { id: taskId } } })),
          unwrap(
            this.api.GET('/api/v1/tasks/{id}/activity', {
              params: { path: { id: taskId }, query: { limit: 30 } },
            }),
          ).catch(() => null),
        ]),
      );
      if (this.state.detail?.taskId !== taskId) return;
      this.set({
        detail: {
          ...this.state.detail,
          task,
          activity: (page?.items as ActivityItem[] | undefined) ?? null,
          error: null,
        },
      });
    } catch (error) {
      const text = await this.describe(error);
      if (this.state.detail?.taskId !== taskId) return;
      this.set({ detail: { ...this.state.detail, error: text } });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Live updates (SSE)

  /** Wired to `SseClient.onState`. */
  readonly onSseState = (state: SseState): void => {
    if (state === 'open') {
      // No replay after a reconnect (06 §2.9): refetch what is shown.
      const wasLive = this.state.connection === 'live';
      this.set({ connection: 'live' });
      if (!wasLive && this.state.list !== null) void this.refresh();
    } else {
      this.set({ connection: state === 'offline' ? 'offline' : 'connecting' });
    }
  };

  /** Wired to `SseClient.onDenied`: the login was revoked or expired. */
  readonly onSseDenied = (): void => {
    this.set({
      connection: 'offline',
      message: { text: this.t('error.denied'), tone: 'error', retry: false },
    });
  };

  /** Wired to `SseClient.onMessage`. */
  readonly onSseMessage = (message: SseMessage): void => {
    if (message.event !== 'invalidate') return;
    let payload: unknown;
    try {
      payload = JSON.parse(message.data);
    } catch {
      return;
    }
    const event = parseSseInvalidate(payload);
    if (event === null) return;
    // Our own changes refresh when they complete; the echo would only refetch twice.
    if (event.origin === this.deps.clientId) return;
    const roots = new Set(event.keys.map((key) => key[0]));
    if (roots.has('me') || roots.has('orgs')) void this.reloadMe();
    if (event.org !== null && event.org !== this.state.org.id) return;
    this.scheduleRefresh();
  };

  private async reloadMe(): Promise<void> {
    try {
      const me = await this.ctx(() => unwrap(this.api.GET('/api/v1/me')));
      const org = me.orgs.find((o) => o.id === this.state.org.id);
      if (org === undefined) {
        // Removed from the org: back to the personal one.
        const personal = me.orgs.find((o) => o.isPersonal) ?? me.orgs[0];
        if (personal !== undefined) {
          this.set({ me });
          await this.switchOrg(personal);
        }
        return;
      }
      this.set({ me, org }, true);
    } catch {
      // The next invalidation or `r` tries again; the list itself is unaffected.
    }
  }

  // ------------------------------------------------------------------------------------------
  // Mutations

  private touchTask(task: Task): void {
    const s = this.state;
    const patch: Partial<TuiState> = {};
    if (s.list !== null && (s.list.tasks[task.id] !== undefined || task.placement !== null)) {
      patch.list = { ...s.list, tasks: { ...s.list.tasks, [task.id]: task } };
    }
    if (s.everyone !== null) {
      patch.everyone = s.everyone.some((t) => t.id === task.id)
        ? s.everyone.map((t) => (t.id === task.id ? task : t))
        : [...s.everyone, task];
    }
    if (s.search !== null) {
      patch.search = { ...s.search, hits: s.search.hits.map((t) => (t.id === task.id ? task : t)) };
    }
    this.set(patch, true);
  }

  private dropTask(taskId: string): void {
    const s = this.state;
    const patch: Partial<TuiState> = {};
    if (s.list !== null && s.list.tasks[taskId] !== undefined) {
      const tasks = { ...s.list.tasks };
      delete tasks[taskId];
      patch.list = { ...s.list, tasks };
    }
    if (s.everyone !== null) patch.everyone = s.everyone.filter((t) => t.id !== taskId);
    if (s.search !== null) {
      patch.search = { ...s.search, hits: s.search.hits.filter((t) => t.id !== taskId) };
    }
    this.set(patch, true);
  }

  /** A task as currently shown (list, Everyone or search). */
  private findTask(taskId: string): Task | undefined {
    const s = this.state;
    return (
      s.list?.tasks[taskId] ??
      s.everyone?.find((t) => t.id === taskId) ??
      s.search?.hits.find((t) => t.id === taskId)
    );
  }

  /** An optimistic change of a task's fields, and its way back. */
  private localTask(task: Task, patch: Partial<Task>) {
    return {
      apply: () => this.touchTask({ ...task, ...patch }),
      revert: () => this.touchTask(task),
    };
  }

  private pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * Sends one change. On failure the message offers `r` to send it again (07 §5: no offline
   * queue); either way the shown data is refetched once nothing of ours is in flight.
   */
  private async mutate(
    exec: () => Promise<void>,
    options: {
      done?: string;
      undoable?: boolean;
      onSuccess?: () => void;
      /** Shown at once and taken back if the server refuses (or can't be reached). */
      local?: { apply: () => void; revert: () => void };
    } = {},
  ): Promise<boolean> {
    this.inFlight += 1;
    this.epoch += 1;
    this.set({ saving: this.inFlight });
    options.local?.apply();
    let offline = false;
    try {
      await this.ctx(exec);
      this.failed = null;
      options.onSuccess?.();
      if (options.done !== undefined) {
        this.set({
          message: {
            text: options.done,
            tone: 'info',
            retry: false,
            undo: options.undoable ?? true,
          },
        });
      } else if (this.state.message?.retry) this.set({ message: null });
      return true;
    } catch (error) {
      options.local?.revert();
      offline = isNetwork(error);
      const text = await this.describe(error);
      this.failed = () => this.mutate(exec, options).then(() => {});
      this.set({
        message: { text: this.t('error.save', { message: text }), tone: 'error', retry: true },
        ...(isNetwork(error) ? { connection: 'offline' as const } : {}),
      });
      return false;
    } finally {
      this.inFlight -= 1;
      this.epoch += 1;
      this.set({ saving: this.inFlight });
      // Unreachable: refetching would only fail again; `r` retries the change.
      if (this.inFlight === 0 && !offline) void this.refresh();
    }
  }

  private async patchTask(taskId: string, body: Record<string, unknown>): Promise<Task> {
    const result = await unwrap(
      this.api.PATCH('/api/v1/tasks/{id}', { params: { path: { id: taskId } }, body }),
    );
    this.touchTask(result.task);
    return result.task;
  }

  private async complete(taskId: string, completed: boolean): Promise<void> {
    const result = await unwrap(
      this.api.POST('/api/v1/tasks/{id}/complete', {
        params: { path: { id: taskId } },
        body: { completed },
      }),
    );
    this.touchTask(result.task);
    if (result.next !== undefined) this.touchTask(result.next);
  }

  private async sendMove(taskId: string, plan: MovePlan): Promise<void> {
    if (plan.kind === 'move') {
      const result = await unwrap(
        this.api.POST('/api/v1/tasks/{id}/move', {
          params: { path: { id: taskId } },
          body: plan.body,
        }),
      );
      const task = this.findTask(taskId);
      if (task !== undefined) this.touchTask({ ...task, placement: result.placement });
    } else {
      const result = await unwrap(
        this.api.POST('/api/v1/tasks/{id}/reorder', {
          params: { path: { id: taskId } },
          body: plan.body,
        }),
      );
      const task = this.findTask(taskId);
      if (task !== undefined) this.touchTask({ ...task, subtaskPosition: result.subtaskPosition });
    }
  }

  private async deleteTask(taskId: string): Promise<void> {
    await unwrap(this.api.DELETE('/api/v1/tasks/{id}', { params: { path: { id: taskId } } }));
    this.dropTask(taskId);
  }

  private async restoreTask(taskId: string): Promise<void> {
    const task = await unwrap(
      this.api.POST('/api/v1/tasks/{id}/restore', { params: { path: { id: taskId } } }),
    );
    this.touchTask(task);
  }

  private async setTag(taskId: string, tagId: string, on: boolean): Promise<void> {
    const params = { params: { path: { id: taskId, tagId } } };
    const task = on
      ? await unwrap(this.api.PUT('/api/v1/tasks/{id}/tags/{tagId}', params))
      : await unwrap(this.api.DELETE('/api/v1/tasks/{id}/tags/{tagId}', params));
    this.touchTask(task);
  }

  // ------------------------------------------------------------------------------------------
  // Selection helpers

  private selectedLine(): Line | undefined {
    return this.state.lines[indexOfKey(this.state.lines, this.state.selected)];
  }

  private selectedTask(): TaskLine | undefined {
    const line = this.selectedLine();
    return line?.kind === 'task' ? line : undefined;
  }

  private select(key: string | null): void {
    this.set({ selected: key });
    this.followDetail();
  }

  /** The open detail view always shows the selected task (02 §3.2, D-29). */
  private followDetail(): void {
    const detail = this.state.detail;
    const line = this.selectedTask();
    if (detail === null || line === undefined || line.task.id === detail.taskId) return;
    this.set({
      detail: { taskId: line.task.id, task: null, activity: null, error: null, scroll: 0 },
    });
    void this.loadDetail(line.task.id);
  }

  private info(key: string, values?: Record<string, unknown>): void {
    this.set({ message: { text: this.t(key, values), tone: 'info', retry: false } });
  }

  // ------------------------------------------------------------------------------------------
  // Keys

  /** Every keypress, from Ink's `useInput`. */
  key(input: string, key: KeyInfo): void {
    if (this.closed) return;
    if (key.ctrl && input === 'c') {
      this.quit();
      return;
    }
    const mode = this.state.mode;
    switch (mode.kind) {
      case 'edit':
      case 'draft':
        this.keyTitle(mode, input, key);
        return;
      case 'date':
        this.keyDate(mode, input, key);
        return;
      case 'tag':
      case 'group':
        this.keyPicker(mode, input, key);
        return;
      case 'search':
        this.keySearch(mode, input, key);
        return;
      case 'help':
        this.keyHelp(mode, input, key);
        return;
      case 'navigate':
        this.keyNavigate(input, key);
    }
  }

  private keyNavigate(input: string, key: KeyInfo): void {
    if (this.state.goPending) {
      this.clearTimer(this.goTimer);
      this.set({ goPending: false });
      const view = GO_KEYS[input];
      if (view !== undefined && !key.ctrl && !key.meta) void this.setView(view);
      return;
    }
    const command = commandFor(input, key);
    // Any key acknowledges a notice; an error with a retry stays until `r` or Esc.
    if (command !== null && this.state.message !== null && !this.state.message.retry) {
      this.set({ message: null });
    }
    if (command !== null) this.run(command, input);
  }

  /** Runs a Navigate-mode command (the `KEYMAP` ids). */
  run(command: CommandId, input = ''): void {
    switch (command) {
      case 'down':
        this.select(stepSelection(this.state.lines, this.state.selected, 1));
        return;
      case 'up':
        this.select(stepSelection(this.state.lines, this.state.selected, -1));
        return;
      case 'first':
        this.select(stepSelection(this.state.lines, this.state.selected, -this.state.lines.length));
        return;
      case 'last':
        this.select(stepSelection(this.state.lines, this.state.selected, this.state.lines.length));
        return;
      case 'scrollDown':
      case 'scrollUp': {
        const detail = this.state.detail;
        const delta = command === 'scrollDown' ? this.pageSize : -this.pageSize;
        if (detail !== null) {
          this.set({ detail: { ...detail, scroll: Math.max(0, detail.scroll + delta) } });
        } else this.select(stepSelection(this.state.lines, this.state.selected, delta));
        return;
      }
      case 'collapse':
        this.toggleOpen(false);
        return;
      case 'expand':
        this.toggleOpen(true);
        return;
      case 'edit':
        this.startEdit();
        return;
      case 'newBelow':
        this.startDraft('below');
        return;
      case 'newAbove':
        this.startDraft('above');
        return;
      case 'subtask':
        this.startDraft('subtask');
        return;
      case 'complete':
        this.toggleComplete();
        return;
      case 'date':
      case 'tag':
      case 'move':
        this.openPicker(command);
        return;
      case 'detail':
        this.toggleDetail();
        return;
      case 'description':
        void this.editDescription();
        return;
      case 'moveDown':
        this.moveSelected('down');
        return;
      case 'moveUp':
        this.moveSelected('up');
        return;
      case 'nextGroup':
        this.moveSelected('nextGroup');
        return;
      case 'prevGroup':
        this.moveSelected('prevGroup');
        return;
      case 'delete':
        this.deleteSelected();
        return;
      case 'undo':
        void this.undo();
        return;
      case 'redo':
        void this.redo();
        return;
      case 'search':
        this.set({ mode: { kind: 'search', input: lineInput(this.state.search?.query ?? '') } });
        return;
      case 'go':
        this.set({ goPending: true });
        this.goTimer = this.setTimer(() => this.set({ goPending: false }), GO_TIMEOUT_MS);
        return;
      case 'org': {
        const org = orgsInOrder(this.state.me)[Number(input) - 1];
        if (org !== undefined) void this.switchOrg(org);
        return;
      }
      case 'showCompleted':
        this.set({ showCompleted: !this.state.showCompleted }, true);
        if (this.state.view === 'everyone') void this.refresh();
        return;
      case 'retry':
        this.retry();
        return;
      case 'help':
        this.set({ mode: { kind: 'help', scroll: 0 } });
        return;
      case 'close':
        this.escape();
        return;
      case 'quit':
        this.quit();
        return;
    }
  }

  private escape(): void {
    if (this.state.message !== null) {
      this.set({ message: null });
      this.failed = null;
      return;
    }
    if (this.state.detail !== null) {
      this.set({ detail: null });
      return;
    }
    if (this.state.view === 'search') void this.setView(this.state.listView);
  }

  private retry(): void {
    const failed = this.failed;
    this.failed = null;
    this.set({ message: null });
    if (this.state.connection === 'offline') this.reconnectFn();
    if (failed !== null) void failed();
    else void this.refresh();
  }

  // ------------------------------------------------------------------------------------------
  // Views and orgs

  async setView(view: ListView): Promise<void> {
    if (view === 'everyone' && this.state.org.isPersonal) {
      this.info('msg.everyonePersonal');
      return;
    }
    const needsFetch = view === 'everyone' && this.state.everyone === null;
    this.preferFirst = true;
    this.set({ view, listView: view, search: null, mode: { kind: 'navigate' } }, true);
    if (needsFetch || view === 'everyone') await this.refresh();
  }

  async switchOrg(org: Org): Promise<void> {
    if (org.id === this.state.org.id) return;
    const view = this.state.view === 'everyone' && org.isPersonal ? 'my' : this.state.listView;
    this.collapsed.clear();
    this.expanded.clear();
    this.keep.clear();
    this.set(
      {
        org,
        view,
        listView: view,
        list: null,
        tags: [],
        members: null,
        everyone: null,
        search: null,
        selected: null,
        detail: null,
        mode: { kind: 'navigate' },
        message: null,
      },
      true,
    );
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    await this.loadOrg(org);
  }

  // ------------------------------------------------------------------------------------------
  // Collapse and expand

  private toggleOpen(open: boolean): void {
    const line = this.selectedLine();
    if (line?.kind === 'group') {
      if (line.collapsed === !open) return;
      this.collapsed.set(line.group.id, !open);
      this.set({}, true);
      void this.persist(() =>
        unwrap(
          this.api.PATCH('/api/v1/groups/{id}', {
            params: { path: { id: line.group.id } },
            body: { collapsed: !open },
          }),
        ),
      );
      return;
    }
    if (line?.kind !== 'task') return;
    if (open && line.expanded) {
      // → on an expanded parent selects its first subtask (02 §6).
      this.select(stepSelection(this.state.lines, line.key, 1));
      return;
    }
    if (!open && !line.expanded && line.task.parentId !== null && line.depth > 0) {
      // ← on a subtask selects its parent.
      this.select(line.task.parentId);
      return;
    }
    if (this.state.view !== 'my' || !line.hasChildren || line.expanded === open) return;
    this.setExpanded(line.task.id, open);
  }

  private setExpanded(taskId: string, open: boolean): void {
    this.expanded.set(taskId, open);
    this.set({}, true);
    const params = { params: { path: { id: taskId } } };
    void this.persist(() =>
      open
        ? unwrap(this.api.PUT('/api/v1/tasks/{id}/expanded', params))
        : unwrap(this.api.DELETE('/api/v1/tasks/{id}/expanded', params)),
    );
  }

  /**
   * View state saved for the user (the web shows the same collapse state). A grant that may
   * not write keeps it for this session only.
   */
  private async persist(exec: () => Promise<unknown>): Promise<void> {
    try {
      await this.ctx(exec);
    } catch (error) {
      if (error instanceof RoosterApiError && error.status === 403) return;
      const text = await this.describe(error);
      this.set({
        message: { text: this.t('error.save', { message: text }), tone: 'error', retry: false },
      });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Title editing and creating

  private startEdit(): void {
    const line = this.selectedTask();
    if (line === undefined) {
      const selected = this.selectedLine();
      if (selected?.kind === 'group') this.toggleOpen(selected.collapsed);
      return;
    }
    const title = line.task.title;
    this.set({
      mode: { kind: 'edit', taskId: line.task.id, input: lineInput(title), original: title },
    });
  }

  private startDraft(where: 'below' | 'above' | 'subtask'): void {
    const s = this.state;
    if (s.list === null) return;
    if (s.view === 'search') {
      this.info('msg.noAddInSearch');
      return;
    }
    const target = createTarget(s.view, s.lines, s.list, s.selected, where);
    if (target === null) return;
    if (target.expandGroup !== undefined && this.collapsed.get(target.expandGroup)) {
      this.collapsed.set(target.expandGroup, false);
      this.derive();
    }
    if (target.expandTask !== undefined && !this.expandedIds(s.list).includes(target.expandTask)) {
      // The new subtask shows under its parent, as on the web (Tab+S expands the parent).
      this.setExpanded(target.expandTask, true);
    }
    this.set({ mode: { kind: 'draft', target, input: lineInput() } });
  }

  private keyTitle(
    mode: Extract<Mode, { kind: 'edit' | 'draft' }>,
    input: string,
    key: KeyInfo,
  ): void {
    const result = editLine(mode.input, input, key);
    if (result.kind === 'change') {
      this.set({ mode: { ...mode, input: result.input } });
      return;
    }
    if (result.kind === 'ignored') return;
    // Enter and Esc both commit, as on the web (02 §3.5); Enter on a draft opens the next one.
    const title = mode.input.value.trim();
    this.set({ mode: { kind: 'navigate' } });
    if (mode.kind === 'edit') {
      if (title === '') {
        this.info('msg.emptyTitle');
        return;
      }
      if (title === mode.original) return;
      const { taskId, original } = mode;
      const task = this.findTask(taskId);
      void this.mutate(() => this.patchTask(taskId, { title }).then(() => {}), {
        ...(task === undefined ? {} : { local: this.localTask(task, { title }) }),
        onSuccess: () =>
          this.pushUndo({
            undo: () => this.patchTask(taskId, { title: original }).then(() => {}),
            redo: () => this.patchTask(taskId, { title }).then(() => {}),
          }),
      });
      return;
    }
    if (title === '') return;
    void this.create(mode.target, title, result.kind === 'submit');
  }

  private async create(target: CreateTarget, title: string, again: boolean): Promise<void> {
    const orgId = this.state.org.id;
    let created: Task | undefined;
    const ok = await this.mutate(
      async () => {
        created = await unwrap(
          this.api.POST('/api/v1/orgs/{orgId}/tasks', {
            params: { path: { orgId } },
            body: { title, parse: true, ...target.body },
          }),
        );
        this.touchTask(created);
        this.select(created.id);
      },
      {
        onSuccess: () => {
          const id = created?.id;
          if (id === undefined) return;
          this.pushUndo({
            undo: () => this.deleteTask(id),
            redo: () => this.restoreTask(id),
          });
        },
      },
    );
    if (!ok || !again || created === undefined || this.state.mode.kind !== 'navigate') return;
    // Rapid entry: the next draft goes below the task just added (02 §3.4).
    const s = this.state;
    if (s.list === null) return;
    const next = createTarget(s.view, s.lines, s.list, created.id, 'below');
    if (next !== null) this.set({ mode: { kind: 'draft', target: next, input: lineInput() } });
  }

  // ------------------------------------------------------------------------------------------
  // Completing, deleting, moving

  private toggleComplete(): void {
    const line = this.selectedTask();
    if (line === undefined) return;
    const task = line.task;
    const completed = task.completedAt === null;
    const title = clean(task.title);
    void this.mutate(() => this.complete(task.id, completed), {
      local: {
        apply: () => {
          if (completed) this.holdCompleted(task.id);
          this.touchTask({ ...task, completedAt: completed ? this.deps.now() : null });
        },
        revert: () => {
          this.keep.delete(task.id);
          this.touchTask(task);
        },
      },
      done: this.t(completed ? 'toast.completed' : 'toast.reopened', { title }),
      onSuccess: () =>
        this.pushUndo({
          undo: () => this.complete(task.id, !completed),
          redo: () => this.complete(task.id, completed),
        }),
    });
  }

  /** The web keeps a completed row in place for `completeHideMs` (D-09); 0 keeps it for the session. */
  private holdCompleted(taskId: string): void {
    this.keep.add(taskId);
    const ms = this.state.me.prefs.completeHideMs;
    if (ms <= 0) return;
    this.setTimer(() => {
      this.keep.delete(taskId);
      this.set({}, true);
    }, ms);
  }

  private deleteSelected(): void {
    const line = this.selectedTask();
    if (line === undefined) return;
    const id = line.task.id;
    const title = clean(line.task.title);
    void this.mutate(() => this.deleteTask(id), {
      done: this.t('toast.deleted', { title }),
      onSuccess: () =>
        this.pushUndo({ undo: () => this.restoreTask(id), redo: () => this.deleteTask(id) }),
    });
  }

  private moveSelected(direction: MoveDirection): void {
    const line = this.selectedTask();
    const list = this.state.list;
    if (line === undefined || list === null) return;
    if (this.state.view !== 'my') {
      this.info('msg.sortedView');
      return;
    }
    const visible = (t: Task) =>
      t.completedAt === null || this.state.showCompleted || this.keep.has(t.id);
    const plan = planMove(list, line.task.id, direction, visible);
    if (plan === null) {
      if (
        line.task.placement === null &&
        (direction === 'nextGroup' || direction === 'prevGroup')
      ) {
        this.info('msg.subtaskGroup');
      }
      return;
    }
    const back = restorePlan(list, line.task.id);
    const id = line.task.id;
    void this.mutate(() => this.sendMove(id, plan), {
      onSuccess: () => {
        if (back !== null) {
          this.pushUndo({
            undo: () => this.sendMove(id, back),
            redo: () => this.sendMove(id, plan),
          });
        }
      },
    });
  }

  // ------------------------------------------------------------------------------------------
  // Undo and redo (02 §3.7): inverse REST calls, kept for this session only

  async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (entry === undefined) {
      this.info('msg.nothingToUndo');
      return;
    }
    await this.mutate(entry.undo, {
      done: this.t('toast.undone'),
      undoable: false,
      onSuccess: () => this.redoStack.push(entry),
    });
  }

  async redo(): Promise<void> {
    const entry = this.redoStack.pop();
    if (entry === undefined) {
      this.info('msg.nothingToRedo');
      return;
    }
    await this.mutate(entry.redo, {
      done: this.t('toast.redone'),
      undoable: false,
      onSuccess: () => this.undoStack.push(entry),
    });
  }

  // ------------------------------------------------------------------------------------------
  // Pickers: date, tag, group

  private openPicker(command: 'date' | 'tag' | 'move'): void {
    const line = this.selectedTask();
    if (line === undefined) return;
    const taskId = line.task.id;
    if (command === 'move' && line.task.placement === null) {
      this.info('msg.notInMyList');
      return;
    }
    const kind = command === 'move' ? 'group' : command;
    this.set({
      mode:
        kind === 'date'
          ? { kind, taskId, input: lineInput(), choice: 0, error: null }
          : { kind, taskId, input: lineInput(), choice: 0 },
    });
  }

  /** The phrase of a date suggestion, in the user's language (parsed like typed text). */
  dateSuggestions(): { id: DateSuggestion; phrase: string }[] {
    return DATE_SUGGESTIONS.map((id) => ({ id, phrase: this.t(`date.${id}`) }));
  }

  /** The due unit `phrase` gives the task, or an error message. */
  previewDate(taskId: string, phrase: string): { due: DueUnit } | { error: string } {
    const task = this.findTask(taskId);
    if (task === undefined) return { error: this.t('msg.taskGone') };
    try {
      const due = withLocale(this.deps.locale, () =>
        applyDueFlags(task, { due: phrase }, this.state.me, this.deps.now()),
      );
      if (due === null) return { error: this.t('date.invalid', { phrase }) };
      return { due };
    } catch (error) {
      // The CLI's own message names the `--due` flag; here it is the picker's.
      if (error instanceof CliError && error.exitCode === EXIT.conflict && !isNone(phrase)) {
        return { error: this.t('date.invalid', { phrase: clean(phrase) }) };
      }
      return { error: error instanceof Error ? clean(error.message) : String(error) };
    }
  }

  private keyDate(mode: Extract<Mode, { kind: 'date' }>, input: string, key: KeyInfo): void {
    const suggestions = this.dateSuggestions();
    if (key.downArrow || key.upArrow) {
      const delta = key.downArrow ? 1 : -1;
      const choice = (mode.choice + delta + suggestions.length) % suggestions.length;
      this.set({ mode: { ...mode, choice, error: null } });
      return;
    }
    const result = editLine(mode.input, input, key);
    if (result.kind === 'change') {
      this.set({ mode: { ...mode, input: result.input, error: null } });
      return;
    }
    if (result.kind === 'cancel') {
      this.set({ mode: { kind: 'navigate' } });
      return;
    }
    if (result.kind !== 'submit') return;
    const typed = mode.input.value.trim();
    const phrase = typed !== '' ? typed : (suggestions[mode.choice]?.phrase ?? '');
    const preview = isNone(phrase)
      ? { due: { dueDate: null, dueTime: null, dueTz: null, startDate: null } }
      : this.previewDate(mode.taskId, phrase);
    if ('error' in preview) {
      this.set({ mode: { ...mode, error: preview.error } });
      return;
    }
    this.set({ mode: { kind: 'navigate' } });
    const task = this.findTask(mode.taskId);
    if (task === undefined) return;
    const before: DueUnit = {
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      dueTz: task.dueTz,
      startDate: task.startDate,
    };
    const after = preview.due;
    const id = task.id;
    void this.mutate(() => this.patchTask(id, { ...after }).then(() => {}), {
      local: this.localTask(task, after),
      onSuccess: () =>
        this.pushUndo({
          undo: () => this.patchTask(id, { ...before }).then(() => {}),
          redo: () => this.patchTask(id, { ...after }).then(() => {}),
        }),
    });
  }

  /** The picker's options for the current filter text. */
  pickerOptions(mode: Extract<Mode, { kind: 'tag' | 'group' }>): PickerOption[] {
    const query = mode.input.value.trim().toLocaleLowerCase();
    const matches = (name: string) => query === '' || name.toLocaleLowerCase().includes(query);
    if (mode.kind === 'tag') {
      const collator = new Intl.Collator(this.deps.locale, { sensitivity: 'base' });
      const task = this.findTask(mode.taskId);
      const options: PickerOption[] = [...this.state.tags]
        .sort((a, b) => collator.compare(a.name, b.name) || compareKeys(a.id, b.id))
        .filter((tag) => matches(tag.name))
        .map((tag) => ({
          id: tag.id,
          label: clean(tag.name),
          color: tag.color,
          checked: task?.tagIds.includes(tag.id) ?? false,
        }));
      const exact = this.state.tags.some((tag) => tag.name.toLocaleLowerCase() === query);
      const name = mode.input.value.trim().replace(/^#/, '');
      if (name !== '' && !exact) {
        options.push({ id: null, label: clean(name), color: null, checked: false });
      }
      return options;
    }
    const list = this.state.list;
    if (list === null) return [];
    const groups: Group[] = Object.values(list.groups).sort((a, b) =>
      a.kind === b.kind
        ? compareKeys(a.position, b.position) || compareKeys(a.id, b.id)
        : a.kind === 'inbox'
          ? -1
          : 1,
    );
    const current = this.findTask(mode.taskId)?.placement?.groupId;
    return groups
      .filter((group) => matches(group.name))
      .map((group) => ({
        id: group.id,
        label: clean(group.name),
        color: null,
        checked: group.id === current,
      }));
  }

  private keyPicker(
    mode: Extract<Mode, { kind: 'tag' | 'group' }>,
    input: string,
    key: KeyInfo,
  ): void {
    const options = this.pickerOptions(mode);
    if (key.downArrow || key.upArrow) {
      if (options.length === 0) return;
      const delta = key.downArrow ? 1 : -1;
      this.set({
        mode: { ...mode, choice: (mode.choice + delta + options.length) % options.length },
      });
      return;
    }
    // "Move to…" has digit shortcuts while the filter is empty (02 §5).
    if (mode.kind === 'group' && mode.input.value === '' && /^[1-9]$/.test(input) && !key.ctrl) {
      const option = options[Number(input) - 1];
      if (option !== undefined) this.pick(mode, option);
      return;
    }
    const result = editLine(mode.input, input, key);
    if (result.kind === 'change') {
      this.set({ mode: { ...mode, input: result.input, choice: 0 } });
      return;
    }
    if (result.kind === 'cancel') {
      this.set({ mode: { kind: 'navigate' } });
      return;
    }
    if (result.kind !== 'submit') return;
    const option = options[Math.min(mode.choice, options.length - 1)];
    if (option === undefined) return;
    this.pick(mode, option);
  }

  private pick(mode: Extract<Mode, { kind: 'tag' | 'group' }>, option: PickerOption): void {
    const task = this.findTask(mode.taskId);
    if (task === undefined) {
      this.set({ mode: { kind: 'navigate' } });
      return;
    }
    const id = task.id;
    if (mode.kind === 'group') {
      this.set({ mode: { kind: 'navigate' } });
      const groupId = option.id;
      const list = this.state.list;
      if (groupId === null || list === null || task.placement?.groupId === groupId) return;
      const first = tasksInGroup(list, groupId).find((t) => t.completedAt === null);
      const plan: MovePlan = {
        kind: 'move',
        body: first === undefined ? { groupId } : { groupId, afterId: null, beforeId: first.id },
      };
      const back = restorePlan(list, id);
      void this.mutate(() => this.sendMove(id, plan), {
        done: this.t('toast.moved', { group: option.label }),
        onSuccess: () => {
          if (back !== null) {
            this.pushUndo({
              undo: () => this.sendMove(id, back),
              redo: () => this.sendMove(id, plan),
            });
          }
        },
      });
      return;
    }
    // Tags: the picker stays open, so several can be toggled (Esc closes it).
    this.set({ mode: { ...mode, input: lineInput(), choice: 0 } });
    if (option.id === null) {
      const name = option.label;
      const orgId = this.state.org.id;
      let tagId: string | undefined;
      void this.mutate(
        async () => {
          const tag = await unwrap(
            this.api.POST('/api/v1/orgs/{orgId}/tags', {
              params: { path: { orgId } },
              body: { name },
            }),
          );
          tagId = tag.id;
          this.set({ tags: [...this.state.tags, tag] });
          await this.setTag(id, tag.id, true);
        },
        {
          onSuccess: () => {
            const created = tagId;
            if (created === undefined) return;
            this.pushUndo({
              undo: () => this.setTag(id, created, false),
              redo: () => this.setTag(id, created, true),
            });
          },
        },
      );
      return;
    }
    const tagId = option.id;
    const on = !option.checked;
    void this.mutate(() => this.setTag(id, tagId, on), {
      local: this.localTask(task, {
        tagIds: on ? [...task.tagIds, tagId] : task.tagIds.filter((t) => t !== tagId),
      }),
      onSuccess: () =>
        this.pushUndo({
          undo: () => this.setTag(id, tagId, !on),
          redo: () => this.setTag(id, tagId, on),
        }),
    });
  }

  // ------------------------------------------------------------------------------------------
  // Search

  private keySearch(mode: Extract<Mode, { kind: 'search' }>, input: string, key: KeyInfo): void {
    const result = editLine(mode.input, input, key);
    if (result.kind === 'change') {
      this.set({ mode: { ...mode, input: result.input } });
      this.clearTimer(this.searchTimer);
      const query = result.input.value;
      this.searchTimer = this.setTimer(() => void this.search(query), SEARCH_DEBOUNCE_MS);
      return;
    }
    if (result.kind === 'cancel') {
      this.clearTimer(this.searchTimer);
      this.set({ mode: { kind: 'navigate' } });
      if (this.state.view === 'search') void this.setView(this.state.listView);
      return;
    }
    if (result.kind === 'submit') {
      this.clearTimer(this.searchTimer);
      this.set({ mode: { kind: 'navigate' } });
      void this.search(mode.input.value);
    }
  }

  private async search(query: string): Promise<void> {
    const q = query.trim();
    if (q === '') {
      if (this.state.view === 'search') {
        this.set({ view: this.state.listView, search: null }, true);
      }
      return;
    }
    try {
      const hits = await this.ctx(() => this.fetchSearch(this.state.org.id, q));
      this.preferFirst = true;
      this.set({ view: 'search', search: { query: q, hits } }, true);
    } catch (error) {
      this.fail(error);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Detail view and description

  private toggleDetail(): void {
    if (this.state.detail !== null) {
      this.set({ detail: null });
      return;
    }
    const line = this.selectedTask();
    if (line === undefined) return;
    this.set({
      detail: { taskId: line.task.id, task: null, activity: null, error: null, scroll: 0 },
    });
    void this.loadDetail(line.task.id);
  }

  /** `e`: the description in `$EDITOR` (through `launch.ts`, never a shell; ADR 0039 §8). */
  async editDescription(): Promise<void> {
    const line = this.selectedTask();
    if (line === undefined) return;
    const id = line.task.id;
    let before: string;
    try {
      const detail = await this.ctx(() =>
        unwrap(this.api.GET('/api/v1/tasks/{id}', { params: { path: { id } } })),
      );
      before = detail.description;
    } catch (error) {
      this.fail(error);
      return;
    }
    let after: string | undefined;
    try {
      after = await this.ctx(() => this.deps.editText(before));
    } catch (error) {
      const text = await this.describe(error);
      this.set({ message: { text, tone: 'error', retry: false } });
      return;
    }
    if (after === undefined) {
      this.info('msg.descriptionUnchanged');
      return;
    }
    const text = after;
    await this.mutate(() => this.patchTask(id, { description: text }).then(() => {}), {
      done: this.t('toast.description'),
      onSuccess: () =>
        this.pushUndo({
          undo: () => this.patchTask(id, { description: before }).then(() => {}),
          redo: () => this.patchTask(id, { description: text }).then(() => {}),
        }),
    });
  }

  // ------------------------------------------------------------------------------------------
  // Help

  private keyHelp(mode: Extract<Mode, { kind: 'help' }>, input: string, key: KeyInfo): void {
    const command = commandFor(input, key);
    if (command === 'help' || command === 'close' || command === 'quit') {
      this.set({ mode: { kind: 'navigate' } });
      return;
    }
    const step =
      command === 'down'
        ? 1
        : command === 'up'
          ? -1
          : command === 'scrollDown'
            ? this.pageSize
            : command === 'scrollUp'
              ? -this.pageSize
              : 0;
    if (step !== 0) this.set({ mode: { ...mode, scroll: Math.max(0, mode.scroll + step) } });
  }
}

export interface PickerOption {
  /** A tag or group id; null for "create this tag". */
  id: string | null;
  label: string;
  color: string | null;
  checked: boolean;
}
