import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { P9RouteDeps } from './p9-deps.ts';

/**
 * P9 WP 9.3 (owned by the OAuth agent): `GET`/`POST /api/v1/oauth/consent` (11 §3.1, ADR 0041),
 * the RFC 9728 resource metadata for `/api/v1`, and the RFC 8414 metadata at
 * `/.well-known/oauth-authorization-server/api/auth`.
 */
export function registerOAuthRoutes(_app: OpenAPIHono<AppEnv>, _deps: P9RouteDeps): void {}
