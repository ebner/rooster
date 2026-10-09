import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, body, idParam, json, metaOf, orgIdParam, problems } from './common.ts';
import {
  TagCreateSchema,
  TagMergeSchema,
  TagPatchSchema,
  TagSchema,
  TaskSchema,
} from './schemas.ts';

const tags = ['tags'];
const orgParams = z.object({ orgId: orgIdParam });
const tagParams = z.object({ id: idParam('id', 'Tag ID') });
const taskTagParams = z.object({
  id: idParam('id', 'Task ID'),
  tagId: idParam('tagId', 'Tag ID'),
});

const listTags = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/tags',
  tags,
  operationId: 'listTags',
  summary: 'The org’s tags, by name',
  description: 'Every tag of the org, shared by all members.',
  request: { params: orgParams },
  responses: { 200: json(z.array(TagSchema), 'The tags'), ...problems(401, 404) },
});

const createTag = createRoute({
  method: 'post',
  path: '/api/v1/orgs/{orgId}/tags',
  tags,
  operationId: 'createTag',
  summary: 'Create a tag (without a colour it gets the next palette colour)',
  description:
    'Names are unique per org, case-insensitively (`409 tag_name_taken`). A repeated create with the same `id` and name returns the tag.',
  request: { params: orgParams, body: body(TagCreateSchema) },
  responses: {
    201: json(TagSchema, 'The tag'),
    ...problems(...AUTHED, 404, 'id_conflict', 'tag_name_taken'),
  },
});

const patchTag = createRoute({
  method: 'patch',
  path: '/api/v1/tags/{id}',
  tags,
  operationId: 'updateTag',
  summary: 'Rename or recolour a tag',
  description:
    'Any member may. A name another tag of the org has (case-insensitively) is `409 tag_name_taken` with that tag’s `existingId`.',
  request: { params: tagParams, body: body(TagPatchSchema) },
  responses: { 200: json(TagSchema, 'The tag'), ...problems(...AUTHED, 404, 'tag_name_taken') },
});

const deleteTag = createRoute({
  method: 'delete',
  path: '/api/v1/tags/{id}',
  tags,
  operationId: 'deleteTag',
  summary: 'Delete a tag and remove it from every task',
  description: 'Permanent; the tasks themselves stay.',
  request: { params: tagParams },
  responses: { 204: { description: 'Deleted' }, ...problems(...AUTHED, 404) },
});

const mergeTag = createRoute({
  method: 'post',
  path: '/api/v1/tags/{id}/merge',
  tags,
  operationId: 'mergeTag',
  summary: 'Merge a tag into another: its tasks get `intoId`, then it is deleted',
  description:
    'Both tags must be in the same org; merging a tag into itself is `422`. Answers the remaining tag.',
  request: { params: tagParams, body: body(TagMergeSchema) },
  responses: { 200: json(TagSchema, 'The remaining tag'), ...problems(...AUTHED, 404) },
});

const addTaskTag = createRoute({
  method: 'put',
  path: '/api/v1/tasks/{id}/tags/{tagId}',
  tags,
  operationId: 'addTaskTag',
  summary: 'Add a tag to a task (idempotent); the tag must be in the task’s org',
  description: 'Set semantics: adding a tag the task has changes nothing. Answers the task.',
  request: { params: taskTagParams },
  responses: {
    200: json(TaskSchema, 'The task'),
    ...problems(...AUTHED, 404, 'conflict_deleted'),
  },
});

const removeTaskTag = createRoute({
  method: 'delete',
  path: '/api/v1/tasks/{id}/tags/{tagId}',
  tags,
  operationId: 'removeTaskTag',
  summary: 'Remove a tag from a task (idempotent)',
  description: 'Removing a tag the task does not have changes nothing. Answers the task.',
  request: { params: taskTagParams },
  responses: {
    200: json(TaskSchema, 'The task'),
    ...problems(...AUTHED, 404, 'conflict_deleted'),
  },
});

export function registerTagRoutes(app: OpenAPIHono<AppEnv>, services: Services): void {
  const { tags: tagService } = services;
  app.openapi(listTags, (c) =>
    c.json(tagService.list(actorOf(c), c.req.valid('param').orgId), 200),
  );
  app.openapi(createTag, (c) =>
    c.json(
      tagService.create(actorOf(c), c.req.valid('param').orgId, c.req.valid('json'), metaOf(c)),
      201,
    ),
  );
  app.openapi(patchTag, (c) =>
    c.json(
      tagService.update(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)),
      200,
    ),
  );
  app.openapi(deleteTag, (c) => {
    tagService.remove(actorOf(c), c.req.valid('param').id, metaOf(c));
    return c.body(null, 204);
  });
  app.openapi(mergeTag, (c) =>
    c.json(
      tagService.merge(actorOf(c), c.req.valid('param').id, c.req.valid('json').intoId, metaOf(c)),
      200,
    ),
  );
  app.openapi(addTaskTag, (c) => {
    const { id, tagId } = c.req.valid('param');
    return c.json(tagService.setOnTask(actorOf(c), id, tagId, true, metaOf(c)), 200);
  });
  app.openapi(removeTaskTag, (c) => {
    const { id, tagId } = c.req.valid('param');
    return c.json(tagService.setOnTask(actorOf(c), id, tagId, false, metaOf(c)), 200);
  });
}
