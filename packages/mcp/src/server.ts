import type { McpServer } from '@modelcontextprotocol/server';
import type { RoosterClient } from '@rooster/api-client';
import type { GrantScope } from '@rooster/core/grants';

/**
 * Which tools `tools/list` shows (ADR 0042):
 * - `granted` (stdio): only tools the grant's scopes allow; there is no step-up over stdio.
 * - `step-up` (remote): every tool except `delete_task` without `tasks:delete`; a call beyond the
 *   token's scopes is answered by the HTTP layer with `403 insufficient_scope` first.
 */
export type ToolListing =
  | { mode: 'granted'; scopes: readonly GrantScope[] }
  | { mode: 'step-up'; scopes: readonly GrantScope[] };

export interface RoosterMcpOptions {
  /**
   * The REST client every tool calls. stdio: the CLI profile's client (`X-Rooster-Client:
   * mcp/<version>`). Remote: an in-process client (`IN_PROCESS_ACTOR`, ADR 0042).
   */
  client: RoosterClient;
  listing: ToolListing;
  /** `rooster mcp --read-only`: list, get and search tools only. */
  readOnly?: boolean;
  /** The org slug tools use when `org` is omitted (07 §6). Null: the user's first org. */
  defaultOrg?: string | null;
  /** The instance's base URL, for links and the `instructions`. */
  instanceUrl: string;
  /** The rooster version reported in `serverInfo`. */
  version: string;
}

/**
 * One MCP server with rooster's tools, the `rooster://{org}/my` resource and the short skill as
 * `instructions` (07 §6, 11 §5–6). stdio connects it to a `StdioServerTransport`; the remote
 * endpoint builds one per request (stateless).
 */
export function createRoosterMcpServer(_options: RoosterMcpOptions): McpServer {
  throw new Error('P9 WP 9.2: not implemented');
}
