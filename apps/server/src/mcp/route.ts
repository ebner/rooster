import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { P9RouteDeps } from '../routes/p9-deps.ts';

/**
 * P9 WP 9.4 (owned by the remote MCP agent): `POST`/`GET`/`DELETE /mcp` (Streamable HTTP,
 * protocol 2026-07-28, stateless), the RFC 9728 metadata at
 * `/.well-known/oauth-protected-resource/mcp`, the 401/403 challenges and per-grant rate limits
 * (11 §5.2, ADR 0042). Not part of the OpenAPI document.
 */
export function registerMcpRoutes(_app: OpenAPIHono<AppEnv>, _deps: P9RouteDeps): void {}
