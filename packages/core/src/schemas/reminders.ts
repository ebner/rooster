import { z } from 'zod';
import { REMINDER_OFFSET_MAX, REMINDERS_MAX } from '../limits.ts';
import { idSchema, timestampSchema } from './common.ts';

/**
 * Phase 10 task reminders (FR-REM, 05 §3 `task_reminder`, 06 §2.4, ADR 0049). Reminders are
 * personal: every route acts on the requesting user's own reminders only.
 */

export { REMINDER_OFFSET_MAX, REMINDERS_MAX } from '../limits.ts';

export const reminderKindSchema = z.enum(['relative', 'absolute']);

/** Minutes before the due moment: 0 = at the due time, up to four weeks. */
export const reminderOffsetSchema = z.int().min(0).max(REMINDER_OFFSET_MAX);

/** A reminder as task create/PATCH take it: relative (`offsetMinutes`) or absolute (`at`). */
export const reminderSpecSchema = z.union([
  z.strictObject({ offsetMinutes: reminderOffsetSchema }),
  z.strictObject({ at: timestampSchema }),
]);

/**
 * POST /tasks/:id/reminders. `id` lets the outbox replay the create idempotently (ADR 0028).
 * `422 reminder_needs_due` for a relative reminder on a task without a due date,
 * `422 reminder_in_past` for an absolute one more than a minute in the past,
 * `409 too_many_reminders` beyond `REMINDERS_MAX`. An identical existing reminder is returned
 * as it is (200) instead of being duplicated.
 */
export const reminderCreateSchema = z.union([
  z.strictObject({ id: idSchema.optional(), offsetMinutes: reminderOffsetSchema }),
  z.strictObject({ id: idSchema.optional(), at: timestampSchema }),
]);

export const reminderSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  kind: reminderKindSchema,
  /** Relative: minutes before the due moment. Null for absolute reminders. */
  offsetMinutes: reminderOffsetSchema.nullable(),
  /** Absolute: the chosen instant. Null for relative reminders. */
  remindAt: timestampSchema.nullable(),
  /**
   * When it fires (ms epoch), resolved from the due moment (FR-REM-2). Null = dormant: a
   * relative reminder on a task whose due date was removed; it comes back when a due date is
   * set again (ADR 0049).
   */
  fireAt: timestampSchema.nullable(),
  /** When it fired (or was skipped because the task was done); null while pending. */
  firedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});

/** GET /tasks/:id/reminders: the requesting user's reminders on the task, by `fireAt`. */
export const reminderListSchema = z.array(reminderSchema);

export type ReminderKindValue = z.infer<typeof reminderKindSchema>;
export type ReminderSpecInput = z.infer<typeof reminderSpecSchema>;
export type ReminderCreate = z.infer<typeof reminderCreateSchema>;
export type Reminder = z.infer<typeof reminderSchema>;
