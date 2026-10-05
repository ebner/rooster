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
