import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { activityQuerySchema, notificationQuerySchema } from '@rooster/core/schemas';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, body, idParam, json, metaOf, problems } from './common.ts';
import {
  ActivityPageSchema,
  CommentCreateSchema,
  CommentPatchSchema,
  CommentSchema,
  FollowStateSchema,
  NotificationMarkResultSchema,
  NotificationMarkSchema,
  NotificationPageSchema,
  NotificationPrefsPutSchema,
  NotificationPrefsSchema,
} from './schemas.ts';

const taskParams = z.object({ id: idParam('id', 'Task ID') });
const commentParams = z.object({ id: idParam('id', 'Comment ID') });

const getActivity = createRoute({
  method: 'get',
  path: '/api/v1/tasks/{id}/activity',
  tags: ['collaboration'],
  operationId: 'getTaskActivity',
  summary: 'The merged feed of comments and activity, paged back in time',
  description:
    'The first page holds the newest items; `items` are oldest first within a page, and `nextCursor` continues with OLDER items (null at the start of the feed). `filter=comments` leaves out activity entries. Deleted comments are left out.',
  request: { params: taskParams, query: activityQuerySchema },
  responses: {
    200: json(ActivityPageSchema, 'A page of the feed'),
    ...problems(401, 404, 422, 429),
  },
});

const createComment = createRoute({
  method: 'post',
  path: '/api/v1/tasks/{id}/comments',
  tags: ['collaboration'],
  operationId: 'createComment',
  summary: 'Comment on a task; mentions are written `@[Name](user:<id>)`',
  description:
    'The commenter and every mentioned member follow the task. Mentioned members get a `mention` notification, the other followers a `comment` one. A repeated create with the same `id` and body returns the comment; another body is `409 id_conflict`.',
  request: { params: taskParams, body: body(CommentCreateSchema) },
  responses: { 201: json(CommentSchema, 'The comment'), ...problems(...AUTHED, 404, 409, 410) },
});

const patchComment = createRoute({
  method: 'patch',
  path: '/api/v1/comments/{id}',
  tags: ['collaboration'],
  operationId: 'updateComment',
  summary: 'Edit my comment (author only); sets editedAt',
  request: { params: commentParams, body: body(CommentPatchSchema) },
  responses: { 200: json(CommentSchema, 'The comment'), ...problems(...AUTHED, 404, 410) },
});

const deleteComment = createRoute({
  method: 'delete',
  path: '/api/v1/comments/{id}',
  tags: ['collaboration'],
  operationId: 'deleteComment',
  summary: 'Delete my comment (author only); restorable for 30 days',
  request: { params: commentParams },
  responses: { 204: { description: 'Deleted' }, ...problems(...AUTHED, 404, 410) },
});

const restoreComment = createRoute({
  method: 'post',
  path: '/api/v1/comments/{id}/restore',
  tags: ['collaboration'],
  operationId: 'restoreComment',
  summary: 'Undo the delete of my comment (author only)',
  request: { params: commentParams },
  responses: { 200: json(CommentSchema, 'The comment'), ...problems(...AUTHED, 404, 410) },
});

const followTask = createRoute({
  method: 'put',
  path: '/api/v1/tasks/{id}/followers/me',
  tags: ['collaboration'],
  operationId: 'followTask',
  summary: 'Follow a task (shared orgs only)',
  request: { params: taskParams },
  responses: {
    200: json(FollowStateSchema, 'The active followers'),
    ...problems(...AUTHED, 404, 409, 410),
  },
});

const unfollowTask = createRoute({
  method: 'delete',
  path: '/api/v1/tasks/{id}/followers/me',
  tags: ['collaboration'],
  operationId: 'unfollowTask',
  summary: 'Unfollow a task; automatic following no longer adds me back',
  request: { params: taskParams },
  responses: {
    200: json(FollowStateSchema, 'The active followers'),
    ...problems(...AUTHED, 404, 409, 410),
  },
});

const listNotifications = createRoute({
  method: 'get',
  path: '/api/v1/notifications',
  tags: ['notifications'],
  operationId: 'listNotifications',
  summary: 'My notifications across orgs, newest first, with the unread count',
  request: { query: notificationQuerySchema },
  responses: {
    200: json(NotificationPageSchema, 'A page of notifications'),
    ...problems(401, 422, 429),
  },
});

const markRead = createRoute({
  method: 'post',
  path: '/api/v1/notifications/read',
  tags: ['notifications'],
  operationId: 'markNotificationsRead',
  summary: 'Mark notifications read: `{ids}` or `{all: true}`',
  request: { body: body(NotificationMarkSchema) },
  responses: {
    200: json(NotificationMarkResultSchema, 'The new unread count'),
    ...problems(...AUTHED),
  },
});

const markUnread = createRoute({
  method: 'post',
  path: '/api/v1/notifications/unread',
  tags: ['notifications'],
  operationId: 'markNotificationsUnread',
  summary: 'Mark notifications unread: `{ids}` or `{all: true}`',
  request: { body: body(NotificationMarkSchema) },
  responses: {
    200: json(NotificationMarkResultSchema, 'The new unread count'),
    ...problems(...AUTHED),
  },
});

const getPrefs = createRoute({
  method: 'get',
  path: '/api/v1/me/notification-prefs',
  tags: ['notifications'],
  operationId: 'getNotificationPrefs',
  summary: 'The notification preference matrix (every type × channel; default on)',
  responses: { 200: json(NotificationPrefsSchema, 'The matrix'), ...problems(401, 429) },
});

const putPrefs = createRoute({
  method: 'put',
  path: '/api/v1/me/notification-prefs',
  tags: ['notifications'],
  operationId: 'updateNotificationPrefs',
  summary: 'Set cells of the matrix; only the `inapp` channel until Phase 7',
  request: { body: body(NotificationPrefsPutSchema) },
  responses: { 200: json(NotificationPrefsSchema, 'The whole matrix'), ...problems(...AUTHED) },
});

/** Comments, activity, followers and notifications (06 §2.6, Phase 6). */
export function registerCollabRoutes(app: OpenAPIHono<AppEnv>, services: Services): void {
  const { activity, comments, followers, notifications } = services;
  app.openapi(getActivity, (c) =>
    c.json(activity.feed(actorOf(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );
  app.openapi(createComment, (c) =>
    c.json(
      comments.create(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)),
      201,
    ),
  );
  app.openapi(patchComment, (c) =>
    c.json(
      comments.patch(actorOf(c), c.req.valid('param').id, c.req.valid('json'), metaOf(c)),
      200,
    ),
  );
  app.openapi(deleteComment, (c) => {
    comments.remove(actorOf(c), c.req.valid('param').id, metaOf(c));
    return c.body(null, 204);
  });
  app.openapi(restoreComment, (c) =>
    c.json(comments.restore(actorOf(c), c.req.valid('param').id, metaOf(c)), 200),
  );
  app.openapi(followTask, (c) =>
    c.json(followers.setFollowing(actorOf(c), c.req.valid('param').id, true), 200),
  );
  app.openapi(unfollowTask, (c) =>
    c.json(followers.setFollowing(actorOf(c), c.req.valid('param').id, false), 200),
  );
  app.openapi(listNotifications, (c) =>
    c.json(notifications.list(actorOf(c), c.req.valid('query')), 200),
  );
  app.openapi(markRead, (c) =>
    c.json(notifications.mark(actorOf(c), c.req.valid('json'), true), 200),
  );
  app.openapi(markUnread, (c) =>
    c.json(notifications.mark(actorOf(c), c.req.valid('json'), false), 200),
  );
  app.openapi(getPrefs, (c) => c.json(notifications.getPrefs(actorOf(c)), 200));
  app.openapi(putPrefs, (c) =>
    c.json(notifications.putPrefs(actorOf(c), c.req.valid('json')), 200),
  );
}
