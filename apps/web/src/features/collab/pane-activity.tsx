import { filterComments, groupActivity } from '@rooster/core/activity';
import type { ActivityFilter, Comment } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useActivity, usePendingComments } from '../../data/collab';
import { Button } from '../../ui/button';
import { SkeletonRows } from '../../ui/skeleton';
import type { ViewerDateContext } from '../dates';
import { ActivityFeed, type FeedPerson } from './activity-feed';

export interface PaneActivityProps {
  orgId: string;
  taskId: string;
  viewerId: string;
  filter: ActivityFilter;
  person: (userId: string) => FeedPerson | undefined;
  locale: Locale;
  dateCtx: ViewerDateContext;
  onEdit: (comment: Comment, body: string) => void;
  onDelete: (comment: Comment) => void;
}

/**
 * The pane's Activity feed with its data (`['activity', taskId]`): "Load earlier" pages back in
 * time, "Comments only" filters the loaded feed locally. Loaded lazily with the pane (10 §4).
 */
export function PaneActivity({
  orgId,
  taskId,
  viewerId,
  filter,
  person,
  locale,
  dateCtx,
  onEdit,
  onDelete,
}: PaneActivityProps) {
  const { t } = useTranslation('collab');
  const feed = useActivity(taskId);
  const pending = usePendingComments(orgId, taskId);
  const entries = useMemo(() => {
    if (!feed.items) return [];
    return groupActivity(filter === 'comments' ? filterComments(feed.items) : feed.items);
  }, [feed.items, filter]);

  if (!feed.items) {
    return feed.error ? (
      <p role="alert" className="text-sm text-text-secondary">
        {t('feed.loadFailed')}
      </p>
    ) : (
      <SkeletonRows count={2} />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {feed.hasEarlier && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          isLoading={feed.isLoadingEarlier}
          onPress={feed.loadEarlier}
          data-testid="activity-earlier"
        >
          {t('feed.earlier')}
        </Button>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="activity-empty">
          {t('feed.noComments')}
        </p>
      ) : (
        <ActivityFeed
          entries={entries}
          viewerId={viewerId}
          person={person}
          pending={pending}
          now={dateCtx.nowMs}
          locale={locale}
          dateCtx={dateCtx}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}
