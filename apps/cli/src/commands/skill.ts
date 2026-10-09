import { defineCommand } from 'citty';
import { t } from '../i18n.ts';

/** P9 WP 9.5 (owned by the MCP agent): `rooster skill print|install` (11 §6.2). */
export const skillCommand = defineCommand({
  meta: () => ({ name: 'skill', description: t('cmd.skill') }),
  async run() {},
});
