import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { searchQuerySchema } from '@rooster/core/schemas';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { actorOf, json, problems } from './common.ts';
import { SearchResultSchema } from './schemas.ts';

const search = createRoute({
  method: 'get',
  path: '/api/v1/search',
  tags: ['search'],
  operationId: 'search',
  summary: 'Full-text search over the tasks of my orgs, best match first',
  description:
    'Free words are prefix matches over title and description (case and diacritics ignored); `#tag`, `@person`, `due:today|overdue|week|none` and `is:open|done` filter. Open tasks rank before completed ones, then by relevance; a filter-only query ranks by due date. Without `orgId` every org I belong to is searched; an org I do not belong to is 404. Matches in `snippet` are wrapped in U+E000 … U+E001.',
  request: { query: searchQuerySchema },
  responses: { 200: json(SearchResultSchema, 'Hits, best first'), ...problems(401, 404, 422) },
});

export function registerSearchRoutes(
  app: OpenAPIHono<AppEnv>,
  { search: service }: Services,
): void {
  app.openapi(search, (c) => c.json(service.search(actorOf(c), c.req.valid('query')), 200));
}
