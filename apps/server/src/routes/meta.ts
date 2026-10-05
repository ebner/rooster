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
  summary: 'Server version, sign-in providers, enabled features and the server clock',
  description:
    'No authentication. Used by the login page and the CLI. `serverTime` lets clients estimate their clock skew before stamping `X-Rooster-Edit-Time`.',
  responses: {
    200: {
      description: 'Server metadata',
      content: { 'application/json': { schema: MetaSchema } },
    },
  },
});

export function registerMetaRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { config: Config; version: string; clock: () => number },
): void {
  const { config, version, clock } = deps;
  const body: Omit<Meta, 'serverTime'> = {
    version,
    gitSha: config.gitSha,
    providers: configuredProviders(config),
    features: {
      email: config.smtp !== null,
      push: config.vapid !== null,
      s3: config.s3 !== null,
    },
  };
  app.openapi(metaRoute, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ ...body, serverTime: clock() }, 200);
  });
}
