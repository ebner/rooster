import { isLocale, type Locale, supportedLocales } from '@rooster/i18n';
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { setLocale } from '../../lib/i18n';

export interface LanguageSwitchProps {
  className?: string | undefined;
}

/** Segmented EN/Svenska switch. Language names are endonyms in both catalogs. */
export function LanguageSwitch({ className }: LanguageSwitchProps) {
  const { t, i18n } = useTranslation();
  const current: Locale = isLocale(i18n.language) ? i18n.language : 'en';
  return (
    <ToggleButtonGroup
      aria-label={t('language.label')}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[current]}
      onSelectionChange={(keys) => {
        const [next] = [...keys];
        if (isLocale(next)) void setLocale(next);
      }}
      className={cn('inline-flex gap-0.5 rounded-sm bg-bg-muted p-0.5', className)}
    >
      {supportedLocales.map((locale) => (
        <ToggleButton
          key={locale}
          id={locale}
          lang={locale}
          className={cn(
            'inline-flex h-control-sm cursor-default items-center rounded-xs px-3 text-sm font-medium text-text-secondary',
            'transition-colors duration-(--dur-fast) ease-standard hover:text-text',
            'data-selected:bg-bg-elevated data-selected:text-text data-selected:shadow-sm',
          )}
        >
          {t(`language.${locale}`)}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
