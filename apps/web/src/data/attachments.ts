import type { Attachment, TaskDetail } from '@rooster/core/schemas';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from './errors';
import { api, sessionClosedCode, toApiError, unwrap } from './http';
import { myListKey } from './list';
import { queryKeys } from './query-keys';
import { isSessionClosed } from './session-events';
import { taskDetailKey } from './task-detail';
import type { MutationResult } from './types';

/**
 * Attachments (FR-ATT, 06 §2.7, ADR 0049 §3). Uploads are online-only multipart requests: they
 * never go through the outbox (hard rule 4 covers list mutations; a file is not an op), and
 * XHR rather than `fetch` gives upload progress.
 */

/** `GET /attachments/:id`: downloads (`Content-Disposition: attachment`). */
export function attachmentUrl(id: string, options: { inline?: boolean } = {}): string {
  const path = `/api/v1/attachments/${encodeURIComponent(id)}`;
  return options.inline ? `${path}?inline=1` : path;
}

/** `GET /attachments/:id/thumb`: the 320 px WebP thumbnail of a raster image. */
export function thumbnailUrl(id: string): string {
  return `/api/v1/attachments/${encodeURIComponent(id)}/thumb`;
}

/**
 * `GET /meta` → `uploadMaxBytes` (`ROOSTER_UPLOAD_MAX_MB`): files above it are refused before
 * anything is sent. Undefined until known (or from a server that does not say); the server's
 * 413 still applies then.
 */
export function useUploadLimit(): number | undefined {
  return (
    useQuery({
      queryKey: [...queryKeys.meta, 'upload-limit'],
      queryFn: async () => {
        const meta: { uploadMaxBytes?: number } = await unwrap(api.GET('/api/v1/meta'));
        return meta.uploadMaxBytes ?? null;
      },
      staleTime: 5 * 60_000,
    }).data ?? undefined
  );
}

/** Thrown when the network fails or the request is aborted (no HTTP status). */
export const networkErrorCode = 'network';
export const abortedErrorCode = 'aborted';

export interface MultipartUpload<T> {
  promise: Promise<T>;
  abort: () => void;
}

/**
 * Sends one multipart `file` field with XHR, reporting progress as a fraction (0…1). Same-origin,
 * so the session cookie and the Origin header (the CSRF check, 06 §1) go with it; the client
 * name matches `createRoosterClient({clientName: 'web'})`. Non-2xx answers reject with an
 * `ApiError` from the problem+json body (or `http_<status>` when a proxy answered).
 */
export function sendMultipart<T>(
  method: 'POST' | 'PUT',
  path: string,
  file: Blob,
  filename: string,
  onProgress?: (fraction: number) => void,
): MultipartUpload<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    if (isSessionClosed()) {
      reject(new ApiError(sessionClosedCode, 0));
      return;
    }
    xhr.open(method, `${globalThis.location?.origin ?? ''}${path}`);
    xhr.setRequestHeader('X-Rooster-Client', 'web');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      const body = parseJson(xhr.responseText);
      // Sent before the session closed: the answer belongs to an account that is gone here.
      if (isSessionClosed()) reject(new ApiError(sessionClosedCode, 0));
      else if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(toApiError(body, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError(networkErrorCode, 0));
    xhr.onabort = () => reject(new ApiError(abortedErrorCode, 0));
    const form = new FormData();
    form.append('file', file, filename);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `POST /tasks/:id/attachments` (multipart `file`) → the new `Attachment` (201). */
export function uploadAttachment(
  taskId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): MultipartUpload<Attachment> {
  return sendMultipart<Attachment>(
    'POST',
    `/api/v1/tasks/${encodeURIComponent(taskId)}/attachments`,
    file,
    file.name,
    onProgress,
  );
}

/**
 * After an upload or a delete: the pane shows the change at once (the detail cache), and the row
 * (`counts.attachments`), Everyone's tasks and the activity feed (`attachment_added`) refetch.
 */
export function afterAttachmentChange(
  queryClient: QueryClient,
  orgId: string,
  taskId: string,
  change: { added: Attachment } | { removed: string },
): Promise<unknown> {
  queryClient.setQueryData<TaskDetail>(taskDetailKey(taskId), (detail) => {
    if (!detail) return detail;
    const current = detail.attachments ?? [];
    const next =
      'added' in change
        ? [...current.filter((a) => a.id !== change.added.id), change.added]
        : current.filter((a) => a.id !== change.removed);
    return {
      ...detail,
      attachments: next,
      counts: { ...detail.counts, attachments: next.length },
    };
  });
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: taskDetailKey(taskId) }),
    queryClient.invalidateQueries({ queryKey: myListKey(orgId) }),
    queryClient.invalidateQueries({ queryKey: ['everyone', orgId] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.activity(taskId) }),
  ]);
}

export interface AttachmentRef {
  orgId: string;
  taskId: string;
  id: string;
}

/** `DELETE /attachments/:id`: the uploader or the task's assignee; there is no undo. */
export function useDeleteAttachment(): MutationResult<AttachmentRef> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: AttachmentRef) => {
      await unwrap(api.DELETE('/api/v1/attachments/{id}', { params: { path: { id } } }));
    },
    onSuccess: (_data, { orgId, taskId, id }) =>
      afterAttachmentChange(queryClient, orgId, taskId, { removed: id }),
  });
}
