import { defineCommand } from 'citty';
import { t } from '../i18n.ts';

/** P9 WP 9.6 (owned by the MCP agent): `rooster admin reindex` with the `admin` capability. */
export const adminCommand = defineCommand({
  meta: () => ({ name: 'admin', description: t('cmd.admin') }),
  async run() {},
});
