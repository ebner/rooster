import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { P9RouteDeps } from './p9-deps.ts';

/** P9 WP 9.6 (owned by the OAuth agent): `GET /me/identities`, `DELETE /me/identities/:id`. */
export function registerIdentityRoutes(_app: OpenAPIHono<AppEnv>, _deps: P9RouteDeps): void {}
