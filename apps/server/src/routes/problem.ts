import { problemSchema } from '@rooster/core/schemas';
import { describe, named, z } from '../lib/openapi.ts';

/**
 * RFC 9457 problem document, as produced by lib/errors.ts (schema shared via @rooster/core),
 * with the extension members the server sends.
 */
export const ProblemSchema = named(
  describe(
    problemSchema.extend({
      candidates: z
        .array(
          z.object({
            id: z.string(),
            orgId: z.string(),
            seq: z.int().nullable(),
            title: z.string(),
          }),
        )
        .optional(),
      members: z.array(z.object({ userId: z.string(), name: z.string() })).optional(),
      usedBytes: z.int().nonnegative().optional(),
    }),
    {
      code: 'Stable, machine-readable error code; branch on this, never on `title` or `detail`.',
      errors: '`422 validation_failed`: the fields that failed, as `{path, message}`.',
      existingId:
        '`409 tag_name_taken`: the ID of the entity that already has the name, so an offline client can remap its own.',
      candidates:
        '`409 ambiguous_ref` (`GET /tasks/resolve`): the tasks the ref could mean, at most 10.',
      members:
        '`409 ambiguous_member` (`GET /orgs/{orgId}/members/resolve`): the members the query could mean, at most 10, by name (never with emails).',
      limitBytes:
        '`413 payload_too_large` on an upload: the size limit in bytes; `413 storage_quota_exceeded`: the user’s storage quota in bytes.',
      usedBytes:
        '`413 storage_quota_exceeded`: the bytes the user’s attachments already take (`limitBytes - usedBytes` is what is left).',
    },
  ),
  'Problem',
);
