import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { actorMiddleware } from './auth/actor.ts';
import { type Auth, type AuthDeps, createAuth, providerOrigins } from './auth/auth.ts';
import { registerAuthRoutes } from './auth/mount.ts';
import type { Config } from './config.ts';
import type { AppDb } from './db/client.ts';
import { EventBus } from './events/bus.ts';
import { SseHub } from './events/hub.ts';
import { AUTH_BODY_LIMIT, apiBodyLimit, bodyLimitFor } from './lib/body-limit.ts';
import type { AppEnv } from './lib/context.ts';
import { csrfProtection } from './lib/csrf.ts';
import { createErrorHandler, notFoundHandler, validationHook } from './lib/errors.ts';
import { idempotencyMiddleware } from './lib/idempotency.ts';
import type { Logger } from './lib/logger.ts';
import { buildOpenApiDocument } from './lib/openapi.ts';
import { API_RATE_LIMIT, type RateLimitOptions, userRateLimit } from './lib/rate-limit.ts';
import { requestIdMiddleware, requestLogger } from './lib/request-log.ts';
import { requestMeta } from './lib/request-meta.ts';
import {
  RESPONSE_VIOLATIONS_PATH,
  ResponseViolations,
  responseValidation,
} from './lib/response-contract.ts';
import { DOCS_PATH, noStoreApi, securityHeaders } from './lib/security-headers.ts';
import { webApp } from './lib/web-app.ts';
import { registerMcpRoutes } from './mcp/route.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerAvatarRoutes } from './routes/avatars.ts';
import { registerCollabRoutes } from './routes/collab.ts';
import { registerDiscoveryRoutes } from './routes/discovery.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerExportRoutes } from './routes/export.ts';
import { registerGrantRoutes } from './routes/grants.ts';
import { registerGroupRoutes } from './routes/groups.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerIcalRoutes } from './routes/ical.ts';
import { registerIdentityRoutes } from './routes/identities.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerMeRoutes } from './routes/me.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerOAuthRoutes } from './routes/oauth.ts';
import { registerOrgRoutes } from './routes/orgs.ts';
import { ProblemSchema } from './routes/problem.ts';
import { registerPushRoutes } from './routes/push.ts';
import { registerRefRoutes } from './routes/refs.ts';
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
  /**
   * AC-8.4: validate every `/api/v1` response against the OpenAPI document and serve the
   * mismatches at `/__test/response-violations`. Default: `config.validateResponses`
   * (`ROOSTER_VALIDATE_RESPONSES`, set by the Playwright config for its servers).
   */
  validateResponses?: boolean;
  /** Push and SMTP transports (P7); tests inject fakes. */
  transports?: DeliveryTransports;
  /** P9: the Client ID Metadata Document transport (default: the guarded fetch); tests inject one. */
  cimdFetch?: AuthDeps['cimdFetch'];
  /**
   * Phase 12: the OAuth device grant's polling interval in seconds (default 5, 11 §9.2). A test
   * seam only, so device logins in tests need not wait; `slow_down` still adds 5 s.
   */
  deviceIntervalSec?: number;
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

export type App = OpenAPIHono<AppEnv> & {
  /** Domain services, exposed for tests and the auth hooks. */
  services: Services;
  /** The SSE hub; `main.ts` shuts it down before draining connections. */
  hub: SseHub;
  /** The better-auth instance (tests enumerate its endpoints). */
  auth: Auth;
};

/** Pure factory: no listening, no timers. Tests drive it through `app.request()`. */
export function createApp(deps: AppDeps): App {
  const { config, db, logger, version } = deps;
  const clock = deps.clock ?? Date.now;
  const events = new EventBus(logger);
  // The hub is created below, after the services it serves; Admin → System reads it lazily.
  let hub: SseHub | undefined;
  const services = createServices({
    db,
    config,
    logger,
    clock,
    events,
    ...deps.transports,
    sseConnections: () => hub?.size ?? 0,
  });
  hub = new SseHub(events, {
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
    ...(deps.deviceIntervalSec === undefined ? {} : { deviceIntervalSec: deps.deviceIntervalSec }),
    cimdFetch: deps.cimdFetch,
  });
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.onError(createErrorHandler(logger));
  app.notFound(notFoundHandler);

  app.use(requestIdMiddleware());
  app.use(requestLogger(logger));
  app.use(securityHeaders(providerOrigins(config)));
  const validateResponses = deps.validateResponses ?? config.validateResponses;
  const violations = new ResponseViolations();
  if (validateResponses) {
    app.use(
      '/api/v1/*',
      responseValidation(app, violations, { logger, clock, ignore: [OPENAPI_PATH] }),
    );
    app.get(RESPONSE_VIOLATIONS_PATH, (c) =>
      c.json({ checked: violations.checked, violations: violations.list }),
    );
  }
  app.use('/api/v1/*', noStoreApi());
  // Before the auth mount, which buffers the whole body (auth/mount.ts).
  app.use('/api/auth/*', bodyLimitFor(AUTH_BODY_LIMIT));
  // The upload routes stream their bodies under their own limits (lib/body-limit.ts).
  app.use('/api/v1/*', apiBodyLimit());
  app.use('/api/v1/*', actorMiddleware({ auth, services, config }));
  app.use('/api/v1/*', csrfProtection(config.baseUrl));
  const rateLimit = deps.apiRateLimit ?? API_RATE_LIMIT;
  if (rateLimit !== false) app.use('/api/v1/*', userRateLimit(rateLimit, clock));
  app.use('/api/v1/*', requestMeta(clock));
  app.use('/api/v1/*', idempotencyMiddleware(services.idempotency));

  registerHealthRoutes(app, { db, migrationsDir: deps.migrationsDir });
  registerAuthRoutes(app, { auth, config, services, clock });
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
  registerGrantRoutes(app, services);
  registerGroupRoutes(app, services);
  registerRefRoutes(app, services);
  registerTaskRoutes(app, services);
  registerTagRoutes(app, services);
  registerSearchRoutes(app, services);
  registerExportRoutes(app, services);
  registerCollabRoutes(app, services);
  registerPushRoutes(app, services);
  registerUnsubscribeRoutes(app, { services, config, clock });
  registerEventRoutes(app, { hub, services });
  // Phase 9: agent access (11). Before the web app, which never serves dot-paths.
  const p9 = { auth, config, services, logger, clock, version };
  registerOAuthRoutes(app, p9);
  registerIdentityRoutes(app, p9);
  registerMcpRoutes(app, p9);
  registerDiscoveryRoutes(app, p9);
  // Phase 10 (files): attachments, avatars, calendar feeds (`/ical` is outside /api/v1).
  registerAttachmentRoutes(app, services);
  registerAvatarRoutes(app, services);
  registerIcalRoutes(app, { services, config, clock });

  app.openAPIRegistry.register('Problem', ProblemSchema);
  let openApiDocument: string | undefined;
  app.get(OPENAPI_PATH, (c) => {
    // Built on first use, once every route is registered; the routes never change afterwards.
    openApiDocument ??= JSON.stringify(
      buildOpenApiDocument(app, { version, baseUrl: config.baseUrl }),
    );
    return c.body(openApiDocument, 200, { 'Content-Type': 'application/json' });
  });
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

  return Object.assign(app, { services, hub, auth });
}
