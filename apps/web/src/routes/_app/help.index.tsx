import { isLocale } from '@rooster/i18n/core';
import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useGuide } from '../../features/help/guide-content';
import { GuideIndex, GuideStatus } from '../../features/help/guide-view';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';

/** The user guide's page list (ADR 0052 §2), in the viewer's language. */
export const Route = createFileRoute('/_app/help/')({
  component: HelpIndexRoute,
});

function HelpIndexRoute() {
  const { t, i18n } = useTranslation('help');
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const guide = useGuide(locale);
  return (
    <>
      <ViewHeader title={t('title')} />
      <ViewBody>
        {guide.pages ? (
          <GuideIndex pages={guide.pages} />
        ) : (
          <GuideStatus error={guide.error} onRetry={guide.retry} />
        )}
      </ViewBody>
    </>
  );
}
