import { isLocale } from '@rooster/i18n/core';
import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useGuide } from '../../features/help/guide-content';
import { guideSearchParams } from '../../features/help/guide-model';
import { useGuideSearch } from '../../features/help/guide-search-view';
import { GuideArticle, GuideNotFound, GuideStatus } from '../../features/help/guide-view';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';
import { paths } from '../../features/shell/paths';

/** One page of the user guide (ADR 0052 §2); an unknown slug says so in place. */
export const Route = createFileRoute('/_app/help/$slug')({
  validateSearch: guideSearchParams,
  component: HelpPageRoute,
});

function HelpPageRoute() {
  const { t, i18n } = useTranslation('help');
  const { slug } = Route.useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const guide = useGuide(locale);
  const page = guide.pages?.find((p) => p.slug === slug);
  const search = useGuideSearch(Route.useSearch().q);
  // The page list beside the article shows which page this is; a phone has no list.
  const pageTitle = page?.title ?? t('title');
  return (
    <>
      <ViewHeader
        title={t('title')}
        mobile={{ title: pageTitle, back: { href: paths.help, label: t('title') } }}
      />
      <ViewBody>
        {!guide.pages ? (
          <GuideStatus error={guide.error} onRetry={guide.retry} />
        ) : page ? (
          <GuideArticle
            page={page}
            pages={guide.pages}
            locale={locale}
            hash={hash || undefined}
            autoFocus
            search={search}
            onNavigate={(href) => void navigate({ href })}
          />
        ) : (
          <GuideNotFound />
        )}
      </ViewBody>
    </>
  );
}
