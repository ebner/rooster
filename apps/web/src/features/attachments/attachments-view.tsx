import type { Attachment } from '@rooster/core/schemas';
import {
  CircleAlert,
  CloudOff,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
  Paperclip,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { type DisplayPrefs, formatDay } from '../../lib/format';
import { Button, iconStrokeWidth, Spinner } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import {
  canDeleteAttachment,
  type FileKind,
  fileKind,
  formatBytes,
  splitAttachments,
} from './model';
import type { PendingUpload } from './upload-store';

const kindIcons: Record<FileKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  text: FileText,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  code: FileCode,
  other: File,
};

export interface AttachmentsViewProps {
  /** Undefined while the task detail loads. */
  attachments: readonly Attachment[] | undefined;
  uploads: readonly PendingUpload[];
  userId: string;
  assigneeId: string | null;
  /** Display names by user id (uploader). */
  nameOf: (userId: string) => string | undefined;
  prefs: DisplayPrefs;
  now: number;
  online: boolean;
  /** The most attachments a task may have (for the 409 message). */
  maxAttachments: number;
  thumbSrc: (attachment: Attachment) => string;
  downloadHref: (attachment: Attachment) => string;
  onPick: () => void;
  onOpenImage: (attachment: Attachment, trigger: HTMLElement | null) => void;
  /** Rejects when the delete failed (the caller reports it); the confirm then stays open. */
  onDelete: (attachment: Attachment) => Promise<void>;
  onRetry: (uploadId: string) => void;
  onDismiss: (uploadId: string) => void;
  /** Kitchen sink: start with this attachment's delete confirm open. */
  initialConfirmId?: string | undefined;
}

/**
 * The pane's attachments (02 §9.2 item 7, FR-ATT): raster images as a thumbnail grid that opens
 * the lightbox, every other file as a row that downloads, uploads with their progress or error,
 * and an inline delete confirm (there is no undo, ADR 0049 §3.6).
 */
export function AttachmentsView({
  attachments,
  uploads,
  userId,
  assigneeId,
  nameOf,
  prefs,
  now,
  online,
  maxAttachments,
  thumbSrc,
  downloadHref,
  onPick,
  onOpenImage,
  onDelete,
  onRetry,
  onDismiss,
  initialConfirmId,
}: AttachmentsViewProps) {
  const { t } = useTranslation('attachments');
  const headingId = useId();
  const [confirmId, setConfirmId] = useState<string | null>(initialConfirmId ?? null);
  const [deleting, setDeleting] = useState(false);
  const deleteButtons = useRef(new Map<string, HTMLElement>());
  const addButton = useRef<HTMLDivElement>(null);
  const { images, files } = splitAttachments(attachments ?? []);
  const total = (attachments?.length ?? 0) + uploads.filter((u) => u.status !== 'failed').length;
  const confirming = attachments?.find((a) => a.id === confirmId) ?? null;
  const mayDelete = (a: Attachment) => online && canDeleteAttachment(a, userId, assigneeId);

  const askDelete = (attachment: Attachment) => setConfirmId(attachment.id);
  const cancelDelete = () => {
    const id = confirmId;
    setConfirmId(null);
    if (id) requestAnimationFrame(() => deleteButtons.current.get(id)?.focus());
  };
  const confirmDelete = async () => {
    if (!confirming) return;
    setDeleting(true);
    try {
      await onDelete(confirming);
      setConfirmId(null);
      addButton.current?.querySelector('button')?.focus();
    } catch {
      // Reported by the caller; the confirm stays for a retry.
    } finally {
      setDeleting(false);
    }
  };
  const registerDelete = (id: string) => (el: HTMLElement | null) => {
    if (el) deleteButtons.current.set(id, el);
    else deleteButtons.current.delete(id);
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2"
      data-testid="pane-attachments"
    >
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="flex items-baseline gap-2 text-sm font-semibold text-text">
          {t('heading')}
          {total > 0 && (
            <span className="font-normal text-text-muted tabular-nums">
              {t('count', { count: total })}
            </span>
          )}
        </h2>
        <div ref={addButton} className="inline-flex">
          <IconButton
            icon={Paperclip}
            size="sm"
            aria-label={t('add')}
            shortcut={primaryKeys('attachFile')}
            isDisabled={!online}
            onPress={onPick}
            data-testid="attach-files"
          />
        </div>
      </div>

      {!online ? (
        <p
          className="flex items-start gap-2 text-sm text-text-muted"
          data-testid="attachments-offline"
        >
          <CloudOff className="mt-0.5 size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
          {t('offline')}
        </p>
      ) : (
        attachments !== undefined &&
        attachments.length === 0 &&
        uploads.length === 0 && (
          <p className="text-sm text-text-muted">
            {t('empty')}{' '}
            <Button variant="link" size="sm" className="text-sm" onPress={onPick}>
              {t('emptyPick')}
            </Button>
            .
          </p>
        )
      )}

      {uploads.length > 0 && (
        <ul className="flex flex-col gap-2" aria-live="polite" data-testid="attachment-uploads">
          {uploads.map((upload) => (
            <UploadRow
              key={upload.id}
              upload={upload}
              locale={prefs.locale}
              maxAttachments={maxAttachments}
              onRetry={() => onRetry(upload.id)}
              onDismiss={() => onDismiss(upload.id)}
            />
          ))}
        </ul>
      )}

      {images.length > 0 && (
        <ul
          aria-label={t('imagesLabel')}
          className="grid grid-cols-3 gap-3"
          data-testid="attachment-images"
        >
          {images.map((image) => (
            <li key={image.id} className="flex min-w-0 flex-col gap-1">
              <AriaButton
                aria-label={t('open', { name: image.filename })}
                onPress={(event) =>
                  onOpenImage(image, event.target instanceof HTMLElement ? event.target : null)
                }
                className={cn(
                  'relative flex aspect-square w-full cursor-default items-center justify-center overflow-hidden rounded-md border border-border bg-bg-subtle',
                  'transition-colors duration-(--dur-fast) ease-standard hover:border-border-strong',
                  'outline-none focus-ring:outline-2 focus-ring:outline-offset-2 focus-ring:outline-border-focus',
                )}
                data-testid="attachment-thumb"
                data-attachment-id={image.id}
              >
                {image.image?.thumb ? (
                  <img
                    src={thumbSrc(image)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    className="size-full object-cover"
                  />
                ) : (
                  <span className="flex flex-col items-center gap-1 text-xs text-text-muted">
                    <FileImage className="size-6" strokeWidth={iconStrokeWidth} aria-hidden />
                    {t('noPreview')}
                  </span>
                )}
              </AriaButton>
              <div className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                  {image.filename}
                </span>
                {mayDelete(image) && (
                  <DeleteButton
                    name={image.filename}
                    buttonRef={registerDelete(image.id)}
                    onPress={() => askDelete(image)}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul aria-label={t('filesLabel')} className="flex flex-col" data-testid="attachment-files">
          {files.map((file) => {
            const Icon = kindIcons[fileKind(file.mime, file.filename)];
            return (
              <li
                key={file.id}
                className="flex min-h-row items-center gap-1 rounded-sm hover:bg-bg-subtle"
                data-testid="attachment-file"
              >
                <a
                  href={downloadHref(file)}
                  download={file.filename}
                  aria-label={t('download', { name: file.filename })}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-3 rounded-sm px-1 py-1.5 text-text',
                    'outline-none focus-visible:outline-2 focus-visible:outline-border-focus',
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-bg-muted text-text-secondary">
                    <Icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{file.filename}</span>
                    <span className="truncate text-xs text-text-muted">
                      {t('meta', {
                        size: formatBytes(file.size, prefs.locale),
                        name: nameOf(file.uploaderId) ?? t('someone'),
                        date: formatDay(file.createdAt, prefs, now),
                      })}
                    </span>
                  </span>
                </a>
                {mayDelete(file) && (
                  <DeleteButton
                    name={file.filename}
                    buttonRef={registerDelete(file.id)}
                    onPress={() => askDelete(file)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {confirming && (
        <InlineConfirm onEscape={cancelDelete}>
          <fieldset
            aria-label={t('delete', { name: confirming.filename })}
            className="flex flex-col gap-3 rounded-md bg-bg-danger-subtle px-3 py-3 tablet:flex-row tablet:items-center"
            data-testid="attachment-confirm"
          >
            <p className="min-w-0 flex-1 text-sm break-words text-text-danger">
              {t('confirmDelete', { name: confirming.filename })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                autoFocus
                isLoading={deleting}
                onPress={() => void confirmDelete()}
                data-testid="attachment-confirm-delete"
              >
                {t('confirm')}
              </Button>
              <Button size="sm" onPress={cancelDelete}>
                {t('cancel')}
              </Button>
            </div>
          </fieldset>
        </InlineConfirm>
      )}
    </section>
  );
}

function DeleteButton({
  name,
  onPress,
  buttonRef,
}: {
  name: string;
  onPress: () => void;
  buttonRef: (el: HTMLElement | null) => void;
}) {
  const { t } = useTranslation('attachments');
  return (
    <span ref={(el) => buttonRef(el?.querySelector('button') ?? null)} className="inline-flex">
      <IconButton icon={Trash2} size="sm" aria-label={t('delete', { name })} onPress={onPress} />
    </span>
  );
}

function InlineConfirm({ children, onEscape }: { children: ReactNode; onEscape: () => void }) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      // Esc closes the confirm, not the pane.
      event.stopPropagation();
      onEscape();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape bubbles up from the confirm's buttons
    <div onKeyDown={onKeyDown}>{children}</div>
  );
}

function UploadRow({
  upload,
  locale,
  maxAttachments,
  onRetry,
  onDismiss,
}: {
  upload: PendingUpload;
  locale: string;
  maxAttachments: number;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('attachments');
  const failed = upload.status === 'failed';
  const percent = Math.round(upload.progress * 100);
  const error = failed
    ? uploadErrorText(upload, locale, maxAttachments, t as unknown as Translate)
    : null;
  const retryable = failed && (upload.error === 'offline' || upload.error === 'failed');
  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-md border px-3 py-2',
        failed ? 'border-border-danger bg-bg-danger-subtle' : 'border-border bg-bg-elevated',
      )}
      data-testid="attachment-upload"
      data-status={upload.status}
    >
      <div className="flex min-w-0 items-center gap-2">
        {failed ? (
          <CircleAlert
            className="size-4 shrink-0 text-icon-danger"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        ) : (
          <span className="flex size-4 shrink-0 items-center justify-center text-text-muted">
            <Spinner />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          {failed ? (
            <span className="text-sm break-words text-text-danger" role="alert">
              {error}
            </span>
          ) : (
            <>
              <span className="truncate text-sm text-text">{upload.name}</span>
              <span className="text-xs text-text-muted tabular-nums">
                {upload.status === 'queued'
                  ? t('upload.queued')
                  : `${formatBytes(upload.size * upload.progress, locale)} / ${formatBytes(upload.size, locale)}`}
              </span>
            </>
          )}
        </span>
        {retryable && (
          <Button size="sm" variant="ghost" icon={RotateCw} onPress={onRetry}>
            {t('upload.retry')}
          </Button>
        )}
        <IconButton
          icon={X}
          size="sm"
          aria-label={failed ? t('upload.dismiss') : t('upload.cancel', { name: upload.name })}
          onPress={onDismiss}
        />
      </div>
      {!failed && (
        <div
          role="progressbar"
          aria-label={t('upload.progress', { name: upload.name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1 w-full overflow-hidden rounded-full bg-bg-muted"
        >
          <div
            className="h-full rounded-full bg-bg-accent transition-[width] duration-(--dur-fast) ease-standard"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </li>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function uploadErrorText(
  upload: Pick<PendingUpload, 'name' | 'error' | 'limitBytes' | 'usedBytes'>,
  locale: string,
  maxAttachments: number,
  t: Translate,
): string {
  const name = upload.name;
  switch (upload.error) {
    case 'tooLarge':
      return upload.limitBytes
        ? t('error.tooLarge', { name, limit: formatBytes(upload.limitBytes, locale) })
        : t('error.tooLargeNoLimit', { name });
    case 'storageFull':
      return upload.limitBytes
        ? t('error.storageFull', {
            name,
            limit: formatBytes(upload.limitBytes, locale),
            used: formatBytes(upload.usedBytes ?? upload.limitBytes, locale),
          })
        : t('error.storageFullNoLimit', { name });
    case 'mimeMismatch':
      return t('error.mimeMismatch', { name });
    case 'unsupported':
      return t('error.unsupported', { name });
    case 'tooMany':
      return t('error.tooMany', { max: maxAttachments });
    case 'offline':
      return t('error.offline', { name });
    case 'forbidden':
      return t('error.forbidden');
    case 'gone':
      return t('error.gone');
    default:
      return t('error.failed', { name });
  }
}
