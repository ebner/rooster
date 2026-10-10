import { ATTACHMENTS_PER_TASK_MAX } from '@rooster/core/limits';
import type { Attachment } from '@rooster/core/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  afterAttachmentChange,
  attachmentUrl,
  thumbnailUrl,
  uploadAttachment,
  useDeleteAttachment,
  useUploadLimit,
} from '../../data/attachments';
import { useDisplayPrefs, useMe } from '../../data/me';
import { useOrgMembers } from '../../data/orgs';
import { toast } from '../../ui/toast';
import { eventZone, useKeymapHandlers } from '../../use-keymap';
import type { AttachmentsSectionProps } from './attachments-section';
import { AttachmentsView } from './attachments-view';
import { DropOverlay, type DropRect } from './drop-overlay';
import { Lightbox } from './lightbox';
import { clipboardImageFiles, dragHasFiles, pastedFileName, splitAttachments } from './model';
import {
  dismissUpload,
  pendingFor,
  retryUpload,
  startUploads,
  type Uploader,
  useUploadStore,
} from './upload-store';
import { useOnline } from './use-online';

const download = (a: Attachment) => attachmentUrl(a.id);
const inline = (a: Attachment) => attachmentUrl(a.id, { inline: true });
const thumb = (a: Attachment) => thumbnailUrl(a.id);

/**
 * The pane's attachments, wired up (lazy chunk; `AttachmentsSection` loads it): uploads through
 * XHR with progress, files dropped anywhere on the pane, images pasted anywhere in it (also into
 * the description editor, which never inlines them, ADR 0049 §3.8), Tab+U for the file picker,
 * delete, and the lightbox.
 */
export function AttachmentsPanel({
  orgId,
  taskId,
  userId,
  assigneeId,
  attachments,
  paneRef,
}: AttachmentsSectionProps) {
  const { t } = useTranslation('attachments');
  const queryClient = useQueryClient();
  const prefs = useDisplayPrefs();
  const me = useMe().data?.user;
  const members = useOrgMembers(orgId).data;
  const remove = useDeleteAttachment();
  const online = useOnline();
  const maxBytes = useUploadLimit();
  const entries = useUploadStore((s) => s.entries);
  const uploads = useMemo(() => pendingFor(entries, taskId), [entries, taskId]);
  const input = useRef<HTMLInputElement>(null);
  const [drop, setDrop] = useState<DropRect | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const images = useMemo(() => splitAttachments(attachments ?? []).images, [attachments]);

  const nameOf = useCallback(
    (id: string) =>
      members?.find((m) => m.userId === id)?.name ?? (id === me?.id ? me.name : undefined),
    [members, me],
  );

  const upload: Uploader = useCallback(
    (file, onProgress) => uploadAttachment(taskId, file, onProgress),
    [taskId],
  );
  const onUploaded = useCallback(
    (attachment: Attachment) =>
      void afterAttachmentChange(queryClient, orgId, taskId, { added: attachment }),
    [queryClient, orgId, taskId],
  );
  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (!navigator.onLine) {
        toast({ message: t('offline'), tone: 'danger' });
        return;
      }
      startUploads(taskId, files, upload, onUploaded, maxBytes);
    },
    [taskId, upload, onUploaded, t, maxBytes],
  );
  const pick = useCallback(() => {
    if (navigator.onLine) input.current?.click();
  }, []);

  useKeymapHandlers({
    attachFile: (event) => {
      const zone = eventZone(event);
      if (zone !== 'pane' && zone !== 'paneList') return false;
      if (!navigator.onLine) toast({ message: t('offline'), tone: 'danger' });
      else pick();
    },
  });

  // Drop and paste on the whole pane, in the capture phase: the description editor (and the
  // comment composer) never see a file, so nothing is inlined and the browser never opens it.
  useEffect(() => {
    const body = paneRef.current;
    const root = body?.closest<HTMLElement>('[data-pane-root]') ?? body;
    if (!root) return;
    let depth = 0;
    const show = () => {
      const r = root.getBoundingClientRect();
      setDrop({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const hide = () => {
      depth = 0;
      setDrop(null);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      if (depth === 1) show();
    };
    const onDragOver = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = navigator.onLine ? 'copy' : 'none';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDrop(null);
    };
    const onDrop = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      hide();
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = clipboardImageFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const now = new Date();
      addFiles(
        files.map(
          (file) =>
            new File(
              [file],
              pastedFileName(file, now, (stamp) => t('pastedName', { stamp })),
              { type: file.type },
            ),
        ),
      );
    };
    root.addEventListener('dragenter', onDragEnter, true);
    root.addEventListener('dragover', onDragOver, true);
    root.addEventListener('dragleave', onDragLeave, true);
    root.addEventListener('drop', onDrop, true);
    root.addEventListener('paste', onPaste, true);
    // A drag that ends outside the window never sends dragleave to the pane.
    window.addEventListener('dragend', hide);
    window.addEventListener('blur', hide);
    return () => {
      root.removeEventListener('dragenter', onDragEnter, true);
      root.removeEventListener('dragover', onDragOver, true);
      root.removeEventListener('dragleave', onDragLeave, true);
      root.removeEventListener('drop', onDrop, true);
      root.removeEventListener('paste', onPaste, true);
      window.removeEventListener('dragend', hide);
      window.removeEventListener('blur', hide);
    };
  }, [paneRef, addFiles, t]);

  // An image deleted (here or elsewhere) while the lightbox shows the last one.
  useEffect(() => {
    if (lightbox !== null && lightbox >= images.length) {
      setLightbox(images.length > 0 ? images.length - 1 : null);
    }
  }, [lightbox, images.length]);

  const closeLightbox = () => {
    const id = lightbox === null ? undefined : images[lightbox]?.id;
    setLightbox(null);
    // After the overlay restores focus: back to the thumbnail of the image last shown.
    requestAnimationFrame(() =>
      paneRef.current
        ?.querySelector<HTMLElement>(`[data-attachment-id="${id ?? ''}"]`)
        ?.focus({ preventScroll: false }),
    );
  };

  return (
    <>
      <AttachmentsView
        attachments={attachments}
        uploads={uploads}
        userId={userId}
        assigneeId={assigneeId}
        nameOf={nameOf}
        prefs={prefs}
        now={Date.now()}
        online={online}
        maxAttachments={ATTACHMENTS_PER_TASK_MAX}
        thumbSrc={thumb}
        downloadHref={download}
        onPick={pick}
        onOpenImage={(image) => {
          const index = images.findIndex((i) => i.id === image.id);
          if (index >= 0) setLightbox(index);
        }}
        onDelete={async (attachment) => {
          try {
            await remove.mutateAsync({ orgId, taskId, id: attachment.id });
            toast({ message: t('deleted'), durationMs: 2500 });
          } catch (error) {
            toast({ message: t('deleteFailed'), tone: 'danger' });
            throw error;
          }
        }}
        onRetry={(id) => retryUpload(id, upload, onUploaded)}
        onDismiss={dismissUpload}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        data-testid="attachment-input"
        onChange={(event) => {
          addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = '';
        }}
      />
      {drop && <DropOverlay rect={drop} />}
      {lightbox !== null && images[lightbox] && (
        <Lightbox
          images={images}
          index={lightbox}
          onIndexChange={setLightbox}
          onClose={closeLightbox}
          src={inline}
          downloadHref={download}
        />
      )}
    </>
  );
}
