import type { GrantScope } from '@rooster/core/grants';

/**
 * The MCP tools (07 §6, 11 §5.2). `delete_task` exists only for a grant holding `tasks:delete`,
 * which an OAuth or MCP client gets only through the consent checkbox (ADR 0041).
 */
export const TOOL_NAMES = [
  'list_orgs',
  'list_tasks',
  'get_task',
  'search_tasks',
  'create_task',
  'update_task',
  'complete_task',
  'move_task',
  'list_groups',
  'create_group',
  'add_comment',
  'list_notifications',
  'delete_task',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Context for scope decisions that depend on the arguments (assigning someone else). */
export interface ScopeContext {
  /** The grant user's id. */
  userId: string;
}

/**
 * The scopes a call needs (11 §5.2). `update_task`/`create_task` naming another assignee also
 * need `tasks:assign`. The remote endpoint uses this to answer `403 insufficient_scope` before
 * the call runs, listing every scope it needs in one challenge.
 */
export function requiredScopes(
  _tool: ToolName,
  _args: unknown,
  _ctx: ScopeContext,
): readonly GrantScope[] {
  throw new Error('P9 WP 9.2: not implemented');
}
