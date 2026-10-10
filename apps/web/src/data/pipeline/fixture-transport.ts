import { compareRows, isRow } from '@rooster/core/everyone';
import { uuidv7 } from '@rooster/core/ids';
import { DEFAULT_PREFS } from '@rooster/core/limits';
import { generateNKeysBetween } from '@rooster/core/ordering';
import { normalizeRule } from '@rooster/core/recurrence';
import {
  ancestorsOf,
  applyOp,
  childrenOf,
  depthOf,
  descendantIds,
  type ListState,
  normalGroups,
  normalizeMyList,
  SUBTASK_DEPTH_MAX,
  subtreeHeight,
  tasksInGroup,
} from '@rooster/core/reducers';
import { type ReminderSpec, resolveFireAt } from '@rooster/core/reminders';
import type {
  ActivityItem,
  ActivityPage,
  Comment,
  Group,
  MyList,
  Reminder,
  Tag,
  Task,
  TaskDetail,
  TaskPage,
} from '@rooster/core/schemas';
import { type TagColor, tagColorNames } from '@rooster/tokens';
import { ApiError } from '../errors';
import type { ListTransport } from './transport';

export type FixtureTask =
  | string
  | {
      title: string;
      dueDate?: string;
      dueTime?: string;
      dueTz?: string;
      startDate?: string;
      completed?: boolean;
      description?: string;
      /** Tag names (created in the org on first use). */
      tags?: readonly string[];
      subtasks?: readonly FixtureTask[];
      expanded?: boolean;
      /** P6: a member's user ID, or null for unassigned. Default: the fixture user. */
      assignee?: string | null;
      /** P6: comment bodies, oldest first, by the fixture user. */
      comments?: readonly string[];
      /** P10: a repeat rule (needs `dueDate`), stored normalised. */
      recurrence?: string;
      recurrenceBasis?: 'due' | 'completion';
      /** P10: the fixture user's relative reminders, minutes before the due moment. */
      reminders?: readonly number[];
      /** P10: the attachment count the row shows. */
      attachments?: number;
    };

export interface FixtureOptions {
  userId: string;
  /** Default group names, Inbox first (the server names them in the user's language). */
  groupNames?: readonly [inbox: string, ...rest: string[]];
  /** Demo tasks per group, by index (0 = the Inbox). */
  tasks?: Readonly<Record<number, readonly FixtureTask[]>>;
  /** Simulated round trip. */
  latencyMs?: number;
  /** Org tags to start with (P3). */
  tags?: readonly { name: string; color?: TagColor }[];
  /** P6: the other members (assignees must be one of them or the fixture user). */
  members?: readonly { userId: string; name: string }[];
  /** P10: the fixture user's zone (completion dates, all-day reminders). Default UTC. */
  timezone?: string;
}

/**
 * An in-memory server behind the pipeline's transport interface, for the dev fixture
 * route and component tests. It applies ops with the same core reducers the server
 * mirrors and answers with the documented response shapes (06 §2.3–2.4).
 */
export function createFixtureTransport(options: FixtureOptions): ListTransport & {
  state: (orgId: string) => ListState;
  /** Makes the next `send` fail with this status. */
  failNext: (status: number, code?: string) => void;
  tags: (orgId: string) => Tag[];
  /** Descriptions are kept apart: list payloads omit them. */
  descriptions: Map<string, string>;
  /** P6: every comment by ID (deleted ones carry `deleted`). */
  comments: Map<string, Comment & { deleted?: boolean }>;
  /** P10: the fixture user's reminders by task. */
  reminders: Map<string, Reminder[]>;
} {
  const { userId, latencyMs = 0 } = options;
  const owner = {
    timezone: options.timezone ?? 'UTC',
    allDayReminderTime: DEFAULT_PREFS.allDayReminderTime,
  };
  const reminders = new Map<string, Reminder[]>();
  const fireAtFor = (r: Pick<Reminder, 'kind' | 'offsetMinutes' | 'remindAt'>, task: Task) =>
    resolveFireAt(r, task, owner);
  const addReminder = (task: Task, spec: ReminderSpec, id: string = uuidv7()): Reminder => {
    const list = reminders.get(task.id) ?? [];
    const same = list.find((r) =>
      'at' in spec ? r.remindAt === spec.at : r.offsetMinutes === spec.offsetMinutes,
    );
    if (same) return same;
    const relative = 'offsetMinutes' in spec;
    const base = {
      kind: relative ? ('relative' as const) : ('absolute' as const),
      offsetMinutes: relative ? spec.offsetMinutes : null,
      remindAt: relative ? null : spec.at,
    };
    const reminder: Reminder = {
      id,
      taskId: task.id,
      ...base,
      fireAt: fireAtFor(base, task),
      firedAt: null,
      createdAt: Date.now(),
    };
    reminders.set(task.id, [...list, reminder]);
    return reminder;
  };
  /** The earliest pending reminder (the row's bell), after resolving against the task's due. */
  const bellOf = (task: Task): number | null => {
    const list = (reminders.get(task.id) ?? []).map((r) => ({ ...r, fireAt: fireAtFor(r, task) }));
    reminders.set(task.id, list);
    if (task.completedAt !== null) return null;
    let min: number | null = null;
    for (const r of list) {
      if (r.firedAt === null && r.fireAt !== null && (min === null || r.fireAt < min))
        min = r.fireAt;
    }
    return min;
  };
  const orgs = new Map<string, ListState>();
  const tagsByOrg = new Map<string, Tag[]>();
  const descriptions = new Map<string, string>();
  const comments = new Map<string, Comment & { deleted?: boolean }>();
  const followers = new Map<string, string[]>();
  const memberIds = new Set([userId, ...(options.members ?? []).map((m) => m.userId)]);
  let seq = 0;
  let failure: ApiError | null = null;

  const tagsOf = (orgId: string): Tag[] => {
    let tags = tagsByOrg.get(orgId);
    if (!tags) {
      tags = (options.tags ?? []).map((t, i) => ({
        id: uuidv7(),
        orgId,
        name: t.name,
        color: t.color ?? (tagColorNames[i % tagColorNames.length] as TagColor),
        createdAt: 0,
      }));
      tagsByOrg.set(orgId, tags);
    }
    return tags;
  };

  /** Case-insensitive name lookup; unknown names get the next palette colour (06 §2.5). */
  const tagNamed = (orgId: string, name: string, id?: string, color?: TagColor): Tag => {
    const tags = tagsOf(orgId);
    const existing = tags.find((t) => t.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) return existing;
    const tag: Tag = {
      id: id ?? uuidv7(),
      orgId,
      name,
      color: color ?? (tagColorNames[tags.length % tagColorNames.length] as TagColor),
      createdAt: Date.now(),
    };
    tags.push(tag);
    return tag;
  };

  const seed = (orgId: string): ListState => {
    const [inbox = 'Inbox', ...rest] = options.groupNames ?? ['Inbox', 'Today', 'Prio', 'Upcoming'];
    const keys = generateNKeysBetween(null, null, rest.length);
    const groups: Group[] = [
      { id: uuidv7(), orgId, kind: 'inbox', name: inbox, position: 'a0', collapsed: false },
      ...rest.map((name, i) => ({
        id: uuidv7(),
        orgId,
        kind: 'normal' as const,
        name,
        position: keys[i] as string,
        collapsed: false,
      })),
    ];
    const tasks: Task[] = [];
    const expandedTaskIds: string[] = [];
    const add = (
      entry: FixtureTask,
      position: string,
      parent: Task | null,
      groupId: string,
    ): Task => {
      const spec = typeof entry === 'string' ? { title: entry } : entry;
      seq += 1;
      const id = uuidv7();
      const children = spec.subtasks ?? [];
      const keys = generateNKeysBetween(null, null, children.length);
      const assigneeId =
        spec.assignee !== undefined ? spec.assignee : parent ? parent.assigneeId : userId;
      const ownRow = assigneeId === userId && (parent === null || parent.assigneeId !== assigneeId);
      const task: Task = {
        id,
        orgId,
        seq,
        parentId: parent?.id ?? null,
        subtaskPosition: parent ? position : null,
        title: spec.title,
        assigneeId,
        createdBy: userId,
        dueDate: spec.dueDate ?? null,
        dueTime: spec.dueTime ?? null,
        dueTz: spec.dueTz ?? null,
        startDate: spec.startDate ?? null,
        tagIds: (spec.tags ?? []).map((name) => tagNamed(orgId, name).id),
        completedAt: spec.completed ? 1 : null,
        hasDescription: (spec.description ?? '').trim() !== '',
        counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: spec.attachments ?? 0 },
        placement: ownRow ? { groupId, position } : null,
        createdAt: seq,
        updatedAt: 0,
        recurrence:
          spec.recurrence && spec.dueDate
            ? normalizeRule(spec.recurrence, spec.dueDate, spec.recurrenceBasis ?? 'due')
            : null,
        recurrenceBasis: spec.recurrence && spec.dueDate ? (spec.recurrenceBasis ?? 'due') : null,
        nextReminderAt: null,
      };
      for (const offsetMinutes of spec.reminders ?? []) addReminder(task, { offsetMinutes });
      task.nextReminderAt = bellOf(task);
      if (spec.description) descriptions.set(id, spec.description);
      for (const [i, body] of (spec.comments ?? []).entries()) {
        const commentId = uuidv7();
        comments.set(commentId, {
          id: commentId,
          taskId: id,
          authorId: userId,
          body,
          createdAt: seq * 1_000 + i,
          editedAt: null,
        });
        task.counts.comments += 1;
      }
      if (spec.expanded) expandedTaskIds.push(id);
      tasks.push(task);
      const made = children.map((child, i) => add(child, keys[i] as string, task, groupId));
      task.counts.subtasks = made.length;
      task.counts.subtasksDone = made.filter((t) => t.completedAt !== null).length;
      return task;
    };
    for (const [index, titles] of Object.entries(options.tasks ?? {})) {
      const group = groups[Number(index)];
      if (!group) continue;
      const positions = generateNKeysBetween(null, null, titles.length);
      for (const [i, entry] of titles.entries()) add(entry, positions[i] as string, null, group.id);
    }
    return normalizeMyList(orgId, { groups, tasks, expandedTaskIds, serverTime: 0 });
  };

  const stateOf = (orgId: string) => {
    let state = orgs.get(orgId);
    if (!state) {
      state = seed(orgId);
      orgs.set(orgId, state);
    }
    return state;
  };

  const wait = () =>
    latencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve();

  const withDescription = (task: Task | undefined): Task | undefined =>
    task ? { ...task, description: descriptions.get(task.id) ?? '' } : undefined;

  /** The 422s of 05 §4.3 that the reducers leave to the server. */
  const checkParent = (state: ListState, id: string | null, parentId: string) => {
    if (!state.tasks[parentId]) throw new ApiError('not_found', 404);
    if (id && (id === parentId || descendantIds(state, id).includes(parentId))) {
      throw new ApiError('subtask_cycle', 422);
    }
    const below = id ? subtreeHeight(state, id) : 0;
    if (depthOf(state, parentId) + 1 + below > SUBTASK_DEPTH_MAX) {
      throw new ApiError('subtask_depth', 422);
    }
  };

  /** 06 §2.3 my-list: placed tasks, everything below them, and the ancestors of orphans. */
  const myListTasks = (state: ListState): Task[] => {
    const included = new Set<string>();
    const placed = Object.values(state.tasks).filter((t) => t.placement !== null);
    for (const task of placed) {
      included.add(task.id);
      for (const id of descendantIds(state, task.id)) included.add(id);
      for (const ancestor of ancestorsOf(state, task.id)) included.add(ancestor.id);
    }
    return Object.values(state.tasks).filter((t) => included.has(t.id));
  };

  const commentOf = (id: string) => {
    const comment = comments.get(id);
    if (!comment) throw new ApiError('not_found', 404);
    return comment;
  };
  const visible = ({ deleted: _deleted, ...comment }: Comment & { deleted?: boolean }) => comment;
  const findTask = (taskId: string) => {
    for (const state of orgs.values()) if (state.tasks[taskId]) return state.tasks[taskId];
    return undefined;
  };

  return {
    state: stateOf,
    tags: tagsOf,
    descriptions,
    comments,
    reminders,
    failNext: (status, code = `http_${status}`) => {
      failure = new ApiError(code, status);
    },
    fetchTags: async (orgId) => {
      await wait();
      return structuredClone(tagsOf(orgId));
    },
    fetchTask: async (taskId) => {
      await wait();
      for (const state of orgs.values()) {
        const task = withDescription(state.tasks[taskId]);
        if (!task) continue;
        const detail: TaskDetail = {
          ...task,
          description: task.description ?? '',
          subtasks: childrenOf(state, taskId),
          parentChain: ancestorsOf(state, taskId)
            .reverse()
            .map((t) => ({ id: t.id, title: t.title })),
          followers: followers.get(taskId) ?? [],
          attachments: [],
          reminders: [...(reminders.get(taskId) ?? [])].sort(
            (a, b) => (a.fireAt ?? Number.MAX_SAFE_INTEGER) - (b.fireAt ?? Number.MAX_SAFE_INTEGER),
          ),
        };
        return structuredClone(detail);
      }
      throw new ApiError('not_found', 404);
    },
    fetchMyList: async (orgId) => {
      await wait();
      const state = stateOf(orgId);
      const list: MyList = {
        groups: Object.values(state.groups),
        tasks: myListTasks(state),
        expandedTaskIds: [...state.expandedTaskIds],
        serverTime: Date.now(),
      };
      return structuredClone(list);
    },
    fetchTasks: async (orgId, query) => {
      await wait();
      const state = stateOf(orgId);
      const all = Object.values(state.tasks);
      const byId = new Map(all.map((t) => [t.id, t]));
      const completed = query.completed ?? 'false';
      const assignees = query.assignee === undefined ? [] : [query.assignee].flat();
      const tags = query.tag === undefined ? [] : [query.tag].flat();
      const everyone = query.view === 'everyone';
      const rows = all
        .filter((t) => (everyone ? isRow(t, byId) : t.placement !== null))
        .filter((t) => completed === 'any' || (t.completedAt !== null) === (completed === 'true'))
        .filter(
          (t) =>
            assignees.length === 0 ||
            assignees.some((a) =>
              a === 'any'
                ? true
                : a === 'none'
                  ? t.assigneeId === null
                  : t.assigneeId === (a === 'me' ? userId : a),
            ),
        )
        .filter(
          (t) => query.hasDue === undefined || (t.dueDate !== null) === (query.hasDue === 'true'),
        )
        .filter((t) => tags.every((tag) => t.tagIds.includes(tag)))
        .sort(compareRows);
      const offset = Number(query.cursor ?? 0);
      const limit = query.limit ?? 50;
      const items = rows.slice(offset, offset + limit);
      const next = offset + limit < rows.length ? String(offset + limit) : null;
      return structuredClone({ items, nextCursor: next } satisfies TaskPage);
    },
    fetchActivity: async (taskId, query) => {
      await wait();
      const task = findTask(taskId);
      if (!task) throw new ApiError('not_found', 404);
      const items: ActivityItem[] = [
        ...(query.filter === 'comments'
          ? []
          : [
              {
                kind: 'activity' as const,
                activity: {
                  id: `${taskId}-created`,
                  taskId,
                  actorId: task.createdBy,
                  via: 'web' as const,
                  createdAt: task.createdAt,
                  type: 'created' as const,
                  data: {},
                },
              },
            ]),
        ...[...comments.values()]
          .filter((c) => c.taskId === taskId && !c.deleted)
          .map((c) => ({ kind: 'comment' as const, comment: visible(c) })),
      ].sort(
        (a, b) =>
          (a.kind === 'comment' ? a.comment.createdAt : a.activity.createdAt) -
          (b.kind === 'comment' ? b.comment.createdAt : b.activity.createdAt),
      );
      // Pages go back in time: the cursor counts the items already returned from the end.
      const skip = Number(query.cursor ?? 0);
      const limit = query.limit ?? 50;
      const end = items.length - skip;
      const start = Math.max(0, end - limit);
      const page: ActivityPage = {
        items: items.slice(start, end),
        nextCursor: start > 0 ? String(skip + (end - start)) : null,
      };
      return structuredClone(page);
    },
    send: async (op, orgId) => {
      await wait();
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      let before = stateOf(orgId);
      if (op.kind === 'task.create' && op.payload.parentId) {
        checkParent(before, null, op.payload.parentId);
      }
      if (op.kind === 'task.patch' && op.payload.parentId) {
        checkParent(before, op.entityId, op.payload.parentId);
      }
      if (op.kind === 'tag.create') {
        const name = op.payload.name.toLocaleLowerCase();
        const existing = tagsOf(orgId).find((t) => t.name.toLocaleLowerCase() === name);
        if (existing && existing.id !== op.payload.id) {
          throw new ApiError('tag_name_taken', 409, undefined, { existingId: existing.id });
        }
        return structuredClone(tagNamed(orgId, op.payload.name, op.payload.id, op.payload.color));
      }
      if (op.kind === 'task.create' && op.payload.tagNames?.length) {
        const ids = op.payload.tagNames.map((name) => tagNamed(orgId, name).id);
        const merged = [...new Set([...(op.payload.tagIds ?? []), ...ids])];
        op = { ...op, payload: { ...op.payload, tagIds: merged } };
      }
      if (op.kind === 'task.create' && op.payload.description !== undefined) {
        descriptions.set(op.entityId, op.payload.description);
      }
      if (op.kind === 'task.patch' && op.payload.description !== undefined) {
        descriptions.set(op.entityId, op.payload.description);
      }
      const assignee =
        op.kind === 'task.create' || op.kind === 'task.patch'
          ? op.payload.assigneeId
          : op.kind === 'task.bulk' && op.payload.op === 'assign'
            ? op.payload.args.assigneeId
            : undefined;
      if (assignee !== undefined && assignee !== null && !memberIds.has(assignee)) {
        throw new ApiError('validation_failed', 422);
      }
      switch (op.kind) {
        case 'task.follow': {
          if (!before.tasks[op.entityId]) throw new ApiError('not_found', 404);
          const current = (followers.get(op.entityId) ?? []).filter((id) => id !== userId);
          followers.set(op.entityId, op.payload.following ? [...current, userId] : current);
          return { followers: [...(followers.get(op.entityId) ?? [])] };
        }
        case 'comment.create': {
          if (!before.tasks[op.entityId]) throw new ApiError('not_found', 404);
          const existing = comments.get(op.payload.id);
          if (existing) {
            if (existing.body !== op.payload.body) throw new ApiError('id_conflict', 409);
            return structuredClone(visible(existing));
          }
          const comment: Comment = {
            id: op.payload.id,
            taskId: op.entityId,
            authorId: userId,
            body: op.payload.body,
            createdAt: op.editTime,
            editedAt: null,
          };
          comments.set(comment.id, comment);
          break;
        }
        case 'comment.patch':
        case 'comment.delete':
        case 'comment.restore': {
          const comment = commentOf(op.entityId);
          if (comment.authorId !== userId) throw new ApiError('forbidden', 403);
          if (op.kind === 'comment.patch') {
            if (comment.deleted) throw new ApiError('conflict_deleted', 410);
            comments.set(comment.id, { ...comment, body: op.payload.body, editedAt: op.editTime });
            return structuredClone(visible(commentOf(op.entityId)));
          }
          // Repeats are no-ops, and change no counts.
          if (Boolean(comment.deleted) === (op.kind === 'comment.delete')) {
            return op.kind === 'comment.delete' ? undefined : structuredClone(visible(comment));
          }
          comments.set(comment.id, { ...comment, deleted: op.kind === 'comment.delete' });
          break;
        }
        case 'reminder.create': {
          const task = before.tasks[op.taskId];
          if (!task) throw new ApiError('not_found', 404);
          const { id, ...spec } = op.payload;
          if (!('at' in spec) && !task.dueDate) throw new ApiError('reminder_needs_due', 422);
          if ((reminders.get(task.id)?.length ?? 0) >= 5) {
            throw new ApiError('too_many_reminders', 409);
          }
          const reminder = addReminder(task, spec as ReminderSpec, id);
          orgs.set(orgId, {
            ...before,
            tasks: { ...before.tasks, [task.id]: { ...task, nextReminderAt: bellOf(task) } },
          });
          return structuredClone(reminder);
        }
        case 'reminder.delete': {
          const task = before.tasks[op.taskId];
          if (!task) throw new ApiError('not_found', 404);
          reminders.set(
            task.id,
            (reminders.get(task.id) ?? []).filter((r) => r.id !== op.entityId),
          );
          orgs.set(orgId, {
            ...before,
            tasks: { ...before.tasks, [task.id]: { ...task, nextReminderAt: bellOf(task) } },
          });
          return undefined;
        }
        case 'task.skip':
          if (!before.tasks[op.entityId]?.recurrence) throw new ApiError('not_recurring', 422);
          break;
        default:
          break;
      }
      if (op.kind === 'group.delete') {
        const live = tasksInGroup(before, op.entityId).length;
        if (normalGroups(before).length <= 1) throw new ApiError('last_group', 409);
        if (live > 0 && !op.payload.moveTasksTo && !op.payload.deleteTasks) {
          throw new ApiError('group_not_empty', 409);
        }
      }
      let after = applyOp(before, op, {
        userId,
        now: op.editTime,
        timezone: owner.timezone,
        allDayReminderTime: owner.allDayReminderTime,
      });
      // P10: the next instance carries the relative reminders (FR-REM-5); every bell follows
      // its task's due unit, like the server's `fire_at` (ADR 0049 §2.1).
      const nextId =
        op.kind === 'task.complete' || op.kind === 'task.skip' ? op.payload.nextId : undefined;
      const spawned = nextId ? after.tasks[nextId] : undefined;
      if (spawned && !before.tasks[nextId as string]) {
        for (const r of reminders.get(op.entityId) ?? []) {
          if (r.kind === 'relative' && r.offsetMinutes !== null) {
            addReminder(spawned, { offsetMinutes: r.offsetMinutes });
          }
        }
      }
      if (op.kind === 'task.create' && op.payload.reminders?.length) {
        const created = after.tasks[op.entityId];
        if (created) for (const spec of op.payload.reminders) addReminder(created, spec);
      }
      for (const [id, task] of Object.entries(after.tasks)) {
        if (!reminders.has(id)) continue;
        const bell = bellOf(task);
        if (bell !== (task.nextReminderAt ?? null)) {
          after = { ...after, tasks: { ...after.tasks, [id]: { ...task, nextReminderAt: bell } } };
        }
      }
      if (op.kind === 'task.duplicate') {
        // The server gives copied subtasks ids of its own; replace the derived ones.
        const copy = after.tasks[op.payload.id];
        if (copy) {
          before = after;
          const desc = descriptions.get(op.entityId);
          if (desc) descriptions.set(copy.id, desc);
          for (const derived of descendantIds(after, copy.id)) {
            const real = uuidv7();
            const task = after.tasks[derived] as Task;
            const tasks = { ...after.tasks, [real]: { ...task, id: real } };
            delete tasks[derived];
            for (const t of Object.values(tasks)) {
              if (t.parentId === derived) tasks[t.id] = { ...t, parentId: real };
            }
            after = { ...after, tasks };
          }
        }
      }
      for (const task of Object.values(after.tasks)) {
        if (task.seq === null) {
          seq += 1;
          after = { ...after, tasks: { ...after.tasks, [task.id]: { ...task, seq } } };
        }
      }
      orgs.set(orgId, after);
      const task = after.tasks[op.entityId];
      switch (op.kind) {
        case 'task.create':
        case 'task.restore':
          return structuredClone(task);
        case 'task.duplicate':
          return structuredClone(after.tasks[op.payload.id]);
        case 'task.reorder':
          return { subtaskPosition: task?.subtaskPosition };
        case 'task.expanded':
        case 'task.addTag':
        case 'task.removeTag':
          return undefined;
        case 'task.patch':
          return { task: structuredClone(task), ignoredFields: [] };
        case 'task.complete': {
          const next = op.payload.nextId ? after.tasks[op.payload.nextId] : undefined;
          return { task: structuredClone(task), ...(next ? { next: structuredClone(next) } : {}) };
        }
        case 'task.skip': {
          const next = op.payload.nextId ? after.tasks[op.payload.nextId] : undefined;
          return { next: next ? structuredClone(next) : null };
        }

        case 'task.move':
          return { placement: task?.placement };
        case 'task.bulk':
          return { results: op.payload.ids.map((id) => ({ id, ok: true })) };
        case 'group.create':
          return {
            group: after.groups[op.entityId],
            moved: tasksInGroup(after, op.entityId).map((t) => ({
              taskId: t.id,
              groupId: op.entityId,
              position: t.placement?.position,
            })),
          };
        case 'group.patch':
        case 'group.restore':
          return after.groups[op.entityId];
        case 'group.move':
          return { position: after.groups[op.entityId]?.position };
        case 'task.delete':
        case 'group.delete':
        case 'comment.delete':
          return undefined;
        case 'comment.create':
          return structuredClone(visible(commentOf(op.payload.id)));
        case 'comment.restore':
          return structuredClone(visible(commentOf(op.entityId)));
      }
    },
  };
}
