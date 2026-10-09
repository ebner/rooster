import type { Notification } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import { Mail, MailOpen } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { formatTimeAgo } from '../../lib/format';
import { Avatar } from '../../ui/avatar';
import { IconButton } from '../../ui/icon-button';
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
  if (type === 'invite_accepted') {
    return <>{t('type.invite_accepted', { org: orgName })}</>;
  }
  return <>{t(`type.${type}`)}</>;
}

/**
 * One inbox entry (FR-NOT-1): unread dot, the actor's avatar, the sentence, the task title, a
 * comment excerpt, then org and time. The row opens the task (and marks it read); the trailing
 * button toggles read (U).
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
        <Avatar
          id={actor?.id ?? notification.id}
          name={actorName}
          src={actor?.image ?? undefined}
          size={32}
          decorative
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {unread && <span className="sr-only">{t('unread')}</span>}
          <span className={cn('text-sm text-text-secondary', unread && 'text-text')}>
            <span className="font-semibold text-text">{actorName}</span>{' '}
            <NotificationSentence notification={notification} orgName={orgName} dateCtx={dateCtx} />
          </span>
          {notification.task && (
            <span className={cn('truncate text-sm text-text', unread && 'font-medium')}>
              {notification.task.title}
            </span>
          )}
          {notification.data.excerpt && (
            <span className="line-clamp-2 text-sm text-text-secondary">
              {t('excerpt', { text: notification.data.excerpt })}
            </span>
          )}
          <span className="text-xs text-text-muted">
            {orgName} · {ago}
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
