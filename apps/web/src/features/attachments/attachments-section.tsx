import type { Attachment } from '@rooster/core/schemas';
import type { RefObject } from 'react';

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

/** P10 (FR-ATT, 02 §9.2 item 7): the pane's attachments. Placeholder until WP 10.2 lands. */
export function AttachmentsSection(_props: AttachmentsSectionProps) {
  return null;
}
