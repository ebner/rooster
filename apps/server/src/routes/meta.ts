import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { type Meta, metaSchema } from '@rooster/core/schemas';
import { configuredProviders } from '../auth/auth.ts';
import type { Config } from '../config.ts';
import type { AppEnv } from '../lib/context.ts';
import { named } from '../lib/openapi.ts';

export const MetaSchema = named(metaSchema, 'Meta');

const metaRoute = createRoute({
  method: 'get',
  path: '/api/v1/meta',
  tags: ['meta'],
  operationId: 'getMeta',
  summary: 'Server version, sign-in providers and enabled features',
  description: 'No authentication. Used by the login page and the CLI.',
  responses: {
    200: {
      description: 'Server metadata',
      content: { 'application/json': { schema: MetaSchema } },
    },
  },
});

export function registerMetaRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { config: Config; version: string },
): void {
  const { config, version } = deps;
  const body: Meta = {
    version,
    gitSha: config.gitSha,
    providers: configuredProviders(config),
    features: {
      email: config.smtp !== null,
      push: config.vapid !== null,
      s3: config.s3 !== null,
    },
  };
  app.openapi(metaRoute, (c) => c.json(body, 200));
}
