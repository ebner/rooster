import { z } from 'zod';
import { idSchema, timestampSchema } from './common.ts';

/**
 * Phase 10 calendar feeds (FR-CAL, 05 §3 `ical_feed`, 06 §2.8, ADR 0049). The feed URL embeds
 * a secret token that the server stores only hashed, so it is returned once, on creation.
 */

export const icalFeedSchema = z.object({
  id: idSchema,
  /** The org the feed covers; null = all of the user's orgs. */
  orgId: idSchema.nullable(),
  createdAt: timestampSchema,
  /** The last time a calendar fetched it (updated at most every few minutes). */
  lastUsedAt: timestampSchema.nullable(),
});

/** POST /me/ical-feeds. `replaces` regenerates: that feed is revoked in the same transaction. */
export const icalFeedCreateSchema = z.object({
  orgId: idSchema.nullable().optional(),
  replaces: idSchema.optional(),
});

/** The created feed and its secret URL (`<base>/ical/<token>.ics`), shown once. */
export const icalFeedCreatedSchema = z.object({ feed: icalFeedSchema, url: z.url() });

export const icalFeedListSchema = z.array(icalFeedSchema);

export type IcalFeed = z.infer<typeof icalFeedSchema>;
export type IcalFeedCreate = z.infer<typeof icalFeedCreateSchema>;
export type IcalFeedCreated = z.infer<typeof icalFeedCreatedSchema>;
