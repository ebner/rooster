import { defineCommand } from 'citty';
import { t } from '../i18n.ts';

/**
 * P9 WP 9.2 (owned by the MCP agent): `rooster mcp [--read-only]` serves the MCP tools on stdio
 * with the profile's grant, and `rooster mcp setup` creates a dedicated agent profile through the
 * device flow and writes or prints the client config (07 §4, §6; 11 §5.1).
 */
export const mcpCommand = defineCommand({
  meta: () => ({ name: 'mcp', description: t('cmd.mcp') }),
  async run() {},
});
