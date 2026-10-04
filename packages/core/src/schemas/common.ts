import { z } from 'zod';
import { DATE_FORMATS, LOCALES, TIME_FORMATS } from '../dates/format.ts';
import { isValidIsoDate, isValidTime } from '../dates/iso.ts';
import { UUIDV7_REGEX } from '../ids.ts';

export const idSchema = z.string().regex(UUIDV7_REGEX, { error: 'Expected a UUIDv7' });

/** Floating calendar date `YYYY-MM-DD`; rejects impossible dates such as 2026-02-30. */
export const isoDateSchema = z
  .string()
  .refine(isValidIsoDate, { error: 'Expected a calendar date (YYYY-MM-DD)' });

/** Wall-clock time `HH:MM`, 00:00–23:59. */
export const timeSchema = z.string().refine(isValidTime, { error: 'Expected a time (HH:MM)' });

/** Milliseconds since the epoch (UTC). */
export const timestampSchema = z.int().nonnegative();

export const localeSchema = z.enum(LOCALES);
export const dateFormatSchema = z.enum(DATE_FORMATS);
export const timeFormatSchema = z.enum(TIME_FORMATS);
/** 0 = Sunday, 1 = Monday. */
export const weekStartSchema = z.union([z.literal(0), z.literal(1)]);

export const problemFieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** RFC 9457 problem details with Rooster's stable `code` (04 §4.10). */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().min(1),
  errors: z.array(problemFieldErrorSchema).optional(),
});

/** GET /api/v1/meta (06). */
export const metaSchema = z.object({
  version: z.string(),
  gitSha: z.string(),
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
  features: z.object({ email: z.boolean(), push: z.boolean(), s3: z.boolean() }),
});

export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;
export type Problem = z.infer<typeof problemSchema>;
export type Meta = z.infer<typeof metaSchema>;
