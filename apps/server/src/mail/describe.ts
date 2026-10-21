import {
  type DateFormat,
  dueInstant,
  formatRelative,
  type TimeFormat,
  todayIn,
} from '@rooster/core/dates';
import type { NotificationType } from '@rooster/core/schemas';
import type { ReminderDueSnapshot } from '../services/notification-service.ts';
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
  /** P10 reminder: the task's due unit when it fired, and whether it fired late. */
  reminder?: { due: ReminderDueSnapshot | null; late: boolean } | undefined;
  /** Phase 12 device_connected (11 §9.4): the client's name and the request IP. */
  device?: { clientName: string; ip: string | null } | undefined;
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
  /** P10 reminder: the due moment in words ("Due today 14:00"), plus a delay note. */
  when?: string;
  /** Same-origin path: the task in its org, the inbox, or Connected apps. */
  path: string;
  /** The button's label when it is not "Open task" or "Open inbox". */
  action?: string;
}

/** Where Connected apps lives in the web app (Settings → Security, 11 §3.2). */
export const CONNECTED_APPS_PATH = '/settings/security#connected-apps';

/**
 * The security notice of a device-grant approval (11 §9.4): who was connected from where, and
 * where to revoke it.
 */
function describeDeviceConnected(n: DeliverableNotification, t: MailT): DescribedNotification {
  const client = n.device?.clientName || t('someone');
  const ip = n.device?.ip ?? null;
  return {
    event:
      ip === null
        ? t('event.device_connected_unknown_ip', { client })
        : t('event.device_connected', { client, ip }),
    subject: t('device.subject'),
    path: CONNECTED_APPS_PATH,
    action: t('action.reviewApps'),
  };
}

/**
 * A due unit as the recipient reads it: a timed task's moment converted to their timezone
 * (a 14:00 Stockholm meeting is 08:00 in New York), an all-day one as its date.
 */
function dueLabel(due: ReminderDueSnapshot, recipient: Recipient, now: number): string {
  let dueDate = due.dueDate;
  let dueTime = due.dueTime;
  if (dueTime !== null && due.dueTz !== null && due.dueTz !== recipient.timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: recipient.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(dueInstant(dueDate, dueTime, due.dueTz)));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    dueDate = `${part('year')}-${part('month')}-${part('day')}`;
    dueTime = `${part('hour')}:${part('minute')}`;
  }
  return formatRelative(
    { dueDate, dueTime },
    {
      today: todayIn(recipient.timezone, now),
      locale: recipient.locale,
      dateFormat: recipient.dateFormat as DateFormat,
      timeFormat: recipient.timeFormat as TimeFormat,
    },
  );
}

function describeReminder(
  n: DeliverableNotification,
  recipient: Recipient,
  t: MailT,
  now: number,
): DescribedNotification {
  const due = n.reminder?.due ?? null;
  const when =
    due === null ? t('reminder.noDue') : t('reminder.due', { date: dueLabel(due, recipient, now) });
  return {
    event: t('event.reminder'),
    subject: n.taskTitle ?? n.orgName,
    path: n.taskId === null ? '/inbox' : `/o/${n.orgSlug}/t/${n.taskId}`,
    when: n.reminder?.late === true ? t('reminder.late', { when }) : when,
  };
}

export function describeNotification(
  n: DeliverableNotification,
  recipient: Recipient,
  t: MailT,
  now: number,
): DescribedNotification {
  if (n.type === 'reminder') return describeReminder(n, recipient, t, now);
  if (n.type === 'device_connected') return describeDeviceConnected(n, t);
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
