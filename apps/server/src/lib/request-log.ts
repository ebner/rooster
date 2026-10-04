import type { MiddlewareHandler } from 'hono';
import { requestId } from 'hono/request-id';
import type { AppEnv } from './context.ts';
import type { Logger } from './logger.ts';

const PROBE_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Honours an incoming `X-Request-Id` when it is short and limited to `[A-Za-z0-9_=-]`
 * (hono's built-in check); otherwise a fresh UUID is generated. Echoed in the response.
 */
export const requestIdMiddleware = (): MiddlewareHandler<AppEnv> => requestId({ limitLength: 128 });

/** Attaches a child logger with `reqId` and logs one line per request when it completes. */
export function requestLogger(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now();
    const reqId = c.var.requestId;
    c.set('logger', logger.child({ reqId }));
    await next();
    const status = c.res.status;
    const fields = {
      reqId,
      method: c.req.method,
      path: c.req.path,
      status,
      ms: Math.round((performance.now() - start) * 10) / 10,
    };
    if (status >= 500) logger.error(fields, 'request');
    // Probes hit these every few seconds; keep them out of the default log stream.
    else if (PROBE_PATHS.has(c.req.path) && status < 400) logger.debug(fields, 'request');
    else logger.info(fields, 'request');
  };
}
