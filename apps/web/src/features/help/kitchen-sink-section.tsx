import { isLocale } from '@rooster/i18n/core';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayPrefs } from '../../lib/format';
import { SystemSection } from '../admin/system-section';
import { Group, Section } from '../dev-ui/layout';
import { StorageUsage } from '../settings/data-page';
import { fixtureGuidePages, fixtureSystem, fixtureSystemBare } from './fixtures';
import { GuideArticle, GuideIndex, GuideNotFound, GuideStatus } from './guide-view';

const noop = () => {};
const fakeReindex = () =>
  new Promise<{ indexed: number; durationMs: number }>((resolve) =>
    setTimeout(() => resolve({ indexed: 4208, durationMs: 184 }), 600),
  );
const gb = 1024 * 1024 * 1024;

/** Kitchen-sink slot for Phase 11 UI: the guide at /help and Admin → System (WP 11.5, 11.6). */
export function HelpKitchenSection() {
  const { t, i18n } = useTranslation('help');
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const other = locale === 'en' ? 'sv' : 'en';
  const prefs: DisplayPrefs = {
    locale,
    timezone: 'Europe/Stockholm',
    dateFormat: locale === 'sv' ? 'd MMM' : 'MMM d',
    timeFormat: '24h',
  };
  const now = useMemo(() => Date.now(), []);
  const pages = fixtureGuidePages.map((page) => ({ ...page, lang: locale }));
  const reminders = pages[2] ?? pages[0];
  const fallbackPage = pages[1] && { ...pages[1], lang: other };

  return (
    <Section id="help" title={t('dev.section')}>
      <Group title={t('dev.index')} className="block">
        <GuideIndex pages={pages} />
      </Group>
      {reminders && (
        <Group title={t('dev.article')} className="block">
          <GuideArticle page={reminders} pages={pages} locale={locale} onNavigate={noop} />
        </Group>
      )}
      {fallbackPage && (
        <Group title={t('dev.fallback')} className="block">
          <GuideArticle page={fallbackPage} pages={pages} locale={locale} onNavigate={noop} />
        </Group>
      )}
      <Group title={t('dev.notFound')} className="block">
        <GuideNotFound />
      </Group>
      <Group title={t('loading')} className="block">
        <GuideStatus error={null} onRetry={noop} />
      </Group>
      <Group title={t('loadFailed')} className="block">
        <GuideStatus error={new Error('offline')} onRetry={noop} />
      </Group>
      <Group title={t('dev.system')} className="block">
        <div className="max-w-pane-max">
          <SystemSection
            system={fixtureSystem(now)}
            error={null}
            onRefresh={noop}
            prefs={prefs}
            now={now}
            reindex={{ onRun: fakeReindex, online: true }}
          />
        </div>
      </Group>
      <Group title={t('dev.systemBare')} className="block">
        <div className="max-w-pane-max">
          <SystemSection
            system={fixtureSystemBare(now)}
            error={null}
            isRefreshing
            onRefresh={noop}
            prefs={prefs}
            now={now}
            reindex={{ onRun: fakeReindex, online: true, defaultConfirming: true }}
          />
        </div>
      </Group>
      <Group title={t('dev.systemLoading')} className="block">
        <div className="max-w-pane-max">
          <SystemSection system={undefined} error={null} onRefresh={noop} prefs={prefs} now={now} />
        </div>
      </Group>
      <Group title={t('dev.systemError')} className="block">
        <div className="max-w-pane-max">
          <SystemSection
            system={undefined}
            error={new Error('500')}
            onRefresh={noop}
            prefs={prefs}
            now={now}
          />
        </div>
      </Group>
      <Group title={t('dev.storage')}>
        <StorageUsage storage={{ usedBytes: 0.3 * gb, quotaBytes: gb }} locale={locale} />
        <StorageUsage storage={{ usedBytes: 0.95 * gb, quotaBytes: gb }} locale={locale} />
        <StorageUsage storage={{ usedBytes: gb, quotaBytes: gb }} locale={locale} />
      </Group>
      <Group title={t('dev.storageNoQuota')}>
        <StorageUsage
          storage={{ usedBytes: 312 * 1024 * 1024, quotaBytes: null }}
          locale={locale}
        />
      </Group>
    </Section>
  );
}
