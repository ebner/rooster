import type {
  BulkOp,
  GroupCreate,
  GroupDelete,
  GroupMove,
  GroupPatch,
  TaskComplete,
  TaskCreate,
  TaskMove,
  TaskPatch,
} from '../schemas/list.ts';

type Empty = Record<string, never>;

/** The create body as the web client sends it: always with a client id and a target group. */
export type TaskCreateBody = TaskCreate & { id: string; groupId: string };
export type GroupCreateBody = GroupCreate & { id: string };

/**
 * One list mutation, before the pipeline stamps it (04 §6.2). Each kind is exactly one HTTP
 * request; `payload` is the request body. `entityId` is the task or group id (the org id for
 * bulk ops).
 */
export type ListOpSpec =
  | { kind: 'task.create'; entityId: string; payload: TaskCreateBody }
  | { kind: 'task.patch'; entityId: string; payload: TaskPatch }
  | { kind: 'task.complete'; entityId: string; payload: TaskComplete }
  | { kind: 'task.delete'; entityId: string; payload: Empty }
  | { kind: 'task.restore'; entityId: string; payload: Empty }
  | { kind: 'task.move'; entityId: string; payload: TaskMove }
  | { kind: 'task.bulk'; entityId: string; payload: BulkOp }
  | { kind: 'group.create'; entityId: string; payload: GroupCreateBody }
  | { kind: 'group.patch'; entityId: string; payload: GroupPatch }
  | { kind: 'group.move'; entityId: string; payload: GroupMove }
  | { kind: 'group.delete'; entityId: string; payload: GroupDelete }
  | { kind: 'group.restore'; entityId: string; payload: Empty };

export type ListOpKind = ListOpSpec['kind'];

/** The final op shape (04 §6.2), shared with the P4 IndexedDB outbox. */
export type ListOp = ListOpSpec & {
  /** UUIDv7; doubles as the Idempotency-Key. */
  opId: string;
  /** ms epoch at the user's action (X-Rooster-Edit-Time). */
  editTime: number;
  clientId: string;
};

/** What the reducers need beyond the state: the acting user (creator and assignee). */
export interface ReducerContext {
  userId: string;
}

/** Constructors keep call sites short and payloads exactly the request bodies. */
export const listOps = {
  createTask: (payload: TaskCreateBody): ListOpSpec => ({
    kind: 'task.create',
    entityId: payload.id,
    payload,
  }),
  patchTask: (id: string, payload: TaskPatch): ListOpSpec => ({
    kind: 'task.patch',
    entityId: id,
    payload,
  }),
  completeTask: (id: string, completed: boolean): ListOpSpec => ({
    kind: 'task.complete',
    entityId: id,
    payload: { completed },
  }),
  deleteTask: (id: string): ListOpSpec => ({ kind: 'task.delete', entityId: id, payload: {} }),
  restoreTask: (id: string): ListOpSpec => ({ kind: 'task.restore', entityId: id, payload: {} }),
  moveTask: (id: string, payload: TaskMove): ListOpSpec => ({
    kind: 'task.move',
    entityId: id,
    payload,
  }),
  bulk: (orgId: string, payload: BulkOp): ListOpSpec => ({
    kind: 'task.bulk',
    entityId: orgId,
    payload,
  }),
  createGroup: (payload: GroupCreateBody): ListOpSpec => ({
    kind: 'group.create',
    entityId: payload.id,
    payload,
  }),
  patchGroup: (id: string, payload: GroupPatch): ListOpSpec => ({
    kind: 'group.patch',
    entityId: id,
    payload,
  }),
  moveGroup: (id: string, payload: GroupMove): ListOpSpec => ({
    kind: 'group.move',
    entityId: id,
    payload,
  }),
  deleteGroup: (id: string, payload: GroupDelete = {}): ListOpSpec => ({
    kind: 'group.delete',
    entityId: id,
    payload,
  }),
  restoreGroup: (id: string): ListOpSpec => ({ kind: 'group.restore', entityId: id, payload: {} }),
};
