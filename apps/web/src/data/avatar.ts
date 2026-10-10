import type { Schemas } from '@rooster/api-client';
import { AVATAR_MAX_BYTES } from '@rooster/core/limits';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { abortedErrorCode, sendMultipart } from './attachments';
import { ApiError } from './errors';
import { api, unwrap } from './http';
import { toMe } from './mappers';
import { queryKeys } from './query-keys';
import { sessionScope } from './session-events';
import type { MutationResult } from './types';

/**
 * The profile picture (FR-SET-1, 06 §2.1, ADR 0049 §3.7). Online-only: plain mutations, never the
 * outbox. The server stores a 256 px WebP and points `user.image` at `/api/v1/avatars/<id>?v=…`;
 * removing it brings back the sign-in provider's picture.
 */

/** The raster types the server accepts for an avatar (SVG never counts as an image). */
export const avatarMimeTypes = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
] as const;

/** True when `image` is a picture uploaded to rooster (not the provider's). */
export function isUploadedAvatar(image: string | null | undefined, userId: string): boolean {
  return Boolean(image?.startsWith(`/api/v1/avatars/${userId}`));
}

/**
 * Checked before sending, so an obviously wrong file gets its message without a round trip; the
 * server checks again (it sniffs the type).
 */
export function avatarFileProblem(file: Pick<File, 'type' | 'size'>): 'type' | 'size' | null {
  if (!(avatarMimeTypes as readonly string[]).includes(file.type)) return 'type';
  if (file.size > AVATAR_MAX_BYTES) return 'size';
  return null;
}

/** Every cache that shows people's pictures picks up the new one. */
function refreshPictures(queryClient: QueryClient, me: Schemas['Me']): Promise<unknown> {
  queryClient.setQueryData(queryKeys.me, toMe(me));
  return Promise.all(
    ['org-members', 'everyone', 'activity', 'notifications'].map((root) =>
      queryClient.invalidateQueries({ queryKey: [root] }),
    ),
  );
}

/** `PUT /me/avatar` (multipart `file`, a raster image of at most 2 MB) → `Me`. */
export function useUploadAvatar(): MutationResult<File> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const problem = avatarFileProblem(file);
      if (problem) {
        throw new ApiError(problem === 'size' ? 'payload_too_large' : 'unsupported_media_type', 0);
      }
      const request = sendMultipart<Schemas['Me']>('PUT', '/api/v1/me/avatar', file, file.name);
      const scope = sessionScope(request.abort);
      try {
        const me = await request.promise;
        // Another account may have taken over this tab meanwhile: its profile stays.
        if (scope.stale()) throw new ApiError(abortedErrorCode, 0);
        await refreshPictures(queryClient, me);
      } finally {
        scope.done();
      }
    },
  });
}

/** `DELETE /me/avatar` → `Me`, with the provider's picture back. */
export function useRemoveAvatar(): MutationResult<void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const scope = sessionScope();
      const me = await unwrap(api.DELETE('/api/v1/me/avatar'));
      if (scope.stale()) throw new ApiError(abortedErrorCode, 0);
      await refreshPictures(queryClient, me);
    },
  });
}
