import type { IcalFeed, IcalFeedCreate, IcalFeedCreated } from '@rooster/core/schemas';
import { isLocale } from '@rooster/i18n/core';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayPrefs } from '../../lib/format';
import { Group, Section } from '../dev-ui/layout';
import { AvatarField } from './avatar-field';
import { CalendarFeedsSection, type FeedOrg } from './calendar-feeds';

const orgs: FeedOrg[] = [
  { id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d7a01', name: 'Personal' },
  { id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d7a02', name: 'Brightwater' },
];

function fixtureFeeds(now: number): IcalFeed[] {
  return [
    {
      id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d7b01',
      orgId: null,
      createdAt: now - 40 * 86_400_000,
      lastUsedAt: now - 12 * 60_000,
    },
    {
      id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d7b02',
      orgId: orgs[1]?.id ?? null,
      createdAt: now - 2 * 86_400_000,
      lastUsedAt: null,
    },
  ];
}

const created = (feed: IcalFeed): IcalFeedCreated => ({
  feed,
  url: 'https://rooster.example.com/ical/rcal_Q2hhbmdlIG1lIGJlZm9yZSB5b3UgcHVibGlzaCB0aGlz.ics',
});

/** `/_dev/ui` (P10, WP 10.2/10.3): Settings → Calendar feed and the profile picture. */
export function CalendarKitchenSection() {
  const { t, i18n } = useTranslation('calendar');
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const prefs: DisplayPrefs = {
    locale,
    timezone: 'Europe/Stockholm',
    dateFormat: locale === 'sv' ? 'd MMM' : 'MMM d',
    timeFormat: '24h',
  };
  const now = useMemo(() => Date.now(), []);
  const [feeds, setFeeds] = useState<IcalFeed[]>(() => fixtureFeeds(now));
  const full = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `0192f5d0-7a1e-7c3a-9f10-1a2b3c4d7c${String(i).padStart(2, '0')}`,
        orgId: i % 2 ? (orgs[0]?.id ?? null) : null,
        createdAt: now - i * 86_400_000,
        lastUsedAt: null,
      })),
    [now],
  );
  const base = {
    orgs,
    prefs,
    now,
    online: true,
    onCreate: async (input: IcalFeedCreate) => {
      const feed: IcalFeed = {
        id: `0192f5d0-7a1e-7c3a-9f10-${String(Date.now()).slice(-12)}`,
        orgId: input.orgId ?? null,
        createdAt: Date.now(),
        lastUsedAt: null,
      };
      setFeeds((all) => [...all.filter((f) => f.id !== input.replaces), feed]);
      return created(feed);
    },
    onRevoke: async (id: string) => setFeeds((all) => all.filter((f) => f.id !== id)),
  };
  const sample = fixtureFeeds(now);
  return (
    <Section id="calendarFeed" title={t('dev.section')}>
      <Group title={t('dev.list')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection {...base} feeds={feeds} />
        </div>
      </Group>
      <Group title={t('dev.empty')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection {...base} feeds={[]} />
        </div>
      </Group>
      <Group title={t('dev.creating')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection {...base} feeds={sample} initialMode={{ kind: 'creating' }} />
        </div>
      </Group>
      <Group title={t('dev.reveal')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection
            {...base}
            feeds={sample}
            initialMode={{ kind: 'created', created: created(sample[0] as IcalFeed) }}
          />
        </div>
      </Group>
      <Group title={t('dev.confirm')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection
            {...base}
            feeds={sample}
            initialMode={{ kind: 'confirming', id: sample[1]?.id ?? '', action: 'revoke' }}
          />
        </div>
      </Group>
      <Group title={t('dev.full')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection {...base} feeds={full} />
        </div>
      </Group>
      <Group title={t('dev.error')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection {...base} feeds={undefined} error={new Error('500')} />
        </div>
      </Group>
      <Group title={t('dev.offline')} className="block">
        <div className="max-w-pane-max">
          <CalendarFeedsSection {...base} feeds={sample} online={false} />
        </div>
      </Group>
      <Group title={t('dev.avatar')} className="flex-col items-start">
        <AvatarField
          uploaded={false}
          pending={null}
          error={null}
          online
          onUpload={noop}
          onRemove={noop}
        />
        <AvatarField uploaded pending={null} error={null} online onUpload={noop} onRemove={noop} />
        <AvatarField
          uploaded
          pending="upload"
          error={null}
          online
          onUpload={noop}
          onRemove={noop}
        />
        <AvatarField
          uploaded={false}
          pending={null}
          error="size"
          online
          onUpload={noop}
          onRemove={noop}
        />
        <AvatarField
          uploaded
          pending={null}
          error={null}
          online={false}
          onUpload={noop}
          onRemove={noop}
        />
      </Group>
    </Section>
  );
}

const noop = () => {};
