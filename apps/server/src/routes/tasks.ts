import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { pageQuerySchema, taskQuerySchema } from '@rooster/core/schemas';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import {
  AUTHED,
  actorOf,
  body,
  idParam,
  json,
  metaOf,
  optionalBody,
  orgIdParam,
  problems,
} from './common.ts';
import {
  BulkOpSchema,
  BulkResultSchema,
  SubtaskReorderResultSchema,
  SubtaskReorderSchema,
  TaskCompleteResultSchema,
  TaskCompleteSchema,
  TaskCreateSchema,
  TaskDetailSchema,
  TaskDuplicateSchema,
  TaskMoveResultSchema,
  TaskMoveSchema,
  TaskPageSchema,
  TaskPatchResultSchema,
  TaskPatchSchema,
  TaskSchema,
  TrashPageSchema,
} from './schemas.ts';

const tags = ['tasks'];
const orgParams = z.object({ orgId: orgIdParam });
const taskParams = z.object({ id: idParam('id', 'Task ID') });

const queryTasks = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/tasks',
  tags,
  operationId: 'queryTasks',
  summary: 'Query tasks (CLI, MCP): my list, a due-date view or everyone’s tasks, paged',
  description:
    'The general query for the CLI, MCP and Everyone’s tasks. `view=my` (default) lists my list in order; `today`, `week`, `overdue` and `nodate` cover tasks assigned to me, evaluated in my timezone; `everyone` lists every task of a shared org by due date (`409 personal_org` in a personal org). Filters combine: `assignee` (repeatable, OR), `tag` (repeatable, AND; ID or name), `hasDue`, `dueFrom`/`dueTo`, `groupId`, `completed` (default `false`) and `q` (the search grammar). Paged with `limit` and `cursor`.',
  request: { params: orgParams, query: taskQuerySchema },
  responses: {
    200: json(TaskPageSchema, 'A page of tasks'),
    ...problems(401, 404, 422, 'personal_org'),
  },
});

const createTask = createRoute({
  method: 'post',
  path: '/api/v1/orgs/{orgId}/tasks',
  tags,
  operationId: 'createTask',
  summary: 'Create a task assigned to me, placed in my list',
  description:
    'Placed in `groupId` (default: the Inbox) at the `afterId`/`beforeId` intent. Without any intent it goes to the top of the Inbox, or to the end of a named group. With `parentId` it is a subtask (`422 invalid_parent`, `subtask_depth`; `410 conflict_deleted` for a deleted parent). Assigning another member puts it at the top of their Inbox instead. A repeated create with the same `id` and content returns the task; other content is `409 id_conflict`. `parse: true` reads a trailing `>Group` token and a date phrase from the title.',
  request: { params: orgParams, body: body(TaskCreateSchema) },
  responses: {
    201: json(TaskSchema, 'The task'),
    ...problems(
      ...AUTHED,
      404,
      'id_conflict',
      'conflict_deleted',
      'invalid_parent',
      'subtask_depth',
    ),
  },
});

const patchTask = createRoute({
  method: 'patch',
  path: '/api/v1/tasks/{id}',
  tags,
  operationId: 'updateTask',
  summary: 'Update fields (per-field last write wins; skipped fields in ignoredFields)',
  description:
    'Partial update of a task any member can see. Each field is last-write-wins on `X-Rooster-Edit-Time`: a field whose stored edit is newer is skipped and named in `ignoredFields` (the response is still `200`). The due unit (date, time, timezone, start date) is one field. Re-parenting checks cycles and depth (`422 subtask_cycle`, `subtask_depth`). A deleted task is `410 conflict_deleted`; restore it first.',
  request: { params: taskParams, body: body(TaskPatchSchema) },
  responses: {
    200: json(TaskPatchResultSchema, 'The task'),
    ...problems(
      ...AUTHED,
      404,
      'conflict_deleted',
      'invalid_parent',
      'subtask_cycle',
      'subtask_depth',
    ),
  },
});

const moveTask = createRoute({
  method: 'post',
  path: '/api/v1/tasks/{id}/move',
  tags,
  operationId: 'moveTask',
  summary: 'Move the task within my list; 404 if it is not in my list',
  description:
    'Changes only MY placement (groups are personal): `groupId` is one of my groups and the intent IDs are tasks in it. Intent IDs from elsewhere fall back to the end of the group; the actual placement is returned. Last write wins on my placement clock.',
  request: { params: taskParams, body: body(TaskMoveSchema) },
  responses: {
    200: json(TaskMoveResultSchema, 'The actual placement'),
    ...problems(...AUTHED, 404, 'conflict_deleted'),
  },
});

const completeTask = createRoute({
  method: 'post',
  path: '/api/v1/tasks/{id}/complete',
  tags,
  operationId: 'completeTask',
  summary: 'Complete or reopen a task; it keeps its place in the list',
  description:
    'Last write wins on the `completed` clock; completing a completed task changes nothing. Followers are notified. `next` will carry the next instance of a recurring task.',
  request: { params: taskParams, body: body(TaskCompleteSchema) },
  responses: {
    200: json(TaskCompleteResultSchema, 'The task'),
    ...problems(...AUTHED, 404, 'conflict_deleted'),
  },
});

const deleteTask = createRoute({
  method: 'delete',
  path: '/api/v1/tasks/{id}',
  tags,
  operationId: 'deleteTask',
  summary: 'Move a task (and its subtasks) to Trash',
  description:
    'A soft delete for every member: the task and its subtasks go to the org’s Trash, from where `POST /tasks/{id}/restore` brings them back. Deleting a deleted task is a no-op.',
  request: { params: taskParams },
  responses: { 204: { description: 'Deleted' }, ...problems(...AUTHED, 404) },
});

const restoreTask = createRoute({
  method: 'post',
  path: '/api/v1/tasks/{id}/restore',
  tags,
  operationId: 'restoreTask',
  summary: 'Undo a delete, or restore from Trash, to the same place in the list',
  description:
    'Restores the task with the subtasks deleted together with it; placements come back where they were (to the top of the Inbox when their group is gone).',
  request: { params: taskParams },
  responses: { 200: json(TaskSchema, 'The task'), ...problems(...AUTHED, 404) },
});

const deletePermanently = createRoute({
  method: 'delete',
  path: '/api/v1/tasks/{id}/permanent',
  tags,
  operationId: 'deleteTaskPermanently',
  summary: 'Delete a task in Trash for good',
  description:
    'Only for a task in Trash (`409 not_in_trash`): removes it with its subtasks and placements. Cannot be undone.',
  request: { params: taskParams },
  responses: { 204: { description: 'Deleted' }, ...problems(...AUTHED, 404, 'not_in_trash') },
});

const bulk = createRoute({
  method: 'post',
  path: '/api/v1/tasks/bulk',
  tags,
  operationId: 'bulkTasks',
  summary: 'Apply one operation to up to 200 tasks (atomic per task)',
  description:
    'Each task succeeds or fails on its own, with the result it would get from the single-task route; a task I cannot see is `{ok: false, code: "not_found"}`. The whole request is `200` unless the body is invalid.',
  request: { body: body(BulkOpSchema) },
  responses: { 200: json(BulkResultSchema, 'Per-task results'), ...problems(...AUTHED) },
});

const getTask = createRoute({
  method: 'get',
  path: '/api/v1/tasks/{id}',
  tags,
  operationId: 'getTask',
  summary: 'The full task: description, direct subtasks in order and the parent chain',
  description:
    '`parentChain` runs from the root down to the direct parent. A task in Trash is returned with `deletedAt`.',
  request: { params: taskParams },
  responses: { 200: json(TaskDetailSchema, 'The task'), ...problems(401, 404) },
});

const reorderSubtask = createRoute({
  method: 'post',
  path: '/api/v1/tasks/{id}/reorder',
  tags,
  operationId: 'reorderSubtask',
  summary: 'Move a subtask among its siblings; the server computes the key',
  description:
    'Last write wins on the `parent` clock: a newer edit keeps the current position, which is returned. A top-level task is `409 not_subtask`.',
  request: { params: taskParams, body: body(SubtaskReorderSchema) },
  responses: {
    200: json(SubtaskReorderResultSchema, 'The actual subtask position'),
    ...problems(...AUTHED, 404, 'not_subtask', 'conflict_deleted'),
  },
});

const duplicateTask = createRoute({
  method: 'post',
  path: '/api/v1/tasks/{id}/duplicate',
  tags,
  operationId: 'duplicateTask',
  summary: 'Duplicate a task (and its subtasks) directly below the original',
  description:
    'Copies title, description, dates and tags; with `includeSubtasks` (default) every live subtask recursively, reopened. The response is the new top task.',
  request: { params: taskParams, body: optionalBody(TaskDuplicateSchema) },
  responses: {
    201: json(TaskSchema, 'The copy'),
    ...problems(...AUTHED, 404, 'id_conflict', 'conflict_deleted'),
  },
});

const expandTask = createRoute({
  method: 'put',
  path: '/api/v1/tasks/{id}/expanded',
  tags,
  operationId: 'expandTask',
  summary: 'Remember that I expanded this parent row (idempotent)',
  description: 'Per user: shows up in `expandedTaskIds` of my list on every device.',
  request: { params: taskParams },
  responses: {
    204: { description: 'Expanded' },
    ...problems(...AUTHED, 404, 'conflict_deleted'),
  },
});

const collapseTask = createRoute({
  method: 'delete',
  path: '/api/v1/tasks/{id}/expanded',
  tags,
  operationId: 'collapseTask',
  summary: 'Forget my expansion of this parent row (idempotent)',
  description: 'The counterpart of `PUT`; collapsing a row that is not expanded is fine.',
  request: { params: taskParams },
  responses: { 204: { description: 'Collapsed' }, ...problems(...AUTHED, 404) },
});

const listTrash = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/trash',
  tags,
  operationId: 'listTrash',
  summary: 'Deleted tasks of an org, most recently deleted first',
  description:
    'Deleted tasks of the org with `deletedAt` and `deletedBy`, paged with `limit` and `cursor`. A retention job empties old Trash.',
  request: { params: orgParams, query: pageQuerySchema },
  responses: { 200: json(TrashPageSchema, 'A page of Trash'), ...problems(401, 404, 422) },
});

export function registerTaskRoutes(app: OpenAPIHono<AppEnv>, { tasks }: Services): void {
  app.openapi(queryTasks, (c) =>
    c.json(tasks.query(actorOf(c), c.req.valid('param').orgId, c.req.valid('query')), 200),
  );
  app.openapi(createTask, (c) =>
    c.json(
      tasks.create(actorOf(c), c.req.valid('param').orgId, c.req.valid('json'), metaOf(c)),
      201,
    ),
  );
  app.openapi(patchTask, (c) =>
    c.json(tasks.patch(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)), 200),
  );
  app.openapi(moveTask, (c) =>
    c.json(tasks.move(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)), 200),
  );
  app.openapi(completeTask, (c) =>
    c.json(
      tasks.complete(actorOf(c), c.req.valid('param').id, c.req.valid('json').completed, metaOf(c)),
      200,
    ),
  );
  app.openapi(deleteTask, (c) => {
    tasks.remove(actorOf(c), c.req.valid('param').id, metaOf(c));
    return c.body(null, 204);
  });
  app.openapi(restoreTask, (c) =>
    c.json(tasks.restore(actorOf(c), c.req.valid('param').id, metaOf(c)), 200),
  );
  app.openapi(deletePermanently, (c) => {
    tasks.removePermanently(actorOf(c), c.req.valid('param').id, metaOf(c));
    return c.body(null, 204);
  });
  app.openapi(bulk, (c) => c.json(tasks.bulk(actorOf(c), c.req.valid('json'), metaOf(c)), 200));
  app.openapi(getTask, (c) => c.json(tasks.detail(actorOf(c), c.req.valid('param').id), 200));
  app.openapi(reorderSubtask, (c) =>
    c.json(tasks.reorder(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)), 200),
  );
  app.openapi(duplicateTask, (c) =>
    c.json(
      tasks.duplicate(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)),
      201,
    ),
  );
  app.openapi(expandTask, (c) => {
    tasks.setExpanded(actorOf(c), c.req.valid('param').id, true);
    return c.body(null, 204);
  });
  app.openapi(collapseTask, (c) => {
    tasks.setExpanded(actorOf(c), c.req.valid('param').id, false);
    return c.body(null, 204);
  });
  app.openapi(listTrash, (c) =>
    c.json(tasks.trash(actorOf(c), c.req.valid('param').orgId, c.req.valid('query')), 200),
  );
}
