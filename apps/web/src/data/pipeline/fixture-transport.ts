import { uuidv7 } from '@rooster/core/ids';
import { generateNKeysBetween } from '@rooster/core/ordering';
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
import type { Group, MyList, Tag, Task, TaskDetail } from '@rooster/core/schemas';
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
} {
  const { userId, latencyMs = 0 } = options;
  const orgs = new Map<string, ListState>();
  const tagsByOrg = new Map<string, Tag[]>();
  const descriptions = new Map<string, string>();
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
      parent: { id: string } | null,
      groupId: string,
    ): Task => {
      const spec = typeof entry === 'string' ? { title: entry } : entry;
      seq += 1;
      const id = uuidv7();
      const children = spec.subtasks ?? [];
      const keys = generateNKeysBetween(null, null, children.length);
      const task: Task = {
        id,
        orgId,
        seq,
        parentId: parent?.id ?? null,
        subtaskPosition: parent ? position : null,
        title: spec.title,
        assigneeId: userId,
        createdBy: userId,
        dueDate: spec.dueDate ?? null,
        dueTime: spec.dueTime ?? null,
        dueTz: spec.dueTz ?? null,
        startDate: spec.startDate ?? null,
        tagIds: (spec.tags ?? []).map((name) => tagNamed(orgId, name).id),
        completedAt: spec.completed ? 1 : null,
        counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
        placement: parent ? null : { groupId, position },
        createdAt: 0,
        updatedAt: 0,
      };
      if (spec.description) descriptions.set(id, spec.description);
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

  return {
    state: stateOf,
    tags: tagsOf,
    descriptions,
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
        tasks: Object.values(state.tasks),
        expandedTaskIds: [...state.expandedTaskIds],
        serverTime: Date.now(),
      };
      return structuredClone(list);
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
      if (op.kind === 'group.delete') {
        const live = tasksInGroup(before, op.entityId).length;
        if (normalGroups(before).length <= 1) throw new ApiError('last_group', 409);
        if (live > 0 && !op.payload.moveTasksTo && !op.payload.deleteTasks) {
          throw new ApiError('group_not_empty', 409);
        }
      }
      let after = applyOp(before, op, { userId, now: op.editTime });
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
        case 'task.complete':
          return { task: structuredClone(task) };
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
          return undefined;
      }
    },
  };
}
