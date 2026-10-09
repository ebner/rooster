import { ChevronRight } from 'lucide-react';
import { Link as AriaLink } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { paths } from '../shell/paths';
import { settingsSections } from './settings-layout';

/**
 * Settings on phones: the index you drill into, like a native settings app. Each section is a
 * full-width row (icon, name, what it holds, ›); the section opens with "‹ Settings" in the
 * header. Tablet and desktop keep the side menu instead.
 */
export function SettingsIndex() {
  const { t } = useTranslation('settings');
  return (
    <nav aria-label={t('nav.label')} className="-mx-3" data-testid="settings-index">
      <ul className="flex flex-col divide-y divide-border">
        {settingsSections.map(({ id, icon: Icon }) => (
          <li key={id}>
            <AriaLink
              href={paths.settings(id)}
              className={cn(
                'flex min-h-hit-touch cursor-default items-center gap-3 px-4 py-2 text-text',
                'transition-colors duration-(--dur-fast) ease-standard pressed:bg-bg-muted',
                '-outline-offset-2 outline-none focus-ring:outline-2 focus-ring:outline-border-focus',
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-muted text-text-secondary">
                <Icon className="size-5" strokeWidth={iconStrokeWidth} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-md">{t(`nav.${id}`)}</span>
                <span className="text-sm text-text-muted">{t(`nav.hint.${id}`)}</span>
              </span>
              <ChevronRight
                className="size-5 shrink-0 text-text-muted"
                strokeWidth={iconStrokeWidth}
                aria-hidden
              />
            </AriaLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
