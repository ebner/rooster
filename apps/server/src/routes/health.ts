import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppDb } from '../db/client.ts';
import { hasPendingMigrations } from '../db/migrate.ts';
import type { AppEnv } from '../lib/context.ts';

/** Liveness and readiness probes (outside `/api/v1`, no auth). */
export function registerHealthRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { db: AppDb; migrationsDir?: string | undefined },
): void {
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', (c) => {
    try {
      deps.db.sqlite.prepare('SELECT 1').get();
      if (hasPendingMigrations(deps.db, deps.migrationsDir)) {
        return c.json({ status: 'unavailable', reason: 'migrations_pending' }, 503);
      }
      return c.json({ status: 'ok' });
    } catch (err) {
      c.var.logger.warn({ err }, 'readiness check failed');
      return c.json({ status: 'unavailable', reason: 'database_error' }, 503);
    }
  });
}
