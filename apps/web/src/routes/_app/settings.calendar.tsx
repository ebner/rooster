import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { errorCode, useDisplayPrefs, useMe } from '../../data';
import { useCreateIcalFeed, useIcalFeeds, useRevokeIcalFeed } from '../../data/ical-feeds';
import { useOnline } from '../../features/attachments/use-online';
import { CalendarFeedsSection, icalFeedsMax } from '../../features/settings/calendar-feeds';
import { toast } from '../../ui/toast';

/** Settings → Calendar feed (FR-CAL, WP 10.3). Online-only. */
export const Route = createFileRoute('/_app/settings/calendar')({
  component: CalendarRoute,
});

function CalendarRoute() {
  const { t } = useTranslation('calendar');
  const me = useMe();
  const feeds = useIcalFeeds();
  const create = useCreateIcalFeed();
  const revoke = useRevokeIcalFeed();
  const prefs = useDisplayPrefs();
  const online = useOnline();
  const failed = (error: unknown): never => {
    toast({
      message:
        errorCode(error) === 'too_many_ical_feeds'
          ? t('limit', { max: icalFeedsMax })
          : t('saveFailed'),
      tone: 'danger',
    });
    throw error;
  };
  return (
    <CalendarFeedsSection
      feeds={feeds.data}
      error={feeds.error}
      orgs={(me.data?.orgs ?? []).map((org) => ({ id: org.id, name: org.name }))}
      prefs={prefs}
      now={Date.now()}
      online={online}
      onCreate={(input) => create.mutateAsync(input).catch(failed)}
      onRevoke={(id) =>
        revoke
          .mutateAsync(id)
          .then(() => {
            toast({ message: t('revoked') });
          })
          .catch(failed)
      }
    />
  );
}
