import type { GrantConstraints, GrantScope } from '@rooster/core/grants';
import { useTranslation } from 'react-i18next';
import type { GrantOrgOption } from './grant-model';
import { describeScopes, describeWhere } from './grant-summary';

export interface GrantSummaryProps {
  value: { scopes: readonly GrantScope[]; constraints: GrantConstraints };
  orgs: readonly GrantOrgOption[];
  locale: string;
}

/** The editor's live summary: capabilities, then where. Announced politely as it changes. */
export function GrantSummary({ value, orgs, locale }: GrantSummaryProps) {
  const { t } = useTranslation('settings');
  return (
    <div
      className="flex flex-col gap-1 rounded-md bg-bg-subtle px-3 py-2 text-sm"
      aria-live="polite"
      data-testid="grant-summary"
    >
      <p className="font-medium text-text">{t('access.editor.summary')}</p>
      {value.scopes.length > 0 && (
        <p className="text-text-secondary">{describeScopes(value.scopes, t, locale)}</p>
      )}
      <p className="text-text-secondary">{describeWhere(value, orgs, t, locale)}</p>
    </div>
  );
}
