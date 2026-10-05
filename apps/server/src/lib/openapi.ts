import { z } from '@hono/zod-openapi';

/**
 * Registers a shared schema from @rooster/core as a named OpenAPI component.
 *
 * Zod 4 copies methods onto each schema instance when it is constructed, so a core schema
 * created before `@hono/zod-openapi` was first imported has no `.openapi()`. A clone is
 * constructed now, after the extension, and behaves identically.
 */
export function named<T extends z.ZodType>(schema: T, name: string): T {
  return schema.clone().openapi(name) as T;
}

export { z };
