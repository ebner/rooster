import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';
import type { Logger } from './logger.ts';

/** Paths owned by the server; they never fall back to the SPA shell. */
const SERVER_PREFIXES = ['/api', '/healthz', '/readyz', '/ical'];

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

function isServerPath(path: string): boolean {
  return SERVER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Build output that is not part of the app: source maps (they publish the source) and
 * anything under a dot-name (`/.vite/manifest.json`). Checked on the decoded path, so
 * `%2e` spellings are caught too.
 */
export function isPrivateBuildPath(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  return decoded.endsWith('.map') || decoded.split(/[/\\]/).some((s) => s.startsWith('.'));
}

/**
 * Serves the web build (Vite output) with an SPA fallback to `index.html`.
 * Hashed files under `/assets` are cached forever; everything else revalidates, so
 * `index.html` and `sw.js` always pick up a new deploy. A missing `/assets/*` file is a
 * 404 rather than the shell, so a stale chunk never gets cached as HTML. Source maps and
 * dot-directories are never served, not even as the shell.
 */
export function webApp(webDir: string, logger: Logger): MiddlewareHandler<AppEnv> {
  const indexFile = join(webDir, 'index.html');
  if (!existsSync(webDir) || !statSync(webDir).isDirectory() || !existsSync(indexFile)) {
    logger.warn(
      { webDir },
      'web build not found; serving the API only (in development the web app runs on Vite)',
    );
    return (_c, next) => next();
  }

  const files = serveStatic<AppEnv>({ root: webDir });
  const shell = serveStatic<AppEnv>({ path: indexFile });

  return async (c, next) => {
    const method = c.req.method;
    if ((method !== 'GET' && method !== 'HEAD') || isServerPath(c.req.path)) return next();
    if (isPrivateBuildPath(c.req.path)) return next();
    const isAsset = c.req.path.startsWith('/assets/');
    c.header('Cache-Control', isAsset ? IMMUTABLE : REVALIDATE);
    const served = await files(c, async () => {});
    if (served instanceof Response) return served;
    if (isAsset) {
      c.header('Cache-Control', undefined);
      return next();
    }
    c.header('Cache-Control', REVALIDATE);
    const fallback = await shell(c, async () => {});
    if (fallback instanceof Response) return fallback;
    c.header('Cache-Control', undefined);
    return next();
  };
}
