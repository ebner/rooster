import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { savedViewListQuerySchema, savedViewTasksQuerySchema } from '@rooster/core/schemas';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, body, idParam, json, metaOf, orgIdParam, problems } from './common.ts';
import {
  SavedViewCreateSchema,
  SavedViewMoveSchema,
  SavedViewPatchSchema,
  SavedViewSchema,
  SavedViewTasksSchema,
} from './schemas.ts';

// Phase 13 (ADR 0073 B, 06 §2): views, saved queries in one org, private or shared.
const tags = ['views'];
const orgParams = z.object({ orgId: orgIdParam });
const viewParams = z.object({ id: idParam('id', 'View ID') });

const listViews = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/views',
  tags,
  operationId: 'listViews',
  summary: 'The views I see in an org, in my order',
  description:
    'The org’s shared views and my private ones, in my own sidebar order, each with `openCount`. `archived=true` lists the archived ones instead (Org settings → Views). Needs `tasks:read`.',
  request: { params: orgParams, query: savedViewListQuerySchema },
  responses: { 200: json(z.array(SavedViewSchema), 'The views'), ...problems(401, 404) },
});

const createView = createRoute({
  method: 'post',
  path: '/api/v1/orgs/{orgId}/views',
  tags,
  operationId: 'createView',
  summary: 'Create a view (private unless `shared`; always private in a personal org)',
  description:
    'Tags in the query must be the org’s and a named assignee one of its members (`422`). The view goes to the end of my order (and of every member’s, when shared). A repeated create with the same `id` and content returns the view; other content under that `id` is `409`. Needs `groups:write` with write access to the whole org.',
  request: { params: orgParams, body: body(SavedViewCreateSchema) },
  responses: {
    201: json(SavedViewSchema, 'The view'),
    ...problems(...AUTHED, 404, 'id_conflict'),
  },
});

const patchView = createRoute({
  method: 'patch',
  path: '/api/v1/views/{id}',
  tags,
  operationId: 'updateView',
  summary: 'Rename a view, change its query, or share or unshare it',
  description:
    'Any member may change a shared view; a private one only its creator (anyone else gets `404`). Unsharing makes it private to its creator, whoever does it, and drops it from the other members’ orders (shared again, it goes to the end of theirs). A view whose creator has left the org cannot be unshared (`422`). In a personal org `shared` stays false. Only new tags and a new assignee are validated (`422`). Needs `groups:write` with write access to the whole org.',
  request: { params: viewParams, body: body(SavedViewPatchSchema) },
  responses: { 200: json(SavedViewSchema, 'The view'), ...problems(...AUTHED, 404) },
});

const deleteView = createRoute({
  method: 'delete',
  path: '/api/v1/views/{id}',
  tags,
  operationId: 'deleteView',
  summary: 'Delete a view (the tasks and tags stay)',
  description:
    'As for changes: any member for a shared view, the creator for a private one. Needs `groups:write` with write access to the whole org.',
  request: { params: viewParams },
  responses: { 204: { description: 'Deleted' }, ...problems(...AUTHED, 404) },
});

const moveView = createRoute({
  method: 'post',
  path: '/api/v1/views/{id}/move',
  tags,
  operationId: 'moveView',
  summary: 'Move a view in my own sidebar order',
  description:
    '`afterId`/`beforeId` name other live views I see (any other ID counts as unknown: the end); each member orders views themselves. Moving an archived view changes nothing. Needs `groups:write`.',
  request: { params: viewParams, body: body(SavedViewMoveSchema) },
  responses: { 200: json(SavedViewSchema, 'The view'), ...problems(...AUTHED, 404) },
});

const archiveView = createRoute({
  method: 'post',
  path: '/api/v1/views/{id}/archive',
  tags,
  operationId: 'archiveView',
  summary: 'Archive a view: it leaves every sidebar (Org settings → Views restores it)',
  description:
    'Idempotent. Every member’s place for it is dropped; the tag and the tasks are untouched. Needs `groups:write`.',
  request: { params: viewParams },
  responses: { 200: json(SavedViewSchema, 'The view'), ...problems(...AUTHED, 404) },
});

const restoreView = createRoute({
  method: 'post',
  path: '/api/v1/views/{id}/restore',
  tags,
  operationId: 'restoreView',
  summary: 'Restore an archived view',
  description:
    'Idempotent. It returns to the end of my order, and of every other member’s. Needs `groups:write`.',
  request: { params: viewParams },
  responses: { 200: json(SavedViewSchema, 'The view'), ...problems(...AUTHED, 404) },
});

const viewTasks = createRoute({
  method: 'get',
  path: '/api/v1/views/{id}/tasks',
  tags,
  operationId: 'listViewTasks',
  summary: 'A view’s tasks and its open/done counts',
  description:
    'Every task of the org matching the query (subtasks included, each a row of its own; group them with `@rooster/core/saved-views`), filtered by my grant as every read; `completed=true` also lists completed matches. `counts` are the matches by completion, ignoring the status filter. `items` also carries, after the rows, the parent chain of every matching subtask (for its breadcrumb), readable parents only: they are not rows and not counted, and `selectSavedView` leaves them out. Needs `tasks:read`.',
  request: { params: viewParams, query: savedViewTasksQuerySchema },
  responses: { 200: json(SavedViewTasksSchema, 'The tasks'), ...problems(401, 404) },
});

export function registerViewRoutes(app: OpenAPIHono<AppEnv>, services: Services): void {
  const { views } = services;
  app.openapi(listViews, (c) =>
    c.json(views.list(actorOf(c), c.req.valid('param').orgId, c.req.valid('query')), 200),
  );
  app.openapi(createView, (c) =>
    c.json(
      views.create(actorOf(c), c.req.valid('param').orgId, c.req.valid('json'), metaOf(c)),
      201,
    ),
  );
  app.openapi(patchView, (c) =>
    c.json(views.update(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)), 200),
  );
  app.openapi(deleteView, (c) => {
    views.remove(actorOf(c), c.req.valid('param').id, metaOf(c));
    return c.body(null, 204);
  });
  app.openapi(moveView, (c) =>
    c.json(views.move(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)), 200),
  );
  app.openapi(archiveView, (c) =>
    c.json(views.setArchived(actorOf(c), c.req.valid('param').id, true, metaOf(c)), 200),
  );
  app.openapi(restoreView, (c) =>
    c.json(views.setArchived(actorOf(c), c.req.valid('param').id, false, metaOf(c)), 200),
  );
  app.openapi(viewTasks, (c) =>
    c.json(views.tasks(actorOf(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );
}
