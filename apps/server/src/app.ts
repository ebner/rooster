import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { Config } from './config.ts';
import type { AppDb } from './db/client.ts';
import type { AppEnv } from './lib/context.ts';
import { createErrorHandler, notFoundHandler, validationHook } from './lib/errors.ts';
import type { Logger } from './lib/logger.ts';
import { requestIdMiddleware, requestLogger } from './lib/request-log.ts';
import { DOCS_PATH, securityHeaders } from './lib/security-headers.ts';
import { webApp } from './lib/web-app.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { ProblemSchema } from './routes/problem.ts';

export interface AppDeps {
  config: Config;
  db: AppDb;
  logger: Logger;
  version: string;
  /** Overrides the bundled migrations folder used by `/readyz`. */
  migrationsDir?: string;
}

export const OPENAPI_PATH = '/api/v1/openapi.json';
export const DOCS_BUNDLE_PATH = `${DOCS_PATH}/scalar.js`;

// In the production bundle tsdown copies Scalar's browser bundle to `dist/vendor/`. Under
// tsx/vitest it is read from node_modules (it is not in the package's export map, so it is
// located next to the package entry).
async function readScalarBundle(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  try {
    return await readFile(join(moduleDir, 'vendor', 'standalone.js'), 'utf8');
  } catch {
    const entry = fileURLToPath(import.meta.resolve('@scalar/api-reference'));
    return readFile(join(dirname(entry), 'browser', 'standalone.js'), 'utf8');
  }
}

export function openApiDocumentConfig(version: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'rooster API', version },
    servers: [{ url: '/' }],
  };
}

export type App = OpenAPIHono<AppEnv>;

/** Pure factory: no listening, no timers. Tests drive it through `app.request()`. */
export function createApp(deps: AppDeps): App {
  const { config, db, logger, version } = deps;
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.onError(createErrorHandler(logger));
  app.notFound(notFoundHandler);

  app.use(requestIdMiddleware());
  app.use(requestLogger(logger));
  app.use(securityHeaders());

  registerHealthRoutes(app, { db, migrationsDir: deps.migrationsDir });
  registerMetaRoutes(app, { config, version });

  app.openAPIRegistry.register('Problem', ProblemSchema);
  app.doc31(OPENAPI_PATH, openApiDocumentConfig(version));
  let docsBundle: Promise<string> | undefined;
  app.get(DOCS_BUNDLE_PATH, async (c) => {
    docsBundle ??= readScalarBundle();
    return c.body(await docsBundle, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    });
  });
  app.get(
    DOCS_PATH,
    Scalar<AppEnv>((c) => {
      const nonce = c.get('secureHeadersNonce');
      return {
        url: OPENAPI_PATH,
        pageTitle: 'rooster API',
        cdn: DOCS_BUNDLE_PATH,
        withDefaultFonts: false,
        telemetry: false,
        ...(nonce ? { nonce } : {}),
      };
    }),
  );

  // Last: everything no route claimed is the web app (or a problem+json 404).
  app.use(webApp(config.webDir, logger));

  return app;
}
