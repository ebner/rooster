import type { Attachment } from '@rooster/core/schemas';
import { type RefObject, Suspense, useEffect } from 'react';
import { lazyWithPreload, preloadWhenIdle } from '../../lib/lazy';

export interface AttachmentsSectionProps {
  orgId: string;
  taskId: string;
  userId: string;
  /** The task's assignee: they and the uploader may delete an attachment (06 §2.7). */
  assigneeId: string | null;
  /** From the task detail; undefined while it loads (or for caches from older versions). */
  attachments: readonly Attachment[] | undefined;
  /** The pane's scroll body: the whole pane is the drop zone (02 §9.2). */
  paneRef: RefObject<HTMLDivElement | null>;
}

// 10 §4: the grid, uploads and the lightbox load with the first opened pane, not the app.
const LazyAttachmentsPanel = lazyWithPreload(() =>
  import('./attachments-panel').then((m) => m.AttachmentsPanel),
);

let prefetched = false;

/** P10 (FR-ATT, 02 §9.2 item 7): the pane's attachments. */
export function AttachmentsSection(props: AttachmentsSectionProps) {
  useEffect(() => {
    if (prefetched) return;
    prefetched = true;
    preloadWhenIdle([LazyAttachmentsPanel.preload]);
  }, []);
  return (
    <Suspense fallback={null}>
      <LazyAttachmentsPanel {...props} />
    </Suspense>
  );
}
