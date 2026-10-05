import { z } from 'zod';
import { timestampSchema } from './common.ts';

/**
 * Database snapshots in `<dataDir>/backups` (08 §7, 06 §2.10). File names encode kind and
 * time: `rooster-<ts>.db` (scheduled; a Sunday snapshot counts as weekly), `manual-<ts>.db`
 * (admin "back up now") and `pre-migrate-<ts>.db` (boot, before migrations), where `<ts>`
 * is the UTC ISO instant with `:` and `.` replaced by `-`.
 */
export const BACKUP_NAME_REGEX =
  /^(rooster|manual|pre-migrate)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;

export const BACKUP_KINDS = ['daily', 'weekly', 'manual', 'pre-migrate'] as const;
export const backupKindSchema = z.enum(BACKUP_KINDS);

export const backupNameSchema = z
  .string()
  .regex(BACKUP_NAME_REGEX, { error: 'Not a backup file name' });

export const backupSchema = z.object({
  name: z.string(),
  /** Bytes. */
  size: z.int().nonnegative(),
  createdAt: timestampSchema,
  kind: backupKindSchema,
});

export type BackupKind = z.infer<typeof backupKindSchema>;
export type Backup = z.infer<typeof backupSchema>;
