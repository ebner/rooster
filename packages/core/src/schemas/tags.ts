import { z } from 'zod';
import { idSchema, timestampSchema } from './common.ts';
import { tagColorSchema } from './org.ts';
import { nameSchema } from './text.ts';

/** P3 tag contract (01 FR-TAG, 05 §3 `tag`/`task_tag`, 06 §2.4–2.5). Names are unique per org, case-insensitively. */
export const TAG_NAME_MAX = 40;
export const tagNameSchema = nameSchema(TAG_NAME_MAX);

export const tagSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  name: z.string(),
  color: tagColorSchema,
  createdAt: timestampSchema,
});

/** Without a colour the server picks the next palette colour (round-robin per org). */
export const tagCreateSchema = z.object({
  id: idSchema.optional(),
  name: tagNameSchema,
  color: tagColorSchema.optional(),
});

export const tagPatchSchema = z
  .object({ name: tagNameSchema.optional(), color: tagColorSchema.optional() })
  .refine((v) => v.name !== undefined || v.color !== undefined, { error: 'Nothing to update' });

/** POST /tags/:id/merge — every task tagged with :id gets `intoId`, then :id is deleted. */
export const tagMergeSchema = z.object({ intoId: idSchema });

export type Tag = z.infer<typeof tagSchema>;
export type TagCreate = z.infer<typeof tagCreateSchema>;
export type TagPatch = z.infer<typeof tagPatchSchema>;
export type TagMerge = z.infer<typeof tagMergeSchema>;
