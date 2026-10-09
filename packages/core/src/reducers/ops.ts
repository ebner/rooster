import type { CommentPatch } from '../schemas/collab.ts';
import type {
  BulkOp,
  GroupCreate,
  GroupDelete,
  GroupMove,
  GroupPatch,
  SubtaskReorder,
  TaskComplete,
  TaskCreate,
  TaskMove,
  TaskPatch,
} from '../schemas/list.ts';
import type { TagCreate } from '../schemas/tags.ts';

type Empty = Record<string, never>;

/**
 * The create body as the web client sends it: always with a client id, and a target group for
 * a top-level task (subtasks set `parentId` instead; their intents name siblings).
 */
export type TaskCreateBody = TaskCreate & { id: string };
export type GroupCreateBody = GroupCreate & { id: string };
/** POST /tasks/:id/duplicate with the copy's client id. */
export type TaskDuplicateBody = { id: string; includeSubtasks: boolean };
export type TagCreateBody = TagCreate & { id: string };
/** P6. POST /tasks/:taskId/comments with the comment's client id. */
export type CommentCreateBody = { id: string; body: string };

/**
 * One list mutation, before the pipeline stamps it (04 §6.2). Each kind is exactly one HTTP
 * request; `payload` is the request body, except for `task.expanded` and `task.follow` (PUT or
 * DELETE) and `task.addTag`/`task.removeTag` (the tag id is part of the path). `entityId` is
 * the task, group, tag or comment id (the org id for bulk ops); comment ops on an existing
 * comment also carry its `taskId`, which locates the `['activity', taskId]` cache.
 */
export type ListOpSpec =
  | { kind: 'task.create'; entityId: string; payload: TaskCreateBody }
  | { kind: 'task.patch'; entityId: string; payload: TaskPatch }
  | { kind: 'task.complete'; entityId: string; payload: TaskComplete }
  | { kind: 'task.delete'; entityId: string; payload: Empty }
  | { kind: 'task.restore'; entityId: string; payload: Empty }
  | { kind: 'task.move'; entityId: string; payload: TaskMove }
  | { kind: 'task.bulk'; entityId: string; payload: BulkOp }
  | { kind: 'task.reorder'; entityId: string; payload: SubtaskReorder }
  | { kind: 'task.duplicate'; entityId: string; payload: TaskDuplicateBody }
  | { kind: 'task.expanded'; entityId: string; payload: { expanded: boolean } }
  | { kind: 'task.addTag'; entityId: string; payload: { tagId: string } }
  | { kind: 'task.removeTag'; entityId: string; payload: { tagId: string } }
  | { kind: 'task.follow'; entityId: string; payload: { following: boolean } }
  | { kind: 'comment.create'; entityId: string; payload: CommentCreateBody }
  | { kind: 'comment.patch'; entityId: string; taskId: string; payload: CommentPatch }
  | { kind: 'comment.delete'; entityId: string; taskId: string; payload: Empty }
  | { kind: 'comment.restore'; entityId: string; taskId: string; payload: Empty }
  | { kind: 'tag.create'; entityId: string; payload: TagCreateBody }
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
  reorderSubtask: (id: string, payload: SubtaskReorder): ListOpSpec => ({
    kind: 'task.reorder',
    entityId: id,
    payload,
  }),
  duplicateTask: (id: string, copyId: string, includeSubtasks = true): ListOpSpec => ({
    kind: 'task.duplicate',
    entityId: id,
    payload: { id: copyId, includeSubtasks },
  }),
  setExpanded: (id: string, expanded: boolean): ListOpSpec => ({
    kind: 'task.expanded',
    entityId: id,
    payload: { expanded },
  }),
  addTag: (id: string, tagId: string): ListOpSpec => ({
    kind: 'task.addTag',
    entityId: id,
    payload: { tagId },
  }),
  removeTag: (id: string, tagId: string): ListOpSpec => ({
    kind: 'task.removeTag',
    entityId: id,
    payload: { tagId },
  }),
  /** P6. PUT (follow) or DELETE (unfollow = muted) /tasks/:id/followers/me. */
  setFollowing: (taskId: string, following: boolean): ListOpSpec => ({
    kind: 'task.follow',
    entityId: taskId,
    payload: { following },
  }),
  /** P6. `entityId` is the TASK (the comment id is in the payload, as the route has it). */
  createComment: (taskId: string, payload: CommentCreateBody): ListOpSpec => ({
    kind: 'comment.create',
    entityId: taskId,
    payload,
  }),
  patchComment: (commentId: string, taskId: string, payload: CommentPatch): ListOpSpec => ({
    kind: 'comment.patch',
    entityId: commentId,
    taskId,
    payload,
  }),
  deleteComment: (commentId: string, taskId: string): ListOpSpec => ({
    kind: 'comment.delete',
    entityId: commentId,
    taskId,
    payload: {},
  }),
  restoreComment: (commentId: string, taskId: string): ListOpSpec => ({
    kind: 'comment.restore',
    entityId: commentId,
    taskId,
    payload: {},
  }),
  createTag: (payload: TagCreateBody): ListOpSpec => ({
    kind: 'tag.create',
    entityId: payload.id,
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
