import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { actorOf, json, problems } from './common.ts';
import { TaskSchema } from './schemas.ts';

// Task refs for the CLI (07 §3), resolved by the server so every client agrees.

const resolveQuery = z.object({
  ref: z.string().min(1).max(100).openapi({
    description:
      '`42` (task number in `org`), `acme#42` / `personal#42` (number in that org), or an ID prefix of at least 8 hex digits, dashes optional (across all my orgs). Eight or more bare digits read as an ID prefix.',
    example: 'personal#42',
  }),
  org: z
    .string()
    .min(1)
    .optional()
    .openapi({ description: 'Org ID, slug or `personal`; required for a bare number.' }),
  deleted: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: '`true` also matches tasks in Trash (to restore them).' }),
});

const resolveRef = createRoute({
  method: 'get',
  path: '/api/v1/tasks/resolve',
  tags: ['tasks'],
  operationId: 'resolveTaskRef',
  summary: 'Find a task by number, org#number or ID prefix',
  description:
    'Completed tasks always match. Unknown or unreadable refs are `404`. A prefix matching several tasks is `409 ambiguous_ref`, with `candidates: [{id, orgId, seq, title}]` (at most 10) in the problem.',
  request: { query: resolveQuery },
  responses: {
    200: json(TaskSchema, 'The task (with `deletedAt` when in Trash)'),
    ...problems(401, 404, 422, 'ambiguous_ref'),
  },
});

/** Registered before the task routes, so `/tasks/resolve` is not read as a task ID. */
export function registerRefRoutes(app: OpenAPIHono<AppEnv>, { tasks }: Services): void {
  app.openapi(resolveRef, (c) => {
    const { ref, org, deleted } = c.req.valid('query');
    return c.json(
      tasks.resolveRef(actorOf(c), {
        ref,
        ...(org === undefined ? {} : { org }),
        deleted: deleted === 'true',
      }),
      200,
    );
  });
}
