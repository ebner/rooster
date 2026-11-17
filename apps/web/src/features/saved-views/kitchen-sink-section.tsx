import { useTranslation } from 'react-i18next';
import { Section } from '../dev-ui/layout';

/** Phase 13 (ADR 0073 B): a view's header with its query chips, its rows by person, counts. */
export function SavedViewsKitchenSection() {
  const { t } = useTranslation('views');
  return (
    <Section id="savedViews" title={t('saved.title')}>
      {null}
    </Section>
  );
}
