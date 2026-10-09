import type { Notification } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import { CheckCheck } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { LogoMark } from '../../ui/logo';
import { SegmentedControl } from '../../ui/segmented-control';
import { SkeletonRows } from '../../ui/skeleton';
import { useKeymapHandlers } from '../../use-keymap';
import type { ViewerDateContext } from '../dates';
import { ViewBody, ViewHeader } from '../shell/app-shell';
import { NotificationItem } from './notification-item';

export type InboxFilter = 'all' | 'unread';

export interface InboxPageProps {
  /** Newest first; undefined while the first page loads. */
  items: readonly Notification[] | undefined;
  unreadCount: number;
  filter: InboxFilter;
  onFilterChange: (filter: InboxFilter) => void;
  error?: Error | null | undefined;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  /** The org's name for a notification (the inbox spans every org). */
  orgName: (notification: Notification) => string;
  now: number;
  locale: Locale;
  dateCtx: ViewerDateContext;
  onOpen: (notification: Notification) => void;
  onToggleRead: (notification: Notification) => void;
  onMarkAllRead: () => void;
}

function inboxItems(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>('[data-inbox-item]')] : [];
}

/**
 * `/inbox` (FR-NOT-1, 02 §2): every org's notifications, newest first, with an unread filter.
 * ↑/↓ (K/J), Home and End move between entries, Enter opens one, U toggles it read and Shift+U
 * marks everything read; the keys come from the registry (02 §6).
 */
export function InboxPage({
  items,
  unreadCount,
  filter,
  onFilterChange,
  error,
  hasMore,
  isLoadingMore,
  onLoadMore,
  orgName,
  now,
  locale,
  dateCtx,
  onOpen,
  onToggleRead,
  onMarkAllRead,
}: InboxPageProps) {
  const { t } = useTranslation('inbox');
  const list = useRef<HTMLUListElement>(null);

  const focusItem = (pick: (all: HTMLElement[], index: number) => HTMLElement | undefined) => {
    const all = inboxItems(list.current);
    if (all.length === 0) return false;
    const current = document.activeElement?.closest<HTMLElement>('[data-inbox-item]') ?? null;
    const index = current ? all.indexOf(current) : -1;
    const next = pick(all, index);
    next?.focus();
  };
  const focused = (): Notification | undefined => {
    const id = document.activeElement
      ?.closest<HTMLElement>('[data-notification-id]')
      ?.getAttribute('data-notification-id');
    return items?.find((n) => n.id === id);
  };

  useKeymapHandlers({
    selectNext: () => focusItem((all, i) => all[Math.min(all.length - 1, i + 1)]),
    selectPrevious: () => focusItem((all, i) => all[i < 0 ? 0 : Math.max(0, i - 1)]),
    selectFirst: () => focusItem((all) => all[0]),
    selectLast: () => focusItem((all) => all.at(-1)),
    toggleRead: () => {
      const notification = focused();
      if (!notification) return false;
      onToggleRead(notification);
    },
    markAllRead: () => {
      if (unreadCount === 0) return false;
      onMarkAllRead();
    },
  });

  const filterControl = (
    <SegmentedControl
      label={t('filter.label')}
      hideLabel
      options={[
        { id: 'all', label: t('filter.all') },
        { id: 'unread', label: t('filter.unread', { count: unreadCount }) },
      ]}
      value={filter}
      onChange={onFilterChange}
    />
  );

  return (
    <>
      <ViewHeader
        title={t('title')}
        actions={
          <>
            {filterControl}
            <Button
              size="sm"
              variant="ghost"
              icon={CheckCheck}
              isDisabled={unreadCount === 0}
              onPress={onMarkAllRead}
              data-testid="mark-all-read"
            >
              {t('markAllRead')}
            </Button>
          </>
        }
        mobile={{
          actions: (
            <IconButton
              icon={CheckCheck}
              aria-label={t('markAllRead')}
              isDisabled={unreadCount === 0}
              onPress={onMarkAllRead}
            />
          ),
        }}
      />
      <ViewBody className="gap-2">
        <div className="tablet:hidden">{filterControl}</div>
        {error && !items && (
          <Banner tone="danger" role="alert">
            {t('loadFailed')}
          </Banner>
        )}
        {!items && !error && <SkeletonRows count={4} />}
        {items && items.length === 0 && (
          <div
            className="flex flex-col items-center gap-3 py-12 text-center"
            data-testid="inbox-empty"
          >
            <LogoMark size={96} tone="muted" />
            <p className="text-base text-text-secondary">
              {filter === 'unread' ? t('empty.unread') : t('empty.all')}
            </p>
          </div>
        )}
        {items && items.length > 0 && (
          <ul ref={list} aria-label={t('title')} className="flex flex-col" data-testid="inbox">
            {items.map((notification) => (
              <li key={notification.id}>
                <NotificationItem
                  notification={notification}
                  orgName={orgName(notification)}
                  now={now}
                  locale={locale}
                  dateCtx={dateCtx}
                  onOpen={() => onOpen(notification)}
                  onToggleRead={() => onToggleRead(notification)}
                />
              </li>
            ))}
          </ul>
        )}
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            isLoading={isLoadingMore}
            onPress={onLoadMore}
          >
            {t('loadMore')}
          </Button>
        )}
      </ViewBody>
    </>
  );
}
