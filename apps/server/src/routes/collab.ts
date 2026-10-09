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
    ...problems(401, 404, 422),
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
  responses: {
    201: json(CommentSchema, 'The comment'),
    ...problems(...AUTHED, 404, 'id_conflict', 'conflict_deleted'),
  },
});

const patchComment = createRoute({
  method: 'patch',
  path: '/api/v1/comments/{id}',
  tags: ['collaboration'],
  operationId: 'updateComment',
  summary: 'Edit my comment (author only); sets editedAt',
  description:
    'Only the author (`403 forbidden`). A deleted comment, or a comment on a deleted task, is `410 conflict_deleted`. New mentions notify and add followers.',
  request: { params: commentParams, body: body(CommentPatchSchema) },
  responses: {
    200: json(CommentSchema, 'The comment'),
    ...problems(...AUTHED, 404, 'forbidden', 'conflict_deleted'),
  },
});

const deleteComment = createRoute({
  method: 'delete',
  path: '/api/v1/comments/{id}',
  tags: ['collaboration'],
  operationId: 'deleteComment',
  summary: 'Delete my comment (author only); restorable for 30 days',
  description:
    'A soft delete: the comment leaves the feed, and `POST /comments/{id}/restore` brings it back within 30 days.',
  request: { params: commentParams },
  responses: {
    204: { description: 'Deleted' },
    ...problems(...AUTHED, 404, 'forbidden', 'conflict_deleted'),
  },
});

const restoreComment = createRoute({
  method: 'post',
  path: '/api/v1/comments/{id}/restore',
  tags: ['collaboration'],
  operationId: 'restoreComment',
  summary: 'Undo the delete of my comment (author only)',
  description: 'Restoring a live comment returns it unchanged.',
  request: { params: commentParams },
  responses: {
    200: json(CommentSchema, 'The comment'),
    ...problems(...AUTHED, 404, 'forbidden', 'conflict_deleted'),
  },
});

const followTask = createRoute({
  method: 'put',
  path: '/api/v1/tasks/{id}/followers/me',
  tags: ['collaboration'],
  operationId: 'followTask',
  summary: 'Follow a task (shared orgs only)',
  description:
    'Followers get notifications about comments, completion and due changes. Idempotent. Personal orgs have no followers (`409 personal_org`).',
  request: { params: taskParams },
  responses: {
    200: json(FollowStateSchema, 'The active followers'),
    ...problems(...AUTHED, 404, 'personal_org', 'conflict_deleted'),
  },
});

const unfollowTask = createRoute({
  method: 'delete',
  path: '/api/v1/tasks/{id}/followers/me',
  tags: ['collaboration'],
  operationId: 'unfollowTask',
  summary: 'Unfollow a task; automatic following no longer adds me back',
  description:
    'Mutes the task for me: commenting or being assigned later does not make me follow it again; only `PUT` does. Idempotent.',
  request: { params: taskParams },
  responses: {
    200: json(FollowStateSchema, 'The active followers'),
    ...problems(...AUTHED, 404, 'personal_org', 'conflict_deleted'),
  },
});

const listNotifications = createRoute({
  method: 'get',
  path: '/api/v1/notifications',
  tags: ['notifications'],
  operationId: 'listNotifications',
  summary: 'My notifications across orgs, newest first, with the unread count',
  description:
    '`unread=true` lists unread ones only. Paged with `limit` and `cursor`; `unreadCount` counts every unread notification on every page (the bell badge). For a PAT or CLI device (`notifications:read`), both the items and `unreadCount` cover only notifications whose org the grant reaches and whose task it may read, so a page may hold fewer than `limit` items. Marking read or unread under a grant touches only those notifications.',
  request: { query: notificationQuerySchema },
  responses: {
    200: json(NotificationPageSchema, 'A page of notifications'),
    ...problems(401, 422),
  },
});

const markRead = createRoute({
  method: 'post',
  path: '/api/v1/notifications/read',
  tags: ['notifications'],
  operationId: 'markNotificationsRead',
  summary: 'Mark notifications read: `{ids}` or `{all: true}`',
  description:
    'IDs that are not mine are ignored. Every tab and device of mine gets the new count over SSE.',
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
  description: 'The inverse of `/notifications/read`.',
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
  summary: 'The notification preference matrix (every type × channel)',
  description:
    'Every cell with defaults applied: in-app and push on for every event, email on for assignments and mentions. The digest is email only, the due reminder push only. Reminder and digest times live in `/me` prefs.',
  responses: { 200: json(NotificationPrefsSchema, 'The matrix'), ...problems(401) },
});

const putPrefs = createRoute({
  method: 'put',
  path: '/api/v1/me/notification-prefs',
  tags: ['notifications'],
  operationId: 'updateNotificationPrefs',
  summary: 'Set cells of the matrix',
  description:
    'Send any subset of cells; the others keep their value. A cell that does not exist (e.g. the digest on push) is `422`. Answers the whole matrix.',
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
