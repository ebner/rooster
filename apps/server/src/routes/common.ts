import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/context.ts';
import { AppError } from '../lib/errors.ts';
import type { Actor } from '../services/index.ts';
import { ProblemSchema } from './problem.ts';

type ProblemStatus = 401 | 403 | 404 | 409 | 410 | 415 | 422;

const STATUS_TEXT: Record<ProblemStatus, string> = {
  401: 'Not signed in',
  403: 'Not allowed (owner or admin only, or a cross-origin request)',
  404: 'Not found, or not a member (existence is never revealed)',
  409: 'Conflicts with the current state',
  410: 'The invite can no longer be used',
  415: 'Not JSON',
  422: 'Validation failed',
};

/** problem+json responses for the given statuses, for the OpenAPI document. */
export function problems(...statuses: ProblemStatus[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: STATUS_TEXT[status],
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    ]),
  ) as Record<
    number,
    {
      description: string;
      content: { 'application/problem+json': { schema: typeof ProblemSchema } };
    }
  >;
}

/** Errors every authenticated mutation can return. */
export const AUTHED: ProblemStatus[] = [401, 403, 415, 422];

export function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

export function body<T extends z.ZodType>(schema: T) {
  return { required: true, content: { 'application/json': { schema } } };
}

export const orgIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: 'orgId', in: 'path' },
    description: 'Org ID, slug, or `personal` for your personal org.',
    example: 'personal',
  });

export function idParam(name: string, description: string) {
  return z
    .string()
    .min(1)
    .openapi({ param: { name, in: 'path' }, description });
}

/** The actor set by the actor middleware; every non-public route has one. */
export function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) throw new AppError('unauthenticated', 401, 'Sign in to continue.');
  return actor;
}
