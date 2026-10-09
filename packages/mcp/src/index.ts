/**
 * rooster's MCP tools (docs/spec/11-agent-access.md §5, 07 §6), shared by the stdio server
 * (`rooster mcp`) and the remote `/mcp` endpoint. Every tool calls the public REST API through
 * `@rooster/api-client`, so authorisation stays in the server's services (ADR 0042).
 */
export { createRoosterMcpServer, type RoosterMcpOptions, type ToolListing } from './server.ts';
export { type SkillContext, skillInstructions, skillMarkdown } from './skill.ts';
export { requiredScopes, type ScopeContext, TOOL_NAMES, type ToolName } from './tools.ts';
