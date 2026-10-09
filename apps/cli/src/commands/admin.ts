import { ADMIN_SCOPE } from '@rooster/core/grants';
import { defineCommand } from 'citty';
import { RoosterApiError, unwrap } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { t } from '../i18n.ts';
import { needs } from './util.ts';

const reindexCommand = defineCommand({
  meta: () => ({ name: 'reindex', description: t('admin.cmd.reindex') }),
  async run() {
    const runtime = needs(ADMIN_SCOPE);
    const api = await runtime.api();
    let result: { indexed: number; durationMs: number };
    try {
      result = await unwrap(api.POST('/api/v1/admin/search/reindex'));
    } catch (error) {
      // Without the capability (or when the user is no longer an instance admin) the server
      // answers 403; say how to get a login that may do this (ADR 0041 §7).
      if (error instanceof RoosterApiError && error.status === 403) {
        throw new CliError(EXIT.auth, t('admin.needsAdmin'), error.code);
      }
      throw error;
    }
    const { out } = runtime;
    if (out.json) out.data(result);
    else if (out.quiet) out.line(String(result.indexed));
    else out.notice(t('admin.reindexed', { count: result.indexed, ms: result.durationMs }));
  },
});

/** `rooster admin …` (WP 9.6): instance administration with the `admin` capability. */
export const adminCommand = defineCommand({
  meta: () => ({ name: 'admin', description: t('cmd.admin') }),
  subCommands: { reindex: reindexCommand },
});
