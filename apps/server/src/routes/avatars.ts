import { Readable } from 'node:stream';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { DOWNLOAD_CSP, multipartFile, uploadProblems, uploadRequestOf } from './attachments.ts';
import { ANY_CREDENTIAL, AUTHED, actorOf, idParam, json, problems } from './common.ts';
import { MeSchema } from './schemas.ts';

const putAvatar = createRoute({
  method: 'put',
  path: '/api/v1/me/avatar',
  tags: ['me'],
  operationId: 'putAvatar',
  summary: 'Upload my avatar (multipart, browser session only)',
  description:
    'One multipart part named `file`: a PNG, JPEG, GIF, WebP or AVIF image of at most 2 MB (`413` above). It is cropped to a 256 × 256 WebP and `image` becomes `/api/v1/avatars/<userId>?v=<time>`. The sign-in provider’s picture is kept for `DELETE`, and signing in again never replaces the upload.',
  request: { body: multipartFile('The image.') },
  responses: {
    200: json(MeSchema, 'The updated user'),
    ...uploadProblems('2 MB', ...AUTHED, 'mime_mismatch'),
  },
});

const deleteAvatar = createRoute({
  method: 'delete',
  path: '/api/v1/me/avatar',
  tags: ['me'],
  operationId: 'deleteAvatar',
  summary: 'Remove my uploaded avatar (browser session only)',
  description:
    'Back to the sign-in provider’s picture. Without an uploaded avatar nothing changes.',
  responses: { 200: json(MeSchema, 'The updated user'), ...problems(...AUTHED) },
});

const getAvatar = createRoute({
  method: 'get',
  path: '/api/v1/avatars/{userId}',
  tags: ['me'],
  operationId: 'getAvatar',
  summary: 'A user’s uploaded avatar',
  description:
    'For anyone who shares an organisation with the user (and the user), otherwise `404`. The `?v=` of the `image` URL changes with every upload, so the response may be cached for a day.',
  request: { params: z.object({ userId: idParam('userId', 'User ID') }) },
  responses: {
    200: {
      description: 'The 256 × 256 WebP image',
      headers: {
        'Cache-Control': { description: '`private, max-age=86400`', schema: { type: 'string' } },
      },
      content: { 'image/webp': { schema: { type: 'string' as const, format: 'binary' } } },
    },
    ...problems(401, 404, ANY_CREDENTIAL),
  },
});

/** Avatar upload and download (06 §2.1, FR-SET-1, ADR 0049 §3.7). */
export function registerAvatarRoutes(app: OpenAPIHono<AppEnv>, { avatars }: Services): void {
  app.openapi(putAvatar, async (c) =>
    c.json(await avatars.put(actorOf(c), uploadRequestOf(c)), 200),
  );
  app.openapi(deleteAvatar, async (c) => c.json(await avatars.remove(actorOf(c)), 200));
  app.openapi(getAvatar, async (c) => {
    const blob = await avatars.get(actorOf(c), c.req.valid('param').userId);
    const headers: Record<string, string> = {
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': DOWNLOAD_CSP,
    };
    if (blob.size !== null) headers['Content-Length'] = String(blob.size);
    return c.body(Readable.toWeb(blob.stream) as ReadableStream<Uint8Array>, 200, headers);
  });
}
