import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { exportQuerySchema } from '@rooster/core/schemas';
import type { AppEnv } from '../lib/context.ts';
import { renderExportMarkdown } from '../services/export-service.ts';
import type { Services } from '../services/index.ts';
import { actorOf, orgIdParam, problems } from './common.ts';
import { OrgExportSchema } from './schemas.ts';

const exportOrg = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/export',
  tags: ['export'],
  operationId: 'exportOrg',
  summary: 'Download my data in an org as JSON (lossless) or Markdown',
  description:
    'My groups, my tasks (open and completed) with their subtasks, their tags and their comments, as an attachment named `rooster-<slug>-<yyyy-mm-dd>.json` or `.md`. `format=json` (default) is lossless (`format: "rooster-export", version: 1`); `markdown` is a readable rendering of the same data.',
  request: { params: z.object({ orgId: orgIdParam }), query: exportQuerySchema },
  responses: {
    200: {
      description: 'The export (`Content-Disposition: attachment`)',
      headers: {
        'Content-Disposition': {
          description: '`attachment; filename="rooster-<slug>-<yyyy-mm-dd>.json"` (or `.md`)',
          schema: { type: 'string' },
          required: true,
        },
      },
      content: {
        'application/json': { schema: OrgExportSchema },
        'text/markdown': { schema: z.string() },
      },
    },
    ...problems(401, 404, 422),
  },
});

export function registerExportRoutes(app: OpenAPIHono<AppEnv>, { exports }: Services): void {
  app.openapi(exportOrg, (c) => {
    const { data, fileStem } = exports.exportOrg(actorOf(c), c.req.valid('param').orgId);
    const headers = { 'Cache-Control': 'no-store' };
    if (c.req.valid('query').format === 'markdown') {
      return c.body(renderExportMarkdown(data), 200, {
        ...headers,
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileStem}.md"`,
      });
    }
    return c.json(data, 200, {
      ...headers,
      'Content-Disposition': `attachment; filename="${fileStem}.json"`,
    });
  });
}
