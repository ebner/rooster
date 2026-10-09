import { groupActivity } from '@rooster/core/activity';
import type { NotificationPref } from '@rooster/core/schemas';
import { isLocale } from '@rooster/i18n/core';
import { Bell } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomNav } from '../../ui/bottom-nav';
import { sampleDateContext } from '../dates/fixtures';
import { Group, Section, Specimen } from '../dev-ui/layout';
import { NotificationsPage, notificationTypes } from '../settings/notifications-page';
import { fixtureIds } from '../shell/fixtures';
import { SidebarItem } from '../shell/sidebar-item';
import { ActivityFeed } from './activity-feed';
import { CommentComposer } from './comment-composer';
import {
  fixtureCandidates,
  fixtureFeed,
  fixtureNotifications,
  fixtureOwnCommentId,
  fixturePendingId,
  fixturePeople,
} from './fixtures';
import { FollowerStack, FollowToggle } from './followers';
import { NotificationItem } from './notification-item';

/** Kitchen-sink entries for comments, activity, followers and the inbox (P6, WP 6.3–6.5). */
export function CollabKitchenSection() {
  const { t, i18n } = useTranslation('collab');
  const { t: tShell } = useTranslation('shell');
  const { t: tMobile } = useTranslation('mobile');
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const dateCtx = useMemo(() => sampleDateContext(locale), [locale]);
  const now = dateCtx.nowMs;
  const entries = useMemo(() => groupActivity(fixtureFeed(now)), [now]);
  const notifications = useMemo(() => fixtureNotifications(now), [now]);
  const person = (id: string) => fixturePeople[id];
  const [following, setFollowing] = useState(true);
  const [prefs, setPrefs] = useState<NotificationPref[]>(() =>
    notificationTypes.map((type) => ({ type, channel: 'inapp', enabled: type !== 'completed' })),
  );
  const followers = [
    fixtureIds.anna,
    fixtureIds.jannik,
    fixtureIds.markus,
    fixtureIds.sara,
    fixtureIds.olof,
  ].map((id) => ({ id, name: fixturePeople[id]?.name ?? '', image: null }));
  const noop = () => undefined;

  return (
    <Section id="collab" title={t('dev.section')}>
      <Group title={t('dev.feed')} className="block">
        <div className="flex max-w-pane flex-col gap-8">
          <ActivityFeed
            entries={entries}
            viewerId={fixtureIds.jannik}
            person={person}
            pending={new Set([fixturePendingId])}
            now={now}
            locale={locale}
            dateCtx={dateCtx}
            onEdit={noop}
            onDelete={noop}
            data-force="hover"
          />
          <ActivityFeed
            entries={entries.filter(
              (e) => e.kind === 'comment' && e.comment.id === fixtureOwnCommentId,
            )}
            viewerId={fixtureIds.jannik}
            person={person}
            pending={new Set()}
            now={now}
            locale={locale}
            dateCtx={dateCtx}
            onEdit={noop}
            onDelete={noop}
            editingId={fixtureOwnCommentId}
          />
        </div>
      </Group>
      <Group title={t('dev.composer')} className="block">
        <div className="mt-16 flex max-w-pane flex-col gap-8 pt-16">
          <CommentComposer
            taskId="kitchen-sink"
            candidates={fixtureCandidates}
            onPost={noop}
            initialText="Thanks @a"
            footer={
              <>
                <FollowerStack followers={followers} />
                <FollowToggle following={following} onToggle={setFollowing} />
              </>
            }
          />
          <CommentComposer
            taskId="kitchen-sink-empty"
            candidates={[]}
            onPost={noop}
            initialText=""
          />
        </div>
      </Group>
      <Group title={t('dev.followers')}>
        <Specimen label="5">
          <FollowerStack followers={followers} />
        </Specimen>
        <Specimen label="2">
          <FollowerStack followers={followers.slice(0, 2)} />
        </Specimen>
        <Specimen label={t('followers.follow')}>
          <FollowToggle following={false} onToggle={noop} />
        </Specimen>
        <Specimen label={t('followers.following')}>
          <FollowToggle following onToggle={noop} />
        </Specimen>
        <Specimen label="hover">
          <FollowToggle following={false} onToggle={noop} data-force="hover" />
        </Specimen>
        <Specimen label="focus">
          <FollowToggle following onToggle={noop} data-force="focus" />
        </Specimen>
      </Group>
      <Group title={t('dev.inbox')} className="block">
        <ul className="flex max-w-list-max flex-col">
          {notifications.map((notification, index) => (
            <li key={notification.id}>
              <NotificationItem
                notification={notification}
                orgName="Brightwater"
                now={now}
                locale={locale}
                dateCtx={dateCtx}
                onOpen={noop}
                onToggleRead={noop}
                {...(index === 1 ? { 'data-force': 'hover' } : {})}
                {...(index === 3 ? { 'data-force': 'focus' } : {})}
              />
            </li>
          ))}
        </ul>
      </Group>
      <Group title={t('dev.sidebar')}>
        <div className="flex w-sidebar flex-col rounded-md bg-bg-sidebar p-3">
          <SidebarItem
            icon={Bell}
            label={tShell('sidebar.inbox')}
            count={3}
            countLabel={tShell('sidebar.unread', { count: 3 })}
            href="#collab"
          />
          <SidebarItem
            icon={Bell}
            label={tShell('sidebar.inbox')}
            count={12}
            countLabel={tShell('sidebar.unread', { count: 12 })}
            href="#collab"
            isActive
          />
          <SidebarItem
            icon={Bell}
            label={tShell('sidebar.inbox')}
            href="#collab"
            data-force="hover"
          />
        </div>
        <Specimen label="rail">
          <div className="flex w-rail justify-center rounded-md bg-bg-sidebar p-2">
            <SidebarItem
              icon={Bell}
              label={tShell('sidebar.inbox')}
              count={3}
              countLabel={tShell('sidebar.unread', { count: 3 })}
              href="#collab"
              rail
            />
          </div>
        </Specimen>
        <div className="w-pane-min">
          <BottomNav
            label={tMobile('nav.label')}
            items={[
              { id: 'my', label: tMobile('nav.myTasks'), icon: Bell, href: '#collab' },
              {
                id: 'inbox',
                label: tMobile('nav.inbox'),
                icon: Bell,
                href: '#collab',
                isActive: true,
                badge: 4,
                badgeLabel: tMobile('nav.unread', { count: 4 }),
              },
            ]}
          />
        </div>
      </Group>
      <Group title={t('dev.prefs')} className="block">
        <NotificationsPage
          prefs={prefs}
          onChange={(type, enabled) =>
            setPrefs((all) => all.map((p) => (p.type === type ? { ...p, enabled } : p)))
          }
          data-force="focus"
        />
      </Group>
    </Section>
  );
}
