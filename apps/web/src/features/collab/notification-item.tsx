import { commentToPlainText, parseCommentMarkdown } from '@rooster/core/comment-markdown';
import type { Notification } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import { Bell, Mail, MailOpen, ShieldAlert } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { formatTimeAgo } from '../../lib/format';
import { Avatar } from '../../ui/avatar';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { cleanClientText, displayDomain } from '../access/client-display';
import type { ViewerDateContext } from '../dates';
import { DueText } from './due-text';

export interface NotificationItemProps {
  notification: Notification;
  /** The org's display name (the inbox spans every org). */
  orgName: string;
  now: number;
  locale: Locale;
  dateCtx: ViewerDateContext;
  onOpen: () => void;
  onToggleRead: () => void;
  'data-force'?: string;
}

/** What happened, after the actor's name: "mentioned you", "changed the due date to Fri". */
export function NotificationSentence({
  notification,
  orgName,
  dateCtx,
}: Pick<NotificationItemProps, 'notification' | 'orgName' | 'dateCtx'>) {
  const { t } = useTranslation('inbox');
  const { type, data } = notification;
  if (type === 'due_changed') {
    return data.to?.dueDate ? (
      <>
        {t('type.due_changed')} <DueText due={data.to} ctx={dateCtx} />
      </>
    ) : (
      t('type.due_removed')
    );
  }
  if (type === 'device_connected') {
    // 11 §9.4: "<client> was connected from <IP>". The name and host come from the client.
    const client = cleanClientText(data.clientName ?? '');
    const host = data.clientHost ? displayDomain(data.clientHost) : '';
    const ip = data.ip ? cleanClientText(data.ip, 64) : '';
    return (
      <>
        {client && <span className="font-semibold text-text">{client}</span>}
        {host && <span className="font-mono text-xs"> ({host})</span>}{' '}
        {ip ? t('deviceConnected.from', { ip }) : t('type.device_connected')}
      </>
    );
  }
  if (type === 'invite_accepted') {
    return <>{t('type.invite_accepted', { org: orgName })}</>;
  }
  if (type === 'reminder') {
    // FR-REM-3: "Reminder · due Fri 14:00 · Sent late". The task title follows on its own line.
    return (
      <>
        <span className="font-semibold text-text">{t('type.reminder')}</span>
        {data.to?.dueDate && (
          <>
            {' · '}
            {t('reminder.due')} <DueText due={data.to} ctx={dateCtx} />
          </>
        )}
        {data.late && (
          <span className="font-medium text-text" data-testid="reminder-late">
            {' · '}
            {t('reminder.late')}
          </span>
        )}
      </>
    );
  }
  return <>{t(`type.${type}`)}</>;
}

/**
 * A comment excerpt as one line of plain text: the server keeps the comment's Markdown-light
 * (`**bold**`, links, lists), which the inbox shows without its markup.
 */
export function excerptText(excerpt: string): string {
  return commentToPlainText(parseCommentMarkdown(excerpt)).replace(/\s+/g, ' ').trim();
}

/**
 * One inbox entry (FR-NOT-1): unread dot, the actor's avatar, the sentence, the task title, a
 * comment excerpt, then org and time. The row opens the task (and marks it read); the trailing
 * button toggles read (U). A `device_connected` notice (11 §9.4) has no actor or task: a shield,
 * "<client> was connected from <IP>", and the way to revoke it; it opens Connected apps.
 */
export function NotificationItem({
  notification,
  orgName,
  now,
  locale,
  dateCtx,
  onOpen,
  onToggleRead,
  'data-force': force,
}: NotificationItemProps) {
  const { t } = useTranslation('inbox');
  const unread = notification.readAt === null;
  const actor = notification.actor;
  const actorName = actor?.name ?? t('system');
  const reminder = notification.type === 'reminder';
  // A security notice about the account (11 §9.4): no actor, no task, no org of its own.
  const device = notification.type === 'device_connected';
  const ago = formatTimeAgo(notification.createdAt, now, locale, t('justNow'));
  return (
    <div
      className={cn(
        'group/notification relative flex items-start gap-1 rounded-md',
        'hover:bg-bg-subtle',
        force?.includes('hover') && 'bg-bg-subtle',
      )}
      data-testid="notification"
      data-notification-id={notification.id}
      data-unread={unread || undefined}
    >
      <AriaButton
        onPress={onOpen}
        data-inbox-item
        {...(force ? { 'data-force': force } : {})}
        className={cn(
          'flex min-w-0 flex-1 cursor-default items-start gap-3 rounded-md py-3 ps-3 pe-1 text-start',
          'outline-none focus-ring:outline-2 focus-ring:-outline-offset-2 focus-ring:outline-border-focus',
        )}
      >
        <span className="flex h-control w-2 shrink-0 items-center" aria-hidden>
          {unread && <span className="size-2 rounded-full bg-bg-accent" />}
        </span>
        {reminder ? (
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-accent-subtle text-text-secondary"
          >
            <Bell className="size-4" strokeWidth={iconStrokeWidth} />
          </span>
        ) : device ? (
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-warning-subtle text-text-warning"
          >
            <ShieldAlert className="size-4" strokeWidth={iconStrokeWidth} />
          </span>
        ) : (
          <Avatar
            id={actor?.id ?? notification.id}
            name={actorName}
            src={actor?.image ?? undefined}
            size={32}
            decorative
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {unread && <span className="sr-only">{t('unread')}</span>}
          <span className={cn('text-sm text-text-secondary', unread && 'text-text')}>
            {/* A reminder is the user's own (FR-REM-3): no actor in front of it. */}
            {!reminder && !device && (
              <>
                <span className="font-semibold text-text">{actorName}</span>{' '}
              </>
            )}
            <NotificationSentence notification={notification} orgName={orgName} dateCtx={dateCtx} />
          </span>
          {notification.task && (
            <span className={cn('truncate text-sm text-text', unread && 'font-medium')}>
              {notification.task.title}
            </span>
          )}
          {device && (
            <span className="text-sm text-text-secondary" data-testid="device-connected-hint">
              {t('deviceConnected.hint')}
            </span>
          )}
          {notification.data.excerpt && (
            <span className="line-clamp-2 text-sm text-text-secondary">
              {t('excerpt', { text: excerptText(notification.data.excerpt) })}
            </span>
          )}
          <span className="text-xs text-text-muted">
            {device ? t('deviceConnected.account') : orgName} · {ago}
          </span>
        </span>
      </AriaButton>
      <IconButton
        icon={unread ? MailOpen : Mail}
        size="sm"
        aria-label={unread ? t('markRead') : t('markUnread')}
        shortcut={primaryKeys('toggleRead')}
        onPress={onToggleRead}
        className={cn(
          'mt-3 me-2 opacity-0 pointer-coarse:opacity-100',
          'group-hover/notification:opacity-100 group-focus-within/notification:opacity-100',
          force && 'opacity-100',
        )}
        data-testid="notification-toggle-read"
      />
    </div>
  );
}
