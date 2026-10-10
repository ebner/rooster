import { type GrantScope, hasScope } from '@rooster/core/grants';

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

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** The capability each tool needs before its arguments are looked at (11 §5.2). */
const BASE_SCOPE: Readonly<Record<ToolName, GrantScope>> = {
  list_orgs: 'tasks:read',
  list_tasks: 'tasks:read',
  get_task: 'tasks:read',
  search_tasks: 'tasks:read',
  list_groups: 'tasks:read',
  create_task: 'tasks:write',
  update_task: 'tasks:write',
  complete_task: 'tasks:write',
  move_task: 'tasks:write',
  create_group: 'groups:write',
  add_comment: 'comments:write',
  list_notifications: 'notifications:read',
  delete_task: 'tasks:delete',
};

/** The tools `rooster mcp --read-only` keeps: lists, get and search (07 §6). */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'list_orgs',
  'list_tasks',
  'get_task',
  'search_tasks',
  'list_groups',
  'list_notifications',
];

/** Context for scope decisions that depend on the arguments (assigning someone else). */
export interface ScopeContext {
  /** The grant user's id. */
  userId: string;
  /** The grant user's email; an `assignee` equal to it (any case) is "me". */
  email?: string | undefined;
  /** The grant user's display name; an `assignee` equal to it (any case, trimmed) is "me". */
  name?: string | undefined;
}

/** The words that mean "the calling user" in an `assignee` argument, in every UI language. */
export const ASSIGNEE_ME = ['me', 'mig'] as const;
/** The words that mean "nobody" in an `assignee` argument (unassigning needs `tasks:assign`). */
export const ASSIGNEE_NONE = ['none', 'nobody', 'ingen'] as const;

/**
 * Whether an `assignee` argument names the calling user without a member lookup, so the
 * remote endpoint can decide the challenge before the call runs. "Me" is: the words in
 * `ASSIGNEE_ME`, the user's id, or exactly the user's email or name (case-insensitive). Any
 * other value, including a nickname that would resolve to the user, counts as someone else;
 * that only over-asks for `tasks:assign`, and the server still enforces the real rule
 * (11 §2.1: choosing anyone else, or nobody, needs `tasks:assign`).
 */
export function isAssigneeMe(assignee: string, ctx: ScopeContext): boolean {
  const text = assignee.trim().toLowerCase();
  if (text === '') return false;
  // The unassign words win over a user who is literally named "none", as in `resolveAssignee`.
  if ((ASSIGNEE_NONE as readonly string[]).includes(text)) return false;
  if ((ASSIGNEE_ME as readonly string[]).includes(text)) return true;
  if (text === ctx.userId.toLowerCase()) return true;
  if (ctx.email !== undefined && text === ctx.email.trim().toLowerCase()) return true;
  return ctx.name !== undefined && ctx.name.trim() !== '' && text === ctx.name.trim().toLowerCase();
}

function assigneeArg(args: unknown): string | null | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>).assignee;
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * The scopes a call needs (11 §5.2). `update_task`/`create_task` naming another assignee also
 * need `tasks:assign`. Their P10 arguments need nothing beyond `tasks:write`: `remind` and
 * `clearReminders` act on the grant user's own reminders (ADR 0049 §2.6), and `repeat` is part
 * of the due unit. The remote endpoint uses this to answer `403 insufficient_scope` before
 * the call runs, listing every scope it needs in one challenge.
 *
 * The base scope comes first, then `tasks:assign` when it applies; implied scopes are listed
 * explicitly so the challenge reads as the whole need. An `@name` token in a `create_task` title is resolved by the server and is
 * not seen here; assigning someone else that way fails as a tool error with `forbidden_scope`.
 */
export function requiredScopes(
  tool: ToolName,
  args: unknown,
  ctx: ScopeContext,
): readonly GrantScope[] {
  const base = BASE_SCOPE[tool];
  if (tool === 'create_task' || tool === 'update_task') {
    const assignee = assigneeArg(args);
    const someoneElse =
      assignee === null || (assignee !== undefined && !isAssigneeMe(assignee, ctx));
    if (someoneElse) return [base, 'tasks:assign'];
  }
  return [base];
}

/** Whether `scopes` cover every scope in `needed` (with implications). */
export function coversScopes(
  scopes: readonly GrantScope[],
  needed: readonly GrantScope[],
): boolean {
  return needed.every((scope) => hasScope(scopes, scope));
}

/** The scopes a tool needs at the least, whatever its arguments (for listing). */
export function baseScope(tool: ToolName): GrantScope {
  return BASE_SCOPE[tool];
}
