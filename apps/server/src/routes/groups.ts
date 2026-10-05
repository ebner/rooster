import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { myListQuerySchema } from '@rooster/core/schemas';
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
  GroupCreateResultSchema,
  GroupCreateSchema,
  GroupDeleteSchema,
  GroupMoveResultSchema,
  GroupMoveSchema,
  GroupPatchSchema,
  GroupSchema,
  MyListSchema,
} from './schemas.ts';

const tags = ['list'];
const orgParams = z.object({ orgId: orgIdParam });
const groupParams = z.object({ id: idParam('id', 'Group ID') });

const getMyList = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/my-list',
  tags,
  operationId: 'getMyList',
  summary: 'My tasks in an org: groups (Inbox first) and every task placed in them',
  description:
    'Open tasks plus tasks completed at or after `completedSince` (ms epoch; default: 14 days ago).',
  request: { params: orgParams, query: myListQuerySchema },
  responses: { 200: json(MyListSchema, 'The list'), ...problems(401, 404, 422, 429) },
});

const createGroup = createRoute({
  method: 'post',
  path: '/api/v1/orgs/{orgId}/groups',
  tags,
  operationId: 'createGroup',
  summary: 'Create a group at a position, or split a group after a task (Tab+N)',
  description:
    'Without an intent the group goes to the end. With `splitAfterTaskId` it is inserted after that task’s group and the tasks below the task move into it; `moved` lists their placements.',
  request: { params: orgParams, body: body(GroupCreateSchema) },
  responses: {
    201: json(GroupCreateResultSchema, 'The new group'),
    ...problems(...AUTHED, 404, 409, 410),
  },
});

const patchGroup = createRoute({
  method: 'patch',
  path: '/api/v1/groups/{id}',
  tags,
  operationId: 'updateGroup',
  summary: 'Rename or collapse a group (per-field last write wins)',
  description: 'The Inbox cannot be renamed (`409 inbox_immutable`).',
  request: { params: groupParams, body: body(GroupPatchSchema) },
  responses: { 200: json(GroupSchema, 'The group'), ...problems(...AUTHED, 404, 409) },
});

const moveGroup = createRoute({
  method: 'post',
  path: '/api/v1/groups/{id}/move',
  tags,
  operationId: 'moveGroup',
  summary: 'Reorder a group; the server computes the position',
  request: { params: groupParams, body: body(GroupMoveSchema) },
  responses: {
    200: json(GroupMoveResultSchema, 'The actual position'),
    ...problems(...AUTHED, 404, 409),
  },
});

const deleteGroup = createRoute({
  method: 'delete',
  path: '/api/v1/groups/{id}',
  tags,
  operationId: 'deleteGroup',
  summary: 'Delete a group, moving or deleting its tasks',
  description:
    'A group with open tasks needs `moveTasksTo` or `deleteTasks` (`409 group_not_empty`). The last normal group cannot be deleted (`409 last_group`).',
  request: { params: groupParams, body: optionalBody(GroupDeleteSchema) },
  responses: { 204: { description: 'Deleted' }, ...problems(...AUTHED, 404, 409) },
});

const restoreGroup = createRoute({
  method: 'post',
  path: '/api/v1/groups/{id}/restore',
  tags,
  operationId: 'restoreGroup',
  summary: 'Undo a group delete, with the tasks deleted together with it',
  request: { params: groupParams },
  responses: { 200: json(GroupSchema, 'The restored group'), ...problems(...AUTHED, 404) },
});

export function registerGroupRoutes(app: OpenAPIHono<AppEnv>, { groups, tasks }: Services): void {
  app.openapi(getMyList, (c) =>
    c.json(
      tasks.myList(actorOf(c), c.req.valid('param').orgId, c.req.valid('query').completedSince),
      200,
    ),
  );
  app.openapi(createGroup, (c) =>
    c.json(
      groups.create(actorOf(c), c.req.valid('param').orgId, c.req.valid('json'), metaOf(c)),
      201,
    ),
  );
  app.openapi(patchGroup, (c) =>
    c.json(groups.update(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)), 200),
  );
  app.openapi(moveGroup, (c) =>
    c.json(groups.move(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)), 200),
  );
  app.openapi(deleteGroup, (c) => {
    groups.remove(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c));
    return c.body(null, 204);
  });
  app.openapi(restoreGroup, (c) =>
    c.json(groups.restore(actorOf(c), c.req.valid('param').id, metaOf(c)), 200),
  );
}
