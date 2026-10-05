import { problemSchema } from '@rooster/core/schemas';
import { named } from '../lib/openapi.ts';

/** RFC 9457 problem document, as produced by lib/errors.ts (schema shared via @rooster/core). */
export const ProblemSchema = named(problemSchema, 'Problem');
