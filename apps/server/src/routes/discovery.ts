import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { P9RouteDeps } from './p9-deps.ts';

/**
 * P9 WP 9.5 (owned by the remote MCP agent): the MCP Server Card, `/.well-known/ai-catalog.json`,
 * the agent-skills index and `SKILL.md`, and `/llms.txt` (11 §6.1), behind
 * `ROOSTER_AGENT_DISCOVERY`. Not part of the OpenAPI document.
 */
export function registerDiscoveryRoutes(_app: OpenAPIHono<AppEnv>, _deps: P9RouteDeps): void {}
