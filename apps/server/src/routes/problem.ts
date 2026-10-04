import { problemSchema } from '@rooster/core/schemas';

/** RFC 9457 problem document, as produced by lib/errors.ts (schema shared via @rooster/core). */
export const ProblemSchema = problemSchema.openapi('Problem');
