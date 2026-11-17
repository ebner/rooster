import { useTranslation } from 'react-i18next';
import { Section } from '../dev-ui/layout';

/** Phase 13 (ADR 0073 A): All organisations: rows with org chips, the draft's org chip. */
export function AllOrgsKitchenSection() {
  const { t } = useTranslation('views');
  return (
    <Section id="allOrgs" title={t('all.title')}>
      {null}
    </Section>
  );
}
