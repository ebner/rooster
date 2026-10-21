import type { Notification } from '@rooster/core/schemas';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDisplayPrefs, useMe } from '../../data';
import { useMarkNotifications, useNotifications } from '../../data/notifications';
import { type InboxFilter, InboxPage } from '../../features/collab/inbox-page';
import { useViewerDateContext } from '../../features/dates';
import { orgUrlSlug, paths } from '../../features/shell/paths';
import { toast } from '../../ui/toast';

/** The notification inbox (FR-NOT-1): every org's notifications in one list. */
export const Route = createFileRoute('/_app/inbox')({
  component: InboxRoute,
});

function InboxRoute() {
  const { t } = useTranslation('inbox');
  const navigate = useNavigate();
  const me = useMe();
  const display = useDisplayPrefs();
  const dateCtx = useViewerDateContext();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const inbox = useNotifications(filter);
  // The badge count lives with the `all` list; the unread list carries the same number.
  const all = useNotifications('all');
  const mark = useMarkNotifications();
  const orgs = me.data?.orgs ?? [];

  const markFailed = () => toast({ message: t('markFailed'), tone: 'danger' });
  const setRead = (notification: Notification, read: boolean) =>
    mark.mutateAsync({ read, ids: [notification.id] }).catch(markFailed);

  const open = (notification: Notification) => {
    if (notification.readAt === null) void setRead(notification, true);
    const org = orgs.find((o) => o.id === notification.orgId);
    const slug = org ? orgUrlSlug(org) : notification.orgSlug;
    const href =
      notification.type === 'device_connected'
        ? paths.connectedApps(notification.data.grantId)
        : notification.type === 'invite_accepted' || !notification.task
          ? `${paths.orgSettings(slug)}#members`
          : paths.task(slug, notification.task.id);
    void navigate({ href });
  };

  return (
    <InboxPage
      items={inbox.items}
      unreadCount={all.unreadCount ?? inbox.unreadCount ?? 0}
      filter={filter}
      onFilterChange={setFilter}
      error={inbox.error}
      hasMore={inbox.hasMore}
      isLoadingMore={inbox.isLoadingMore}
      onLoadMore={inbox.loadMore}
      orgName={(n) => orgs.find((o) => o.id === n.orgId)?.name ?? n.orgSlug}
      now={dateCtx.nowMs}
      locale={display.locale}
      dateCtx={dateCtx}
      onOpen={open}
      onToggleRead={(n) => void setRead(n, n.readAt === null)}
      onMarkAllRead={() => void mark.mutateAsync({ read: true, all: true }).catch(markFailed)}
    />
  );
}
