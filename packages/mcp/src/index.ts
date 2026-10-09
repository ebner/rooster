/**
 * rooster's MCP tools (docs/spec/11-agent-access.md §5, 07 §6), shared by the stdio server
 * (`rooster mcp`) and the remote `/mcp` endpoint. Every tool calls the public REST API through
 * `@rooster/api-client`, so authorisation stays in the server's services (ADR 0042).
 */
export { DATA_NOTICE } from './format.ts';
export {
  createRoosterMcpServer,
  errorResult,
  listedTools,
  type RoosterMcpOptions,
  type ToolListing,
} from './server.ts';
export { SKILL_DESCRIPTION, type SkillContext, skillInstructions, skillMarkdown } from './skill.ts';
export {
  ASSIGNEE_ME,
  ASSIGNEE_NONE,
  coversScopes,
  isAssigneeMe,
  isToolName,
  READ_ONLY_TOOLS,
  requiredScopes,
  type ScopeContext,
  TOOL_NAMES,
  type ToolName,
} from './tools.ts';
