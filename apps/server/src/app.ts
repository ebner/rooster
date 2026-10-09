import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { actorMiddleware } from './auth/actor.ts';
import { createAuth, providerOrigins } from './auth/auth.ts';
import { registerAuthRoutes } from './auth/mount.ts';
import type { Config } from './config.ts';
import type { AppDb } from './db/client.ts';
import { EventBus } from './events/bus.ts';
import { SseHub } from './events/hub.ts';
import { API_BODY_LIMIT, AUTH_BODY_LIMIT, bodyLimitFor } from './lib/body-limit.ts';
import type { AppEnv } from './lib/context.ts';
import { csrfProtection } from './lib/csrf.ts';
import { createErrorHandler, notFoundHandler, validationHook } from './lib/errors.ts';
import { idempotencyMiddleware } from './lib/idempotency.ts';
import type { Logger } from './lib/logger.ts';
import { API_RATE_LIMIT, type RateLimitOptions, userRateLimit } from './lib/rate-limit.ts';
import { requestIdMiddleware, requestLogger } from './lib/request-log.ts';
import { requestMeta } from './lib/request-meta.ts';
import { DOCS_PATH, securityHeaders } from './lib/security-headers.ts';
import { webApp } from './lib/web-app.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerCollabRoutes } from './routes/collab.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerExportRoutes } from './routes/export.ts';
import { registerGroupRoutes } from './routes/groups.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerMeRoutes } from './routes/me.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerOrgRoutes } from './routes/orgs.ts';
import { ProblemSchema } from './routes/problem.ts';
import { registerPushRoutes } from './routes/push.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerTagRoutes } from './routes/tags.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { registerUnsubscribeRoutes } from './routes/unsubscribe.ts';
import { createServices, type DeliveryTransports, type Services } from './services/index.ts';

export interface AppDeps {
  config: Config;
  db: AppDb;
  logger: Logger;
  version: string;
  /** Overrides the bundled migrations folder used by `/readyz`. */
  migrationsDir?: string;
  /** ms epoch; defaults to `Date.now`. */
  clock?: () => number;
  /** better-auth's rate limiter on `/api/auth/*`; tests switch it off. Default on. */
  authRateLimit?: boolean;
  /** The per-user API limit (06 §1); default 600/min, `false` switches it off (tests). */
  apiRateLimit?: RateLimitOptions | false;
  /** SSE timings; tests shorten them. Defaults: 25 s heartbeat, 50 ms coalescing. */
  sse?: { heartbeatMs?: number; coalesceMs?: number };
  /** Push and SMTP transports (P7); tests inject fakes. */
  transports?: DeliveryTransports;
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

export type App = OpenAPIHono<AppEnv> & {
  /** Domain services, exposed for tests and the auth hooks. */
  services: Services;
  /** The SSE hub; `main.ts` shuts it down before draining connections. */
  hub: SseHub;
};

/** Pure factory: no listening, no timers. Tests drive it through `app.request()`. */
export function createApp(deps: AppDeps): App {
  const { config, db, logger, version } = deps;
  const clock = deps.clock ?? Date.now;
  const events = new EventBus(logger);
  const services = createServices({ db, config, logger, clock, events, ...deps.transports });
  const hub = new SseHub(events, {
    version,
    gitSha: config.gitSha,
    clock,
    logger,
    ...deps.sse,
  });
  const auth = createAuth({
    config,
    db,
    logger,
    services,
    clock,
    rateLimit: deps.authRateLimit,
  });
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.onError(createErrorHandler(logger));
  app.notFound(notFoundHandler);

  app.use(requestIdMiddleware());
  app.use(requestLogger(logger));
  app.use(securityHeaders(providerOrigins(config)));
  // Before the auth mount, which buffers the whole body (auth/mount.ts).
  app.use('/api/auth/*', bodyLimitFor(AUTH_BODY_LIMIT));
  app.use('/api/v1/*', bodyLimitFor(API_BODY_LIMIT));
  app.use('/api/v1/*', actorMiddleware({ auth, services }));
  app.use('/api/v1/*', csrfProtection(config.baseUrl));
  const rateLimit = deps.apiRateLimit ?? API_RATE_LIMIT;
  if (rateLimit !== false) app.use('/api/v1/*', userRateLimit(rateLimit, clock));
  app.use('/api/v1/*', requestMeta(clock));
  app.use('/api/v1/*', idempotencyMiddleware(services.idempotency));

  registerHealthRoutes(app, { db, migrationsDir: deps.migrationsDir });
  registerAuthRoutes(app, { auth, config });
  registerMetaRoutes(app, {
    config,
    version,
    clock,
    features: { email: () => services.mail.enabled(), push: () => services.push.enabled() },
  });
  registerMeRoutes(app, services);
  registerOrgRoutes(app, services);
  registerInviteRoutes(app, services, { config, clock });
  registerAdminRoutes(app, services);
  registerGroupRoutes(app, services);
  registerTaskRoutes(app, services);
  registerTagRoutes(app, services);
  registerSearchRoutes(app, services);
  registerExportRoutes(app, services);
  registerCollabRoutes(app, services);
  registerPushRoutes(app, services);
  registerUnsubscribeRoutes(app, { services, config, clock });
  registerEventRoutes(app, { hub, services });

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

  return Object.assign(app, { services, hub });
}
