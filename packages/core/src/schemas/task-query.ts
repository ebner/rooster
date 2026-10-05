import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.ts';
import { taskSchema } from './list.ts';

/**
 * Query shapes for the list reads (06 §2.3–2.4). Query-string values arrive as strings, so
 * numbers are coerced.
 */

export const PAGE_LIMIT_DEFAULT = 50;
const tagFilterValue = z.string().min(1).max(64);
export const PAGE_LIMIT_MAX = 200;

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
  /** Opaque; pass back `nextCursor` from the previous page. */
  cursor: z.string().min(1).max(512).optional(),
});

export const myListQuerySchema = z.object({
  /** ms epoch; completed tasks completed at or after this are included. Default: now − 14 d. */
  completedSince: z.coerce.number().int().nonnegative().optional(),
});

/**
 * `my`: my list. `today`: due today or earlier. `week`: due within the next 7 days
 * (today … today + 6). `overdue`: past due (a timed due counts once its instant passed).
 * `nodate`: no due date. Dates are evaluated in the actor's timezone; every view except
 * `my` covers the tasks assigned to the actor. `everyone` arrives in Phase 6.
 */
export const TASK_VIEWS = ['my', 'today', 'week', 'overdue', 'nodate'] as const;
export const taskViewSchema = z.enum(TASK_VIEWS);

export const taskCompletedFilterSchema = z.enum(['false', 'true', 'any']);

export const taskQuerySchema = pageQuerySchema.extend({
  view: taskViewSchema.optional(),
  /** One of the actor's groups; implies `view=my` placement semantics. */
  groupId: idSchema.optional(),
  /** Default `false` (open tasks only). */
  completed: taskCompletedFilterSchema.optional(),
  dueFrom: isoDateSchema.optional(),
  dueTo: isoDateSchema.optional(),
  /**
   * P3. Repeatable (`?tag=a&tag=b`), AND-combined: only tasks carrying every tag. A value is a
   * tag ID, or else a tag name (case-insensitive). An unknown tag matches nothing.
   */
  tag: z.union([tagFilterValue, z.array(tagFilterValue).max(20)]).optional(),
  /** P5. Full-text query in the `parseSearchQuery` grammar (`@rooster/core/search`). */
  q: z.string().trim().min(1).max(200).optional(),
});

export const taskPageSchema = z.object({
  items: z.array(taskSchema),
  nextCursor: z.string().nullable(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;
export type MyListQuery = z.infer<typeof myListQuerySchema>;
export type TaskView = z.infer<typeof taskViewSchema>;
export type TaskCompletedFilter = z.infer<typeof taskCompletedFilterSchema>;
export type TaskQuery = z.infer<typeof taskQuerySchema>;
export type TaskPage = z.infer<typeof taskPageSchema>;
