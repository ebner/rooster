import { uuidv7 } from '@rooster/core/ids';
import { generateNKeysBetween } from '@rooster/core/ordering';
import {
  applyOp,
  type ListState,
  normalGroups,
  normalizeMyList,
  tasksInGroup,
} from '@rooster/core/reducers';
import type { Group, MyList, Task } from '@rooster/core/schemas';
import { ApiError } from '../errors';
import type { ListTransport } from './transport';

export type FixtureTask =
  | string
  | { title: string; dueDate?: string; dueTime?: string; dueTz?: string; completed?: boolean };

export interface FixtureOptions {
  userId: string;
  /** Default group names, Inbox first (the server names them in the user's language). */
  groupNames?: readonly [inbox: string, ...rest: string[]];
  /** Demo tasks per group, by index (0 = the Inbox). */
  tasks?: Readonly<Record<number, readonly FixtureTask[]>>;
  /** Simulated round trip. */
  latencyMs?: number;
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
} {
  const { userId, latencyMs = 0 } = options;
  const orgs = new Map<string, ListState>();
  let seq = 0;
  let failure: ApiError | null = null;

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
    for (const [index, titles] of Object.entries(options.tasks ?? {})) {
      const group = groups[Number(index)];
      if (!group) continue;
      const positions = generateNKeysBetween(null, null, titles.length);
      titles.forEach((entry, i) => {
        const spec = typeof entry === 'string' ? { title: entry } : entry;
        seq += 1;
        tasks.push({
          id: uuidv7(),
          orgId,
          seq,
          parentId: null,
          subtaskPosition: null,
          title: spec.title,
          assigneeId: userId,
          createdBy: userId,
          dueDate: spec.dueDate ?? null,
          dueTime: spec.dueTime ?? null,
          dueTz: spec.dueTz ?? null,
          completedAt: spec.completed ? 1 : null,
          counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
          placement: { groupId: group.id, position: positions[i] as string },
          createdAt: 0,
          updatedAt: 0,
        });
      });
    }
    return normalizeMyList(orgId, { groups, tasks, expandedTaskIds: [], serverTime: 0 });
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

  return {
    state: stateOf,
    failNext: (status, code = `http_${status}`) => {
      failure = new ApiError(code, status);
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
      const before = stateOf(orgId);
      if (op.kind === 'group.delete') {
        const live = tasksInGroup(before, op.entityId).length;
        if (normalGroups(before).length <= 1) throw new ApiError('last_group', 409);
        if (live > 0 && !op.payload.moveTasksTo && !op.payload.deleteTasks) {
          throw new ApiError('group_not_empty', 409);
        }
      }
      let after = applyOp(before, op, { userId, now: op.editTime });
      if (op.kind === 'task.create') {
        const task = after.tasks[op.entityId];
        if (task && task.seq === null) {
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
