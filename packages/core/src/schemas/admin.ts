import { z } from 'zod';
import { timestampSchema } from './common.ts';

/** A bare domain such as `example.com` (lowercase, at least one dot, no scheme or path). */
export const DOMAIN_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isValidDomain(value: string): boolean {
  return DOMAIN_REGEX.test(value);
}

export const ALLOWLIST_KINDS = ['email', 'domain'] as const;
export const allowlistKindSchema = z.enum(ALLOWLIST_KINDS);

export const allowlistEntrySchema = z.object({
  id: z.string(),
  kind: allowlistKindSchema,
  value: z.string(),
  createdAt: timestampSchema,
});

/** POST /admin/allowlist. Values are compared case-insensitively and stored lowercase. */
export const allowlistCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), value: z.email().max(254) }),
  z.object({
    kind: z.literal('domain'),
    value: z
      .string()
      .trim()
      .toLowerCase()
      .refine(isValidDomain, { error: 'Expected a domain such as example.com' }),
  }),
]);

export const adminUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  createdAt: timestampSchema,
  disabledAt: timestampSchema.nullable(),
  isAdmin: z.boolean(),
});

export const adminUserPatchSchema = z.object({
  /** Disabling also revokes every session of the user. */
  disabled: z.boolean(),
});

export type AllowlistKind = z.infer<typeof allowlistKindSchema>;
export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;
export type AllowlistCreate = z.infer<typeof allowlistCreateSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminUserPatch = z.infer<typeof adminUserPatchSchema>;

/** One scheduled job's last run (`job_run`), as Admin → System shows it. */
export const adminJobRunSchema = z.object({
  job: z.string(),
  lastRunAt: timestampSchema.nullable(),
  lastStatus: z.enum(['ok', 'failed']).nullable(),
  lastError: z.string().nullable(),
});

/** GET /admin/system (08 §9, ADR 0052 §7). Instance admins only. */
export const adminSystemSchema = z.object({
  version: z.string(),
  gitSha: z.string().nullable(),
  startedAt: timestampSchema,
  database: z.object({
    sizeBytes: z.number().int().nonnegative(),
    walSizeBytes: z.number().int().nonnegative(),
  }),
  lastBackup: z
    .object({ name: z.string(), createdAt: timestampSchema, sizeBytes: z.number().int() })
    .nullable(),
  jobs: z.array(adminJobRunSchema),
  smtp: z.object({ configured: z.boolean() }),
  push: z.object({
    keySource: z.enum(['env', 'generated', 'none']),
    subscriptions: z.number().int().nonnegative(),
  }),
  sse: z.object({ connections: z.number().int().nonnegative() }),
  storage: z.object({
    backend: z.enum(['local', 's3']),
    attachmentBytes: z.number().int().nonnegative(),
    attachmentCount: z.number().int().nonnegative(),
    userQuotaBytes: z.number().int().positive().nullable(),
  }),
  counts: z.object({
    users: z.number().int().nonnegative(),
    orgs: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  }),
});

export type AdminJobRun = z.infer<typeof adminJobRunSchema>;
export type AdminSystem = z.infer<typeof adminSystemSchema>;
