import type { Attachment } from '@rooster/core/schemas';
import { create } from 'zustand';
import type { MultipartUpload } from '../../data/attachments';
import { ApiError } from '../../data/errors';
import { problemLimitBytes, type UploadErrorKind, uploadErrorKind } from './model';

/** One file on its way up, or one that failed (kept until dismissed or retried). */
export interface PendingUpload {
  id: string;
  taskId: string;
  name: string;
  size: number;
  /** 0…1. */
  progress: number;
  status: 'queued' | 'uploading' | 'failed';
  error?: UploadErrorKind | undefined;
  /** The limit a 413 named, when the server sent it. */
  limitBytes?: number | undefined;
}

interface UploadEntry extends PendingUpload {
  file: File;
  /** The server's upload limit (`/meta`), when known. */
  maxBytes?: number | undefined;
  abort?: (() => void) | undefined;
}

export type Uploader = (
  file: File,
  onProgress: (fraction: number) => void,
) => MultipartUpload<Attachment>;

interface UploadStore {
  entries: UploadEntry[];
}

/**
 * Uploads live outside the pane, so closing it (or opening another task) neither cancels them
 * nor loses their progress; reopening the task shows where they are.
 */
export const useUploadStore = create<UploadStore>()(() => ({ entries: [] }));

let nextId = 0;
/** One chain per task: files go up one after another, in the order they were added. */
const chains = new Map<string, Promise<void>>();

function patch(id: string, change: Partial<UploadEntry>) {
  useUploadStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === id ? { ...e, ...change } : e)),
  }));
}

function remove(id: string) {
  useUploadStore.setState((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
}

function run(entry: UploadEntry, upload: Uploader, onDone: (attachment: Attachment) => void) {
  const previous = chains.get(entry.taskId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const current = useUploadStore.getState().entries.find((e) => e.id === entry.id);
    if (current?.status !== 'queued') return;
    const request = upload(entry.file, (progress) => patch(entry.id, { progress }));
    patch(entry.id, { status: 'uploading', progress: 0, abort: request.abort });
    try {
      const attachment = await request.promise;
      remove(entry.id);
      onDone(attachment);
    } catch (error) {
      const api = error instanceof ApiError ? error : null;
      if (api?.code === 'aborted') {
        remove(entry.id);
        return;
      }
      // Files over the known limit never get here (`startUploads`); a 502 from a proxy or a
      // reset connection is then a plain failure, offered for retry.
      patch(entry.id, {
        status: 'failed',
        abort: undefined,
        error: uploadErrorKind(api),
        limitBytes: problemLimitBytes(api?.problem) ?? entry.maxBytes,
      });
    }
  });
  chains.set(entry.taskId, next);
}

/**
 * Queues `files` for the task; `onDone` runs for each one the server took. A file over the
 * server's limit (`maxBytes`, from `/meta`) fails at once with the limit message and is never
 * sent (AC-10.2).
 */
export function startUploads(
  taskId: string,
  files: readonly File[],
  upload: Uploader,
  onDone: (attachment: Attachment) => void,
  maxBytes?: number,
): void {
  for (const file of files) {
    nextId += 1;
    const tooLarge = maxBytes !== undefined && file.size > maxBytes;
    const entry: UploadEntry = {
      id: `upload-${nextId}`,
      taskId,
      name: file.name,
      size: file.size,
      progress: 0,
      status: tooLarge ? 'failed' : 'queued',
      file,
      maxBytes,
      ...(tooLarge ? { error: 'tooLarge' as const, limitBytes: maxBytes } : {}),
    };
    useUploadStore.setState((s) => ({ entries: [...s.entries, entry] }));
    if (!tooLarge) run(entry, upload, onDone);
  }
}

/** Tries a failed upload again, at the end of the task's queue. */
export function retryUpload(id: string, upload: Uploader, onDone: (a: Attachment) => void): void {
  const entry = useUploadStore.getState().entries.find((e) => e.id === id);
  if (entry?.status !== 'failed') return;
  patch(id, { status: 'queued', progress: 0, error: undefined, limitBytes: undefined });
  run({ ...entry, status: 'queued' }, upload, onDone);
}

/** Cancels an upload in flight, or drops a queued or failed one. */
export function dismissUpload(id: string): void {
  const entry = useUploadStore.getState().entries.find((e) => e.id === id);
  if (!entry) return;
  if (entry.status === 'uploading' && entry.abort) entry.abort();
  else remove(id);
}

/** Test seam: forget every upload. */
export function resetUploads(): void {
  chains.clear();
  useUploadStore.setState({ entries: [] });
}

/** The public shape of a task's uploads (without the file and the abort handle). */
export function pendingFor(entries: readonly UploadEntry[], taskId: string): PendingUpload[] {
  return entries
    .filter((e) => e.taskId === taskId)
    .map(({ file: _file, abort: _abort, maxBytes: _max, ...rest }) => rest);
}
