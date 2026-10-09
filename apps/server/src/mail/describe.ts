import { type DateFormat, formatRelative, type TimeFormat, todayIn } from '@rooster/core/dates';
import type { NotificationType } from '@rooster/core/schemas';
import type { Recipient } from '../services/pref-store.ts';
import type { MailT } from './i18n.ts';

/** What delivery needs from a stored notification (its row plus the org it belongs to). */
export interface DeliverableNotification {
  id: string;
  type: NotificationType;
  orgName: string;
  orgSlug: string;
  taskId: string | null;
  taskTitle: string | null;
  actorName: string | null;
  excerpt?: string | undefined;
  /** due_changed: the new due date (null when it was removed). */
  dueTo?: { dueDate: string | null; dueTime: string | null } | null | undefined;
  createdAt: number;
}

/** A notification in words, in the recipient's locale: for emails and push messages alike. */
export interface DescribedNotification {
  /** "Ann assigned a task to you". */
  event: string;
  /** The task title, or the org for an accepted invite. */
  subject: string;
  /** A quoted comment excerpt (comment, mention). */
  quote?: string;
  /** Same-origin path: the task in its org, or the inbox. */
  path: string;
}

export function describeNotification(
  n: DeliverableNotification,
  recipient: Recipient,
  t: MailT,
  now: number,
): DescribedNotification {
  const actor = n.actorName === null || n.actorName === '' ? t('someone') : n.actorName;
  let event: string;
  if (n.type === 'due_changed') {
    const to = n.dueTo ?? null;
    if (to === null || to.dueDate === null) {
      event = t('event.due_removed', { actor });
    } else {
      const date = formatRelative(
        { dueDate: to.dueDate, dueTime: to.dueTime },
        {
          today: todayIn(recipient.timezone, now),
          locale: recipient.locale,
          dateFormat: recipient.dateFormat as DateFormat,
          timeFormat: recipient.timeFormat as TimeFormat,
        },
      );
      event = t('event.due_changed', { actor, date });
    }
  } else {
    event = t(`event.${n.type}`, { actor, org: n.orgName });
  }
  const described: DescribedNotification = {
    event,
    subject: n.taskTitle ?? n.orgName,
    path: n.taskId === null ? '/inbox' : `/o/${n.orgSlug}/t/${n.taskId}`,
  };
  if (n.excerpt !== undefined && n.excerpt !== '') {
    described.quote = t('quote', { text: n.excerpt });
  }
  return described;
}
